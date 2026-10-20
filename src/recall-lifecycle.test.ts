import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "./index.js";
import type {
  OpenClawPluginApi,
  PluginHookAgentContext,
  PluginHookHandler,
  OpenClawPluginService,
} from "./types.js";

const emit = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  emitAgentEvent: emit,
}));

let sdk: typeof import("openclaw/plugin-sdk/agent-harness-runtime");
beforeAll(async () => {
  sdk = await vi.importActual<
    typeof import("openclaw/plugin-sdk/agent-harness-runtime")
  >("openclaw/plugin-sdk/agent-harness-runtime");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const memory = {
  results: [
    {
      id: "fixture",
      text: "A fixture observation",
      type: "observation" as const,
    },
  ],
};

describe("automatic recall service lifecycle", () => {
  let service: OpenClawPluginService;
  let hooks: Map<string, PluginHookHandler<"before_prompt_build">>;
  let directory: string;
  let api: OpenClawPluginApi;
  const ctx: PluginHookAgentContext = {
    runId: "test-run",
    agentId: "main",
    sessionKey: "agent:main:telegram:direct:test-user",
    messageProvider: "telegram",
    channelId: "test-user",
    senderId: "test-user",
  };
  const event = {
    prompt: "What was the project decision?",
    currentUserMessage: "What was the project decision?",
    messages: [],
  };
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "hindsight-recall-cancellation-"));
    hooks = new Map();
    emit.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              api_version: "0.10.0",
              features: { store_document_text: true },
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    api = {
      agent: { events: { emitAgentEvent: emit } },
      config: {},
      pluginConfig: {
        hindsightApiUrl: "http://localhost:8888",
        bankId: "test-bank",
        dynamicBankId: false,
        autoRecall: true,
        autoRetain: false,
        recallTimeoutMs: 1000,
        retainQueuePath: join(directory, "queue.jsonl"),
        logLevel: "error",
      },
      registerService: (registered) => {
        service = registered;
      },
      on: (name, handler) => {
        hooks.set(name, handler);
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    plugin.register!(api);
    await service.start();
  });
  afterEach(async () => {
    await service.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  });
  function run() {
    return hooks.get("before_prompt_build")!(event, ctx);
  }
  it("shares a recall within the running service", async () => {
    const response = deferred<typeof memory>();
    const started = deferred<void>();
    const recall = vi
      .spyOn(HindsightClient.prototype, "recall")
      .mockImplementation(() => {
        started.resolve();
        return response.promise as ReturnType<HindsightClient["recall"]>;
      });
    const first = run();
    await started.promise;
    const second = run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(recall).toHaveBeenCalledTimes(1);
    response.resolve(memory);
    expect(await first).toEqual(
      expect.objectContaining({
        prependContext: expect.stringContaining("A fixture observation"),
      }),
    );
    expect(await second).toEqual(await first);
    const progress = emit.mock.calls.map(([event]) => event);
    for (const emitted of progress) {
      expect(JSON.parse(JSON.stringify(emitted.data))).toStrictEqual(
        emitted.data,
      );
    }
    expect(progress.map((event) => event.data.state)).toEqual([
      "started",
      "started",
      "completed",
      "completed",
    ]);
    expect(new Set(progress.map((event) => event.data.recallId)).size).toBe(2);
    for (const started of progress.slice(0, 2)) {
      expect(
        progress.filter(
          (event) => event.data.recallId === started.data.recallId,
        ),
      ).toHaveLength(2);
    }
    expect(progress[2]).toEqual({
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      stream: "plugin:hindsight-memory",
      data: {
        kind: "hindsight-memory.recall",
        pluginId: "hindsight-memory",
        recallId: expect.any(String),
        sessionKey: ctx.sessionKey,
        state: "completed",
        resultCount: 1,
        durationMs: expect.any(Number),
      },
    });
  });
  it("suppresses a late transport success after stop", async () => {
    const response = deferred<typeof memory>();
    const started = deferred<void>();
    let signal: AbortSignal | undefined;
    vi.spyOn(HindsightClient.prototype, "recall").mockImplementation(
      (_bank, _query, options) => {
        signal = options?.signal;
        started.resolve();
        return response.promise as ReturnType<HindsightClient["recall"]>;
      },
    );
    const pending = run();
    await started.promise;
    await service.stop();
    response.resolve(memory);
    expect(await pending).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(emit.mock.calls.map(([event]) => event.data.state)).toEqual([
      "started",
      "cancelled",
    ]);
    expect(emit.mock.calls[1][0].data.reason).toBe("service_stopped");
  });
  it.each([false, true])(
    "does not reuse or evict a successor recall (stop first: %s)",
    async (stopFirst) => {
      const old = deferred<typeof memory>();
      const fresh = deferred<typeof memory>();
      const started = deferred<void>();
      const recall = vi
        .spyOn(HindsightClient.prototype, "recall")
        .mockImplementationOnce(() => {
          started.resolve();
          return old.promise as ReturnType<HindsightClient["recall"]>;
        })
        .mockImplementation(
          () => fresh.promise as ReturnType<HindsightClient["recall"]>,
        );
      const previous = run();
      await started.promise;
      if (stopFirst) await service.stop();
      await service.start();
      const successor = run();
      await new Promise<void>((resolve) => setImmediate(resolve));
      old.resolve(memory);
      expect(await previous).toBeUndefined();
      const duplicate = run();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(recall).toHaveBeenCalledTimes(2);
      fresh.resolve(memory);
      expect(await successor).toEqual(
        expect.objectContaining({ prependContext: expect.any(String) }),
      );
      expect(await duplicate).toEqual(await successor);
    },
  );
  it("does not send if stopped while waiting for initialization", async () => {
    const ready = deferred<void>();
    const globalClient = (
      globalThis as unknown as {
        __hindsightClient: { waitForReady(): Promise<void> };
      }
    ).__hindsightClient;
    vi.spyOn(globalClient, "waitForReady").mockReturnValue(ready.promise);
    const recall = vi
      .spyOn(HindsightClient.prototype, "recall")
      .mockResolvedValue(memory as never);
    const pending = run();
    await service.stop();
    expect(emit.mock.calls.map(([event]) => event.data.state)).toEqual([
      "started",
      "cancelled",
    ]);
    ready.resolve();
    expect(await pending).toBeUndefined();
    expect(recall).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(2);
  });
  it("reports zero results as successful completion", async () => {
    vi.spyOn(HindsightClient.prototype, "recall").mockResolvedValue({
      results: [],
    } as never);
    expect(await run()).toBeUndefined();
    expect(emit.mock.calls.map(([event]) => event.data.state)).toEqual([
      "started",
      "completed",
    ]);
    expect(emit.mock.calls[1][0].data.resultCount).toBe(0);
  });
  it("does not start progress for an empty query", async () => {
    expect(
      await hooks.get("before_prompt_build")!(
        { currentUserMessage: "", messages: [] },
        ctx,
      ),
    ).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });
  it.each([
    [new DOMException("private query", "TimeoutError"), "timeout"],
    [new Error("private query"), "error"],
  ])("reports safe failure codes (%s)", async (error, reason) => {
    vi.spyOn(HindsightClient.prototype, "recall").mockRejectedValue(error);
    expect(await run()).toBeUndefined();
    expect(emit.mock.calls.map(([event]) => event.data.state)).toEqual([
      "started",
      "failed",
    ]);
    expect(emit.mock.calls[1][0].data.reason).toBe(reason);
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private query");
  });
  it("reports an unavailable client without pretending recall succeeded", async () => {
    const globalClient = (
      globalThis as unknown as {
        __hindsightClient: { getClientForContext(): Promise<unknown> };
      }
    ).__hindsightClient;
    vi.spyOn(globalClient, "getClientForContext").mockResolvedValue(null);
    expect(await run()).toBeUndefined();
    expect(emit.mock.calls.map(([event]) => event.data.state)).toEqual([
      "started",
      "skipped",
    ]);
    expect(emit.mock.calls[1][0].data.reason).toBe("client_unavailable");
  });
  it("emits JSON-compatible data without a session key", async () => {
    vi.spyOn(HindsightClient.prototype, "recall").mockResolvedValue(
      memory as never,
    );
    expect(
      await hooks.get("before_prompt_build")!(event, {
        ...ctx,
        sessionKey: undefined,
      }),
    ).toEqual(expect.objectContaining({ prependContext: expect.any(String) }));
    expect(emit).toHaveBeenCalledTimes(2);
    for (const [emitted] of emit.mock.calls) {
      expect(emitted.data).not.toHaveProperty("sessionKey");
      expect(JSON.parse(JSON.stringify(emitted.data))).toStrictEqual(
        emitted.data,
      );
    }
  });
  it("clamps duration when the system clock moves backwards", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(2000);
    vi.spyOn(HindsightClient.prototype, "recall").mockImplementation(
      async () => {
        clock.mockReturnValue(1000);
        return memory as never;
      },
    );
    await run();
    expect(emit.mock.calls[1][0].data.durationMs).toBe(0);
  });
  it("uses the host SDK when the scoped API disables global side effects", async () => {
    const received: string[] = [];
    const unsubscribe = sdk.onAgentEvent((event) => {
      if (
        event.runId === ctx.runId &&
        event.stream === "plugin:hindsight-memory"
      )
        received.push(String(event.data.state));
    });
    emit.mockImplementation(sdk.emitAgentEvent);
    const scopedEmit = vi.fn(() => ({
      emitted: false,
      reason: "global side effects disabled",
    }));
    api.agent = { events: { emitAgentEvent: scopedEmit } };
    vi.spyOn(HindsightClient.prototype, "recall").mockResolvedValue(
      memory as never,
    );
    try {
      await run();
    } finally {
      unsubscribe();
    }
    expect(scopedEmit).not.toHaveBeenCalled();
    expect(received).toEqual(["started", "completed"]);
  });
  it("does not emit after the host expires the hook invocation", async () => {
    vi.spyOn(HindsightClient.prototype, "recall").mockResolvedValue(
      memory as never,
    );
    await hooks.get("before_prompt_build")!(event, {
      ...ctx,
      hookInvocation: {
        assertActive() {
          throw new Error("expired");
        },
      },
    });
    expect(emit).not.toHaveBeenCalled();
  });
  it.each([
    "absent-registration-api",
    "throws",
    "rejects",
    "pending",
    "no-run-id",
  ])("preserves recall when event emission is %s", async (mode) => {
    vi.spyOn(HindsightClient.prototype, "recall").mockResolvedValue(
      memory as never,
    );
    if (mode === "absent-registration-api") delete api.agent;
    if (mode === "throws") {
      emit.mockImplementation(() => {
        throw new Error("subscriber");
      });
    }
    if (mode === "rejects") emit.mockRejectedValue(new Error("subscriber"));
    if (mode === "pending") emit.mockReturnValue(new Promise(() => {}));
    const result = await hooks.get("before_prompt_build")!(
      event,
      mode === "no-run-id" ? { ...ctx, runId: undefined } : ctx,
    );
    expect(result).toEqual(
      expect.objectContaining({
        prependContext: expect.stringContaining("A fixture observation"),
      }),
    );
    if (mode === "no-run-id") expect(emit).not.toHaveBeenCalled();
    if (mode === "absent-registration-api")
      expect(emit).toHaveBeenCalledTimes(2);
  });

  it("skips recall when inputProvenance indicates an inter-session or subagent event", async () => {
    const recall = vi.spyOn(HindsightClient.prototype, "recall");
    const result = await hooks.get("before_prompt_build")!(event, {
      ...ctx,
      inputProvenance: {
        kind: "inter_session",
        sourceChannel: "internal",
        sourceTool: "subagent_settle",
      },
    });
    expect(result).toBeUndefined();
    expect(recall).not.toHaveBeenCalled();
  });

  it("skips recall when prompt is a subagent completion event even without inputProvenance", async () => {
    const recall = vi.spyOn(HindsightClient.prototype, "recall");
    const subagentEvent = {
      currentUserMessage: undefined,
      prompt: [
        "[Subagent Context] Every subagent in this batch has now settled, including its descendants.",
        "Child completion results:",
        "1. Child task: research crypto news",
      ].join("\n"),
      messages: [],
    };
    const result = await hooks.get("before_prompt_build")!(subagentEvent, ctx);
    expect(result).toBeUndefined();
    expect(recall).not.toHaveBeenCalled();
  });

  it("skips recall and progress emission on post-compaction continuation retry prompt", async () => {
    const recall = vi.spyOn(HindsightClient.prototype, "recall");
    const continuationEvent = {
      currentUserMessage:
        "Continue the current task from the existing transcript, preserving completed work. Do not repeat status text that was already sent to the user.",
      prompt:
        "Continue the current task from the existing transcript, preserving completed work. Do not repeat status text that was already sent to the user.",
      messages: [],
    };
    const result = await hooks.get("before_prompt_build")!(
      continuationEvent,
      ctx,
    );
    expect(result).toBeUndefined();
    expect(recall).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("reuses completed recall result across sequential retry attempts with the same runId without calling recall again", async () => {
    const recall = vi
      .spyOn(HindsightClient.prototype, "recall")
      .mockResolvedValue(memory as never);

    const firstAttempt = await run();
    expect(firstAttempt).toEqual(
      expect.objectContaining({
        prependContext: expect.stringContaining("A fixture observation"),
      }),
    );
    expect(recall).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(2);

    // Simulate Attempt 2 of the same runId (e.g., preflight context overflow retry)
    const secondAttempt = await run();
    expect(secondAttempt).toEqual(firstAttempt);
    expect(recall).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("caches empty recall results for the same run key, isolates distinct run/bank keys, and clears cache on service restart", async () => {
    const recall = vi
      .spyOn(HindsightClient.prototype, "recall")
      .mockResolvedValue({ results: [] } as never);

    // 1. Cached empty result (undefined) is reused for the same run/bank key
    const firstEmpty = await run();
    expect(firstEmpty).toBeUndefined();
    expect(recall).toHaveBeenCalledTimes(1);

    const secondEmpty = await run();
    expect(secondEmpty).toBeUndefined();
    expect(recall).toHaveBeenCalledTimes(1);

    // 2. Separate runId triggers a fresh recall
    recall.mockResolvedValueOnce(memory as never);
    const otherRunResult = await hooks.get("before_prompt_build")!(event, {
      ...ctx,
      runId: "other-run",
    });
    expect(otherRunResult).toEqual(
      expect.objectContaining({
        prependContext: expect.stringContaining("A fixture observation"),
      }),
    );
    expect(recall).toHaveBeenCalledTimes(2);

    // 3. Service restart clears the completed recall cache
    await service.stop();
    await service.start();
    recall.mockResolvedValueOnce(memory as never);
    const afterRestartResult = await run();
    expect(afterRestartResult).toEqual(
      expect.objectContaining({
        prependContext: expect.stringContaining("A fixture observation"),
      }),
    );
    expect(recall).toHaveBeenCalledTimes(3);
  });
});

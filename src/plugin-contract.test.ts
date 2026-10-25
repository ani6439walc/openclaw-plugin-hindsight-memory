import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetainQueue } from "./retain-queue.js";
import type {
  OpenClawPluginApi,
  PluginConfig,
  PluginHookAgentContext,
  PluginHookHandler,
  PluginHookSessionContext,
} from "./types.js";

type Service = { start(): Promise<void>; stop(): Promise<void> };
type HookName =
  "before_dispatch" | "before_prompt_build" | "agent_end" | "session_end";
type PromptEvent = Parameters<PluginHookHandler<"before_prompt_build">>[0];
type SessionEndEvent = Parameters<PluginHookHandler<"session_end">>[0];
type EndedTranscript = NonNullable<PluginHookSessionContext["endedTranscript"]>;
type TranscriptReader = Extract<EndedTranscript, { available: true }>;

const messages = [
  { role: "user", content: "Remember that the project launch is on Friday." },
  { role: "assistant", content: "I will remember the Friday launch date." },
];
const agentContext: PluginHookAgentContext = {
  agentId: "main",
  sessionKey: "agent:main:telegram:direct:contract-user",
  messageProvider: "telegram",
  channelId: "contract-user",
  senderId: "contract-user",
};
const sessionContext: PluginHookSessionContext = {
  agentId: "main",
  sessionId: "contract-session",
  sessionKey: agentContext.sessionKey,
};
const sessionEvent: SessionEndEvent = {
  sessionId: sessionContext.sessionId,
  sessionKey: sessionContext.sessionKey,
  messageCount: messages.length,
  reason: "reset",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("official OpenClaw plugin contracts", () => {
  let directory: string;
  let services: Service[];

  beforeEach(() => {
    vi.resetModules();
    directory = mkdtempSync(join(tmpdir(), "hindsight-plugin-contract-"));
    services = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "ok",
              api_version: "0.10.0",
              features: { store_document_text: true },
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
  });

  afterEach(async () => {
    for (const service of services) await service.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  });

  async function register(config: PluginConfig = {}) {
    const module = await import("./index.js");
    const hooks = new Map<string, unknown>();
    const queuePath = join(directory, "queue.jsonl");
    let service!: Service;
    const api: Partial<OpenClawPluginApi> = {
      config: {},
      pluginConfig: {
        hindsightApiUrl: "https://hindsight.test",
        dynamicBankId: false,
        bankId: "contract-bank",
        scope: { skipRecallSessions: ["**"] },
        retainEveryNTurns: 3,
        retainQueuePath: queuePath,
        logLevel: "off",
        ...config,
      },
      registerService(registered) {
        if (registered.apiVersion === 2) {
          throw new Error(
            "This fixture expects the plugin's version 1 service",
          );
        }
        const context = {
          config: {},
          stateDir: directory,
          logger: { info() {}, warn() {}, error() {} },
        };
        service = {
          async start() {
            await registered.start(context);
          },
          async stop() {
            await registered.stop?.(context);
          },
        };
        services.push(service);
      },
      on(name, handler) {
        hooks.set(name, handler);
      },
      logger: { info() {}, warn() {}, error() {} },
    };
    module.default.register(api as OpenClawPluginApi);
    return {
      ...module,
      api,
      service,
      queuePath,
      hook<K extends HookName>(name: K): PluginHookHandler<K> {
        const handler = hooks.get(name);
        if (!handler) throw new Error(`hook ${name} was not registered`);
        return handler as PluginHookHandler<K>;
      },
      queued() {
        const queue = new RetainQueue({ filePath: queuePath });
        return queue.peek();
      },
    };
  }

  it("exports a canonical plugin entry with matching package metadata", async () => {
    const { default: plugin } = await register();
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(plugin).toEqual(
      expect.objectContaining({
        id: pkg.name,
        name: pkg.displayName,
        description: expect.stringMatching(/\S/),
        register: expect.any(Function),
        configSchema: expect.any(Object),
      }),
    );
  });

  it("uses the host-resolved pluginConfig rather than raw root configuration", async () => {
    const { api, getPluginConfig } = await register();
    api.config = {
      plugins: {
        entries: {
          "hindsight-memory": {
            config: { bankId: "unresolved-root-bank", scope: {} },
          },
        },
      },
    };
    expect(getPluginConfig(api as OpenClawPluginApi)).toMatchObject({
      bankId: "contract-bank",
      scope: { skipRecallSessions: ["**"] },
    });
    api.pluginConfig = undefined;
    expect(getPluginConfig(api as OpenClawPluginApi).bankId).not.toBe(
      "unresolved-root-bank",
    );
  });

  it.each(["discord", undefined, ""])(
    "recalls the same channel bank after dispatch (event.channel: %j)",
    async (channel) => {
      const fixture = await register({
        scope: { skipRetainSessions: ["**"] },
        dynamicBankId: true,
        dynamicBankGranularity: ["provider", "channel"],
      });
      await fixture.service.start();
      const recall = vi
        .spyOn(HindsightClient.prototype, "recall")
        .mockResolvedValue({ results: [] });
      const room = "1533386280426147982";
      const sessionKey = `agent:main:discord:channel:${room}`;
      await fixture.hook("before_dispatch")(
        { content: "What is the project launch date?", channel, sessionKey },
        {
          sessionKey,
          // Official dispatch contexts use a provider here; also exercise the
          // reviewer's conversation-id payload when event.channel is missing.
          channelId: channel ? "discord" : room,
          conversationId: room,
          senderId: "contract-user",
        },
      );
      await fixture.hook("before_prompt_build")(
        { prompt: "What is the project launch date?", messages: [] },
        { sessionKey },
      );
      expect(recall).toHaveBeenCalledOnce();
      expect(recall.mock.calls[0][0]).toBe(`discord::channel%3A${room}`);
      expect(
        fixture.resolveAndCacheIdentity({ sessionKey }).resolvedCtx,
      ).toMatchObject({
        messageProvider: "discord",
        channelId: `channel:${room}`,
        senderId: "contract-user",
      });
    },
  );

  it("infers a Telegram direct sender without leaking dispatch channelId into identity", async () => {
    const fixture = await register({
      scope: { skipRetainSessions: ["**"] },
      dynamicBankId: true,
      dynamicBankGranularity: ["provider", "channel", "user"],
    });
    await fixture.service.start();
    const recall = vi
      .spyOn(HindsightClient.prototype, "recall")
      .mockResolvedValue({ results: [] });
    const sessionKey = "agent:main:telegram:direct:123";
    await fixture.hook("before_dispatch")(
      { content: "What is the project launch date?", channel: "telegram" },
      { sessionKey, channelId: "telegram", conversationId: "123" },
    );
    await fixture.hook("before_prompt_build")(
      { prompt: "What is the project launch date?", messages: [] },
      { sessionKey },
    );
    expect(recall).toHaveBeenCalledOnce();
    expect(recall.mock.calls[0][0]).toBe("telegram::direct%3A123::123");
  });

  it("still skips recall when an explicit dispatch provider disagrees with the session", async () => {
    const fixture = await register({
      scope: { skipRetainSessions: ["**"] },
      dynamicBankId: true,
      dynamicBankGranularity: ["provider", "channel"],
    });
    await fixture.service.start();
    const recall = vi.spyOn(HindsightClient.prototype, "recall");
    const sessionKey = "agent:main:discord:channel:contract-room";
    await fixture.hook("before_dispatch")(
      { content: "What is the project launch date?", channel: "webchat" },
      { sessionKey, channelId: "webchat", senderId: "contract-user" },
    );
    await fixture.hook("before_prompt_build")(
      { prompt: "What is the project launch date?", messages: [] },
      { sessionKey, messageProvider: "discord", senderId: "contract-user" },
    );
    expect(recall).not.toHaveBeenCalled();
  });

  it.each(["agent:main:main", "agent:main:dashboard:contract-session"])(
    "defers ambiguous dispatch identity until the prompt hook (%s)",
    async (sessionKey) => {
      const fixture = await register({
        scope: { skipRetainSessions: ["**"] },
        dynamicBankId: true,
        dynamicBankGranularity: ["agent", "provider", "channel"],
      });
      await fixture.service.start();
      const recall = vi
        .spyOn(HindsightClient.prototype, "recall")
        .mockResolvedValue({ results: [] });
      await fixture.hook("before_dispatch")(
        { content: "What is the project launch date?", sessionKey },
        { sessionKey, channelId: "1533386280426147982" },
      );
      await fixture.hook("before_prompt_build")(
        { prompt: "What is the project launch date?", messages: [] },
        {
          sessionKey,
          messageProvider: "discord",
          channelId: "contract-room",
          senderId: "contract-user",
        },
      );
      expect(recall).toHaveBeenCalledOnce();
      expect(recall.mock.calls[0][0]).toBe("main::discord::contract-room");
    },
  );

  it("treats an explicitly empty currentUserMessage as a non-text request", async () => {
    const fixture = await register({ scope: { skipRetainSessions: ["**"] } });
    await fixture.service.start();
    const recall = vi.spyOn(HindsightClient.prototype, "recall");
    const event: PromptEvent & { rawMessage: string } = {
      currentUserMessage: "",
      prompt: "An image annotation and reconstructed conversation history.",
      rawMessage: "An obsolete adapter field must not become a request.",
      messages,
    };
    expect(
      await fixture.hook("before_prompt_build")(event, agentContext),
    ).toBeUndefined();
    expect(recall).not.toHaveBeenCalled();
  });

  it("recalls the current user text instead of prompt history or adapter fields", async () => {
    const fixture = await register({ scope: { skipRetainSessions: ["**"] } });
    await fixture.service.start();
    const recall = vi
      .spyOn(HindsightClient.prototype, "recall")
      .mockResolvedValue({ results: [] });
    const event: PromptEvent & { rawMessage: string } = {
      currentUserMessage: "What date did we choose for the launch?",
      prompt:
        "Injected runtime annotations and a different historical request.",
      rawMessage: "Obsolete raw adapter content.",
      messages,
    };
    await fixture.hook("before_prompt_build")(event, agentContext);
    expect(recall).toHaveBeenCalledOnce();
    expect(recall.mock.calls[0].slice(0, 2)).toEqual([
      "contract-bank",
      event.currentUserMessage,
    ]);
  });

  it("falls back to the prompt only when currentUserMessage is omitted", async () => {
    const fixture = await register({ scope: { skipRetainSessions: ["**"] } });
    await fixture.service.start();
    const recall = vi
      .spyOn(HindsightClient.prototype, "recall")
      .mockResolvedValue({ results: [] });
    const event: PromptEvent = {
      prompt: "What date did we choose for the project launch?",
      messages: [],
    };
    await fixture.hook("before_prompt_build")(event, agentContext);
    expect(recall.mock.calls[0].slice(0, 2)).toEqual([
      "contract-bank",
      event.prompt,
    ]);
  });

  async function pendingTail() {
    const fixture = await register();
    await fixture.hook("agent_end")({ success: true, messages }, agentContext);
    expect(fixture.queued()).toHaveLength(0);
    return fixture;
  }

  it("flushes a transcript reader's tail without requiring a JSONL file", async () => {
    const fixture = await pendingTail();
    const readTail = vi.fn<TranscriptReader["readTail"]>().mockResolvedValue({
      messages,
      totalMessages: messages.length,
      truncated: false,
    });
    await fixture.hook("session_end")(sessionEvent, {
      ...sessionContext,
      endedTranscript: { available: true, readTail },
    });
    expect(readTail).toHaveBeenCalledOnce();
    expect(readTail).toHaveBeenCalledWith({
      maxMessages: 1000,
      maxBytes: 2 * 1024 * 1024,
    });
    expect(fixture.queued()).toEqual([
      expect.objectContaining({
        bankId: "contract-bank",
        content: expect.stringContaining("project launch is on Friday"),
      }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { available: false, reason: "conversation-access-required" },
    { available: false, reason: "no-stable-cutoff" },
    { available: false, reason: "incognito-deleted" },
  ] satisfies Array<EndedTranscript | undefined>)(
    "respects an unavailable reader (%j) without reading event or file messages",
    async (endedTranscript) => {
      const fixture = await pendingTail();
      const sessionFile = join(directory, "legacy.jsonl");
      writeFileSync(
        sessionFile,
        [
          { type: "session", id: sessionEvent.sessionId },
          ...messages.map((message) => ({ type: "message", message })),
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
      );
      const event = { ...sessionEvent, sessionFile, messages };
      await fixture.hook("session_end")(event, {
        ...sessionContext,
        endedTranscript,
      });
      expect(fixture.queued()).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not enqueue when the host transcript reader rejects", async () => {
    const fixture = await pendingTail();
    const readTail = vi
      .fn<TranscriptReader["readTail"]>()
      .mockRejectedValue(new Error("archive became unavailable"));
    await expect(
      fixture.hook("session_end")(sessionEvent, {
        ...sessionContext,
        endedTranscript: { available: true, readTail },
      }),
    ).resolves.toBeUndefined();
    expect(readTail).toHaveBeenCalledOnce();
    expect(fixture.queued()).toHaveLength(0);
  });

  it.each([true, false])(
    "keeps an ended session's deferred tail separate from its successor (session ids: %s)",
    async (hasAgentSessionIds) => {
      const fixture = await register();
      const oldContext: PluginHookAgentContext = {
        ...agentContext,
        ...(hasAgentSessionIds ? { sessionId: "old" } : {}),
      };
      const newContext: PluginHookAgentContext = {
        ...agentContext,
        ...(hasAgentSessionIds ? { sessionId: "new" } : {}),
      };
      const oldMessages = [
        { role: "user", content: "The old project launch is on Friday." },
        { role: "assistant", content: "The old launch date is Friday." },
        { role: "user", content: "The old project has a blue logo." },
        { role: "assistant", content: "The old logo color is blue." },
      ];
      const newMessages = [
        { role: "user", content: "The successor project launch is on Monday." },
        { role: "assistant", content: "The successor launch is on Monday." },
        { role: "user", content: "The successor project has a green logo." },
        { role: "assistant", content: "The successor logo color is green." },
        { role: "user", content: "The successor project owner is Alice." },
        { role: "assistant", content: "Alice owns the successor project." },
      ];
      const agentEnd = fixture.hook("agent_end");
      await agentEnd(
        { success: true, messages: oldMessages.slice(0, 2) },
        oldContext,
      );
      await agentEnd({ success: true, messages: oldMessages }, oldContext);

      const result =
        deferred<Awaited<ReturnType<TranscriptReader["readTail"]>>>();
      const entered = deferred<void>();
      const readTail = vi
        .fn<TranscriptReader["readTail"]>()
        .mockImplementation(() => {
          entered.resolve();
          return result.promise;
        });
      const ending = fixture.hook("session_end")(
        { ...sessionEvent, sessionId: "old", messageCount: oldMessages.length },
        {
          ...sessionContext,
          sessionId: "old",
          endedTranscript: { available: true, readTail },
        },
      );
      await entered.promise;
      await agentEnd(
        { success: true, messages: newMessages.slice(0, 2) },
        newContext,
      );
      // Re-emitting the old end event must not claim the successor's fallback
      // counter while the first read is still pending.
      await fixture.hook("session_end")(
        { ...sessionEvent, sessionId: "old" },
        {
          ...sessionContext,
          sessionId: "old",
          endedTranscript: { available: true, readTail },
        },
      );
      expect(readTail).toHaveBeenCalledOnce();
      expect(fixture.queued()).toHaveLength(0);

      result.resolve({
        messages: oldMessages,
        totalMessages: oldMessages.length,
        truncated: false,
      });
      await ending;
      expect(fixture.queued()).toHaveLength(1);
      expect(fixture.queued()[0].content).toContain("old project launch");
      expect(fixture.queued()[0].content).toContain(
        "old project has a blue logo",
      );
      expect(fixture.queued()[0].content).not.toContain("successor");

      await agentEnd(
        { success: true, messages: newMessages.slice(0, 4) },
        newContext,
      );
      expect(fixture.queued()).toHaveLength(1);
      await agentEnd({ success: true, messages: newMessages }, newContext);
      const queued = fixture.queued();
      expect(queued).toHaveLength(2);
      expect(queued[1].content).toContain("successor project launch");
      expect(queued[1].content).toContain("successor project has a green logo");
      expect(queued[1].content).toContain("successor project owner is Alice");
      expect(queued[1].content).not.toContain("old project");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([0, 3])(
    "does not let a repeated end claim successor cadence after %i completed old turns",
    async (oldTurns) => {
      const fixture = await register();
      const agentEnd = fixture.hook("agent_end");
      for (let turn = 0; turn < oldTurns; turn++) {
        await agentEnd({ success: true, messages }, agentContext);
      }
      const priorCount = fixture.queued().length;
      const readTail = vi.fn<TranscriptReader["readTail"]>().mockResolvedValue({
        messages,
        totalMessages: messages.length,
        truncated: false,
      });
      const endContext: PluginHookSessionContext = {
        ...sessionContext,
        endedTranscript: { available: true, readTail },
      };
      await fixture.hook("session_end")(sessionEvent, endContext);
      await agentEnd({ success: true, messages }, agentContext);
      await fixture.hook("session_end")(sessionEvent, endContext);
      expect(readTail).not.toHaveBeenCalled();
      expect(fixture.queued()).toHaveLength(priorCount);
      await agentEnd({ success: true, messages }, agentContext);
      expect(fixture.queued()).toHaveLength(priorCount);
      await agentEnd({ success: true, messages }, agentContext);
      expect(fixture.queued()).toHaveLength(priorCount + 1);
    },
  );

  it("does not enqueue a reader result after its service lifecycle ended", async () => {
    const fixture = await pendingTail();
    const result =
      deferred<Awaited<ReturnType<TranscriptReader["readTail"]>>>();
    const entered = deferred<void>();
    const readTail = vi
      .fn<TranscriptReader["readTail"]>()
      .mockImplementation(() => {
        entered.resolve();
        return result.promise;
      });
    const ending = fixture.hook("session_end")(sessionEvent, {
      ...sessionContext,
      endedTranscript: { available: true, readTail },
    });
    await entered.promise;
    await fixture.service.stop();
    result.resolve({
      messages,
      totalMessages: messages.length,
      truncated: false,
    });
    await ending;
    expect(fixture.queued()).toHaveLength(0);
  });
});

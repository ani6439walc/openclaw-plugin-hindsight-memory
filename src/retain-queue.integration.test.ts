import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RetainQueue } from "./retain-queue.js";
import registerPlugin, {
  type AsyncRetainOperationIdCapability,
} from "./index.js";
import type {
  OpenClawPluginApi,
  PluginHookAgentContext,
  PluginHookHandler,
  PluginHookSessionContext,
  OpenClawPluginService,
} from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeApi(
  queuePath: string,
  flushIntervalMs: number,
  extraConfig: Record<string, unknown> = {},
): {
  api: OpenClawPluginApi;
  service: () => OpenClawPluginService;
  agentEnd: () => PluginHookHandler<"agent_end">;
  sessionEnd: () => PluginHookHandler<"session_end">;
} {
  let registeredService: OpenClawPluginService | undefined;
  let agentEndHandler: PluginHookHandler<"agent_end"> | undefined;
  let sessionEndHandler: PluginHookHandler<"session_end"> | undefined;
  const api: OpenClawPluginApi = {
    config: {},
    pluginConfig: {
      hindsightApiUrl: "https://hindsight.test",
      retainQueuePath: queuePath,
      retainQueueFlushIntervalMs: flushIntervalMs,
      dynamicBankId: false,
      bankId: "integration-bank",
      scope: { skipRecallSessions: ["**"] },
      logLevel: "off",
      ...extraConfig,
    },
    registerService(config) {
      registeredService = config;
    },
    on(event, handler) {
      if (event === "agent_end")
        agentEndHandler = handler as PluginHookHandler<"agent_end">;
      if (event === "session_end")
        sessionEndHandler = handler as PluginHookHandler<"session_end">;
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
  registerPlugin.register!(api);
  return {
    api,
    service: () => {
      if (!registeredService) throw new Error("service not registered");
      return registeredService;
    },
    agentEnd: () => {
      if (!agentEndHandler) throw new Error("agent_end not registered");
      return agentEndHandler;
    },
    sessionEnd: () => {
      if (!sessionEndHandler) throw new Error("session_end not registered");
      return sessionEndHandler;
    },
  };
}
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface FakeServer {
  /** Bodies of every retain POST that reached the server. */
  retainBodies: Array<Record<string, unknown>>;
  /** URLs of those same POSTs — the bank id is in the path, so this is the routing. */
  retainUrls: string[];
  /** How many `/version` probes have been answered (or refused). */
  versionRequests: () => number;
  /** "unknown" makes the probe throw, mimicking an unreachable /version. */
  setCapability: (next: AsyncRetainOperationIdCapability) => void;
  /** Make the next N retain POSTs fail after the server has seen the body. */
  failRetains: (count: number) => void;
  /** Hold the next probe open; resolves once the handler has been entered. */
  deferNextVersion: () => Promise<void>;
  releaseDeferredVersion: () => void;
}

function installFakeServer(
  initial: AsyncRetainOperationIdCapability,
): FakeServer {
  let capability = initial;
  let versionRequests = 0;
  let retainFailures = 0;
  let deferNext = false;
  let resolveDeferred: ((response: Response) => void) | undefined;
  let notifyDeferredStarted: (() => void) | undefined;
  const retainBodies: Array<Record<string, unknown>> = [];
  const retainUrls: string[] = [];

  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (request.url.endsWith("/version")) {
        versionRequests++;
        if (deferNext) {
          deferNext = false;
          notifyDeferredStarted?.();
          return await new Promise<Response>((resolve) => {
            resolveDeferred = resolve;
          });
        }
        if (capability === "unknown")
          throw new Error("version probe unavailable");
        return new Response(
          JSON.stringify({
            api_version: capability === "supported" ? "0.8.6" : "0.8.5",
            features: { store_document_text: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (request.method === "POST" && request.url.includes("/memories")) {
        const body = JSON.parse(await request.clone().text()) as Record<
          string,
          unknown
        >;
        retainBodies.push(body);
        retainUrls.push(request.url);
        // Record the body first: a lost acknowledgement is a request the server
        // *did* process, which is the case operation_id has to cover.
        if (retainFailures > 0) {
          retainFailures--;
          throw new Error("connection reset before acknowledgement");
        }
        return new Response(
          JSON.stringify({
            success: true,
            bank_id: "integration-bank",
            items_count: 1,
            async: true,
            operation_id: body.operation_id,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  return {
    retainBodies,
    retainUrls,
    versionRequests: () => versionRequests,
    setCapability: (next) => {
      capability = next;
    },
    failRetains: (count) => {
      retainFailures = count;
    },
    deferNextVersion: () => {
      deferNext = true;
      return new Promise<void>((resolve) => {
        notifyDeferredStarted = resolve;
      });
    },
    releaseDeferredVersion: () => {
      resolveDeferred?.(
        new Response(
          JSON.stringify({
            api_version: "0.8.6",
            features: { store_document_text: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  };
}

function conversation(text: string, session: string) {
  return {
    event: {
      success: true,
      messages: [
        { role: "user", content: text },
        { role: "assistant", content: "Noted." },
      ],
    },
    ctx: {
      agentId: "main",
      sessionKey: `agent:main:discord:direct:${session}`,
      messageProvider: "discord",
      channelId: `direct:${session}`,
      senderId: "user:integration",
    } as PluginHookAgentContext,
  };
}

function makeQueuePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hindsight-retain-integration-"));
  tempDirs.push(dir);
  return join(dir, "retains.jsonl");
}

function readQueue(queuePath: string): Array<{ operationId?: string }> {
  return new RetainQueue({ filePath: queuePath }).peek();
}

describe("retain queue idempotent replay", () => {
  it("replays a lost acknowledgement under the id the first attempt already carried", async () => {
    vi.useFakeTimers();
    const queuePath = makeQueuePath();
    const server = installFakeServer("supported");

    const first = makeApi(queuePath, 1_000);
    const firstService = first.service();
    await firstService.start();

    server.failRetains(1);
    const { event, ctx } = conversation(
      "My favourite colour is ultramarine.",
      "integration",
    );
    await first.agentEnd()(event, ctx);

    // The server saw the request and processed it; only the acknowledgement was
    // lost. Without an operation id the replay below would store it a second time.
    await vi.waitFor(() => expect(server.retainBodies).toHaveLength(1));
    const sentId = server.retainBodies[0].operation_id;
    expect(sentId).toMatch(UUID_RE);

    const queued = readQueue(queuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0].operationId).toBe(sentId);
    await firstService.stop();

    // A restart must not mint a new id for work the server may already hold.
    const second = makeApi(queuePath, 1_000);
    const secondService = second.service();
    await secondService.start();
    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => expect(server.retainBodies).toHaveLength(2));
    expect(server.retainBodies[1].operation_id).toBe(sentId);
    await vi.waitFor(() => expect(readQueue(queuePath)).toHaveLength(0));
    await secondService.stop();
  });

  it("persists before sending when /version is unreachable, then delivers when it answers", async () => {
    vi.useFakeTimers();
    const queuePath = makeQueuePath();
    const server = installFakeServer("unknown");

    const api = makeApi(queuePath, 1_000);
    const service = api.service();
    await service.start();

    server.failRetains(1);
    const { event, ctx } = conversation(
      "Remember this while /version is down.",
      "integration",
    );
    await api.agentEnd()(event, ctx);

    // The durable outbox waits for capability detection before any send.
    expect(server.retainBodies).toHaveLength(0);
    const queued = readQueue(queuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0].operationId).toMatch(UUID_RE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.retainBodies).toHaveLength(0);
    expect(readQueue(queuePath)).toHaveLength(1);

    server.setCapability("supported");
    await vi.advanceTimersByTimeAsync(1_000);
    // First delivery loses its acknowledgement, so the exact identity survives.
    await vi.waitFor(() => expect(server.retainBodies).toHaveLength(1));
    expect(server.retainBodies[0].operation_id).toBe(queued[0].operationId);
    expect(readQueue(queuePath)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(server.retainBodies).toHaveLength(2));
    expect(server.retainBodies[1].operation_id).toBe(queued[0].operationId);
    await service.stop();
  });

  it("stops probing /version once the capability is known and the queue is empty", async () => {
    vi.useFakeTimers();
    const queuePath = makeQueuePath();
    const server = installFakeServer("supported");

    const api = makeApi(queuePath, 1_000);
    const service = api.service();
    await service.start();

    const first = conversation("First turn.", "probe-1");
    await api.agentEnd()(first.event, first.ctx);
    const afterFirstRetain = server.versionRequests();
    expect(afterFirstRetain).toBeGreaterThan(0); // resolved "unknown" once

    const second = conversation("Second turn.", "probe-2");
    await api.agentEnd()(second.event, second.ctx);
    // Cached capability, empty queue: a turn must not cost an extra round trip.
    expect(server.versionRequests()).toBe(afterFirstRetain);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.versionRequests()).toBe(afterFirstRetain);
    await vi.waitFor(() => expect(server.retainBodies).toHaveLength(2));
    await service.stop();
  });

  it("does not replay against a client that a restart has already replaced", async () => {
    vi.useFakeTimers();
    const queuePath = makeQueuePath();
    const server = installFakeServer("supported");

    const first = makeApi(queuePath, 1_000);
    const firstService = first.service();
    await firstService.start();
    server.failRetains(1);
    const { event, ctx } = conversation("Queued before the restart.", "stale");
    await first.agentEnd()(event, ctx);
    expect(readQueue(queuePath)).toHaveLength(1);

    // Stop the service while its flush is blocked inside the capability probe.
    const probeEntered = server.deferNextVersion();
    const timerAdvance = vi.advanceTimersByTimeAsync(1_000);
    await probeEntered;
    await firstService.stop();
    server.releaseDeferredVersion();
    await timerAdvance;

    // The stopped generation must not resume against a restarted client.
    await vi.waitFor(() => expect(server.retainBodies).toHaveLength(1));
    expect(readQueue(queuePath)).toHaveLength(1);
  });
});

describe("session_end flushes the un-retained tail (#4341)", () => {
  // The helper that reads the transcript has its own unit tests; this one pins the
  // wiring, which is where #1726's flush died: the hook fired, the guard above it
  // saw a payload with no `messages`, and the tail was dropped in silence. Only an
  // end-to-end retain proves the forced flush now reaches the server.
  it("retains the turns after the last cadence boundary when the session closes", async () => {
    const queuePath = makeQueuePath();
    const server = installFakeServer("supported");

    // retainEveryNTurns: 3 — two turns sit below the cadence boundary, so nothing
    // has been retained when the session ends.
    const api = makeApi(queuePath, 1_000, {
      retainEveryNTurns: 3,
      retainOverlapTurns: 1,
    });
    const service = api.service();
    await service.start();

    const sessionKey = "agent:main:discord:direct:session-end";
    const ctx = {
      agentId: "main",
      sessionKey,
      messageProvider: "discord",
      channelId: "direct:session-end",
      senderId: "user:integration",
    } as PluginHookAgentContext;

    await api.agentEnd()(
      {
        success: true,
        messages: [
          { role: "user", content: "First turn." },
          { role: "assistant", content: "Noted." },
        ],
      },
      ctx,
    );
    await api.agentEnd()(
      {
        success: true,
        messages: [
          { role: "user", content: "The tail nobody retained." },
          { role: "assistant", content: "Understood." },
        ],
      },
      ctx,
    );
    expect(server.retainBodies).toHaveLength(0);

    // The host reader preserves the ended-session boundary without a JSONL file.
    const readTail = vi.fn().mockResolvedValue({
      messages: [
        { role: "user", content: "First turn." },
        { role: "assistant", content: "Noted." },
        { role: "user", content: "The tail nobody retained." },
        { role: "assistant", content: "Understood." },
      ],
      totalMessages: 4,
      truncated: false,
    });
    await api.sessionEnd()(
      {
        sessionId: "sess-1",
        sessionKey,
        messageCount: 4,
        durationMs: 12_000,
        reason: "reset",
      },
      {
        sessionId: "sess-1",
        sessionKey,
        agentId: "main",
        endedTranscript: { available: true, readTail },
      },
    );
    expect(readTail).toHaveBeenCalledOnce();
    // session_end persists first; the background service delivers after it returns.
    expect(readQueue(queuePath)).toHaveLength(1);
    await vi.waitFor(() => expect(server.retainBodies).toHaveLength(1), {
      timeout: 2500,
    });
    expect(JSON.stringify(server.retainBodies[0])).toContain(
      "The tail nobody retained.",
    );
    await service.stop();
  });

  it("skips the flush when the host reports no transcript", async () => {
    const queuePath = makeQueuePath();
    const server = installFakeServer("supported");

    const api = makeApi(queuePath, 1_000, {
      retainEveryNTurns: 3,
      retainOverlapTurns: 1,
    });
    const service = api.service();
    await service.start();

    const sessionKey = "agent:main:discord:direct:no-transcript";
    const ctx = {
      agentId: "main",
      sessionKey,
      messageProvider: "discord",
      channelId: "direct:no-transcript",
      senderId: "user:integration",
    } as PluginHookAgentContext;

    await api.agentEnd()(
      {
        success: true,
        messages: [
          { role: "user", content: "Only turn." },
          { role: "assistant", content: "Noted." },
        ],
      },
      ctx,
    );

    await api.sessionEnd()(
      {
        sessionId: "sess-2",
        sessionKey,
        messageCount: 2,
        reason: "shutdown",
        sessionFile: join(tmpdir(), "hindsight-missing", "sess-2.jsonl"),
      },
      {
        sessionId: "sess-2",
        sessionKey,
        agentId: "main",
        endedTranscript: { available: false, reason: "unsupported-source" },
      },
    );

    expect(server.retainBodies).toHaveLength(0);
    await service.stop();
  });
});

// The bank id lives in the retain URL, so these pin the routing itself rather than
// deriveBankId's return value — what would break is a call site reaching the client
// without consulting the map. (#3890)
describe("agentBankMap routes retains to the mapped bank", () => {
  const ctxFor = (agentId: string, session: string) =>
    ({
      agentId,
      sessionKey: `agent:${agentId}:discord:direct:${session}`,
      messageProvider: "discord",
      channelId: `direct:${session}`,
      senderId: `user-${session}`,
    }) as PluginHookAgentContext;

  const oneTurn = (text: string) => ({
    success: true,
    messages: [
      { role: "user", content: text },
      { role: "assistant", content: "Noted." },
    ],
  });

  it("sends mapped agents to one shared bank and leaves an unmapped one derived", async () => {
    const queuePath = makeQueuePath();
    const server = installFakeServer("supported");
    const api = makeApi(queuePath, 1_000, {
      dynamicBankId: true,
      bankId: undefined,
      dynamicBankGranularity: ["agent", "channel", "user"],
      agentBankMap: { inbound: "ps-technology", outbound: "ps-technology" },
    });
    const service = api.service();
    await service.start();

    await api.agentEnd()(
      oneTurn("Postgres 16 in production."),
      ctxFor("inbound", "s1"),
    );
    await api.agentEnd()(
      oneTurn("Campaigns ship on Tuesday."),
      ctxFor("outbound", "s2"),
    );
    await api.agentEnd()(
      oneTurn("This agent is not in the map."),
      ctxFor("stranger", "s3"),
    );

    expect(server.retainUrls).toHaveLength(3);
    // Two different agents, one named bank.
    expect(server.retainUrls[0]).toContain("/banks/ps-technology/");
    expect(server.retainUrls[1]).toContain("/banks/ps-technology/");
    // The unmapped agent keeps the bank it would have derived anyway.
    expect(server.retainUrls[2]).toContain("stranger");
    expect(server.retainUrls[2]).not.toContain("ps-technology");

    await service.stop();
  });

  it("overrides a static bank for mapped agents only", async () => {
    const queuePath = makeQueuePath();
    const server = installFakeServer("supported");
    // The harness config is dynamicBankId:false — without the map every agent
    // would share `integration-bank`.
    const api = makeApi(queuePath, 1_000, {
      agentBankMap: { limpieza: "ps-limpieza" },
    });
    const service = api.service();
    await service.start();

    await api.agentEnd()(
      oneTurn("The crew starts at 06:00."),
      ctxFor("limpieza", "s1"),
    );
    await api.agentEnd()(oneTurn("Anything else."), ctxFor("other", "s2"));

    expect(server.retainUrls).toHaveLength(2);
    expect(server.retainUrls[0]).toContain("/banks/ps-limpieza/");
    expect(server.retainUrls[1]).toContain("/banks/integration-bank/");

    await service.stop();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetainQueue } from "./retain-queue.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  PluginHookAgentContext,
  PluginHookHandler,
} from "./types.js";

type SessionType = "cron" | "subagent" | "heartbeat";
type Service = { stop(): Promise<void> };
type ToolFactory = (ctx: OpenClawPluginToolContext) => Array<{
  name: string;
  execute(id: string, params: Record<string, unknown>): Promise<unknown>;
}>;

const task =
  "Research the project's storage decisions and summarize the evidence.";
const protectedContext = (text: string) =>
  `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n${text}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`;
const taskPrompt = (type: SessionType) =>
  type === "subagent"
    ? `${protectedContext("[Subagent Context] Research assignment\n[Subagent Task]")}\n${task}\n${protectedContext("Begin the task.")}`
    : task;
const context = (type: SessionType): PluginHookAgentContext => ({
  agentId: "librarian",
  sessionKey: `agent:librarian:${type}:fixture:run:fixture`,
  // Operational namespaces can use an actual external delivery provider.
  messageProvider: type === "cron" ? "discord" : type,
  ...(type === "cron" ? { trigger: "cron" as const } : {}),
});
const messages = (type: SessionType) => [
  { role: "user", content: taskPrompt(type) },
  {
    role: "assistant",
    content: "The project uses SQLite for local durable state.",
  },
];
const ordinaryContext: PluginHookAgentContext = {
  agentId: "librarian",
  sessionKey: "agent:librarian:discord:channel:research",
  messageProvider: "discord",
  channelId: "research",
  senderId: "researcher",
};

let directory: string;
let queuePath: string;
let service: Service | undefined;
let recall: PluginHookHandler<"before_prompt_build">;
let retain: PluginHookHandler<"agent_end">;
let dispatch: PluginHookHandler<"before_dispatch">;
let end: PluginHookHandler<"session_end">;
let module: typeof import("./index.js");
let Client: typeof import("@vectorize-io/hindsight-client").HindsightClient;
let toolFactory: ToolFactory | undefined;

beforeEach(async () => {
  vi.resetModules();
  service = undefined;
  toolFactory = undefined;
  module = await import("./index.js");
  Client = (await import("@vectorize-io/hindsight-client")).HindsightClient;
  directory = mkdtempSync(join(tmpdir(), "hindsight-session-scope-"));
  queuePath = join(directory, "queue.jsonl");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            api_version: "0.10.2",
            features: { store_document_text: true },
            results: [
              {
                id: "fixture",
                text: "A verified storage decision",
                type: "observation",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  vi.spyOn(Client.prototype, "recall").mockResolvedValue({
    results: [
      {
        id: "fixture",
        text: "A verified storage decision",
        type: "observation",
      },
    ],
  } as never);
});

afterEach(async () => {
  await service?.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

function register(config: Record<string, unknown> = {}) {
  const api: Partial<OpenClawPluginApi> = {
    config: {},
    pluginConfig: {
      hindsightApiUrl: "https://hindsight.test",
      agentBankMap: { librarian: "librarian" },
      dynamicBankGranularity: ["agent"],
      retainQueuePath: queuePath,
      recallTimeoutMs: 1000,
      logLevel: "off",
      ...config,
    },
    registerService(registered) {
      const serviceContext = {
        config: {},
        stateDir: directory,
        logger: { info() {}, warn() {}, error() {} },
      };
      service = {
        async stop() {
          await registered.stop?.(serviceContext);
        },
      };
    },
    registerTool(factory) {
      toolFactory = factory as ToolFactory;
    },
    on(name, handler) {
      if (name === "before_prompt_build") recall = handler;
      if (name === "agent_end") retain = handler;
      if (name === "before_dispatch") dispatch = handler;
      if (name === "session_end") end = handler;
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  module.default.register(api as OpenClawPluginApi);
  return api as OpenClawPluginApi;
}

function queued() {
  return new RetainQueue({ filePath: queuePath }).peek();
}

it("can register again after invalid scope is corrected", () => {
  const api = {
    config: {},
    pluginConfig: { scope: { skipRetainSessions: "**" } },
    registerService: vi.fn(),
    on: vi.fn(),
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as OpenClawPluginApi;
  expect(() => module.default.register(api)).toThrow(/scope/);
  expect(api.on).not.toHaveBeenCalled();
  expect(api.registerService).not.toHaveBeenCalled();
  api.pluginConfig = { scope: { skipRetainSessions: ["**"] }, logLevel: "off" };
  module.default.register(api);
  expect(api.on).toHaveBeenCalled();
  expect(api.registerService).toHaveBeenCalledTimes(1);
});

async function run(type: SessionType, ctx = context(type)) {
  const result = await recall(
    {
      prompt: taskPrompt(type),
      currentUserMessage: taskPrompt(type),
      messages: [],
    },
    ctx,
  );
  await retain({ success: true, messages: messages(type) }, ctx);
  return result;
}

describe.each(["cron", "subagent", "heartbeat"] as const)(
  "%s automatic memory scope",
  (type) => {
    it("recalls and retains an initial task by default", async () => {
      register();
      const result = await run(type);
      expect(Client.prototype.recall).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        expect.objectContaining({
          prependContext: expect.stringContaining(
            "A verified storage decision",
          ),
        }),
      );
      expect(queued()).toHaveLength(1);
      expect(queued()[0].bankId).toBe("librarian");
      expect(queued()[0].content).toContain(task);
      expect(queued()[0].content).not.toContain("Subagent Context");
    });

    it.each([
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ])(
      "independently skips recall=%s and retain=%s after dispatch",
      async (skipRecall, skipRetain) => {
        const pattern = `agent:*:${type}:**`;
        register({
          scope: {
            skipRecallSessions: skipRecall ? [pattern] : [],
            skipRetainSessions: skipRetain ? [pattern] : [],
          },
        });
        const ctx = context(type);
        await dispatch(
          { sessionKey: ctx.sessionKey, channel: ctx.messageProvider ?? type },
          ctx,
        );
        await run(type);
        expect(Client.prototype.recall).toHaveBeenCalledTimes(
          skipRecall ? 0 : 1,
        );
        expect(queued()).toHaveLength(skipRetain ? 0 : 1);
      },
    );

    it("still filters internal completion provenance", async () => {
      register();
      await run(type, {
        ...context(type),
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "internal",
          sourceTool: "subagent_settle",
        },
      });
      expect(Client.prototype.recall).not.toHaveBeenCalled();
      expect(queued()).toHaveLength(0);
    });

    it("flushes a short operational session through session_end", async () => {
      register({ retainEveryNTurns: 20 });
      await retain({ success: true, messages: messages(type) }, context(type));
      expect(queued()).toHaveLength(0);
      await end(
        { sessionId: "ended-fixture", messageCount: 2 },
        {
          ...context(type),
          endedTranscript: {
            available: true,
            readTail: async () => ({
              messages: messages(type),
              truncated: false,
            }),
          },
        },
      );
      expect(queued()).toHaveLength(1);
      expect(queued()[0].content).toContain("SQLite for local durable state");
    });

    it("does not read or flush an excluded session_end transcript", async () => {
      register({
        retainEveryNTurns: 20,
        scope: { skipRetainSessions: [`agent:*:${type}:**`] },
      });
      await retain({ success: true, messages: messages(type) }, context(type));
      const readTail = vi.fn(async () => ({
        messages: messages(type),
        truncated: false,
      }));
      await end(
        { sessionId: "ended-fixture", messageCount: 2 },
        {
          ...context(type),
          endedTranscript: { available: true, readTail },
        },
      );
      expect(readTail).not.toHaveBeenCalled();
      expect(queued()).toHaveLength(0);
    });
  },
);

it.each([undefined, {}, { skipRecallSessions: [], skipRetainSessions: [] }])(
  "does not exclude an ordinary session with empty scope %j",
  async (scope) => {
    register({ scope });
    await run("cron", ordinaryContext);
    expect(Client.prototype.recall).toHaveBeenCalledTimes(1);
    expect(queued()).toHaveLength(1);
  },
);

it("does not exclude a heartbeat provider using a main session key", async () => {
  register();
  await run("heartbeat", {
    agentId: "librarian",
    sessionKey: "agent:librarian:main",
    messageProvider: "heartbeat",
  });
  expect(Client.prototype.recall).toHaveBeenCalledTimes(1);
  expect(queued()).toHaveLength(1);
});

it.each(["**", "agent:*:discord:**"])(
  "does not bypass configured pattern %s when sessionKey is missing",
  async (pattern) => {
    register({
      scope: { skipRecallSessions: [pattern], skipRetainSessions: [pattern] },
    });
    await run("cron", { ...ordinaryContext, sessionKey: undefined });
    expect(Client.prototype.recall).not.toHaveBeenCalled();
    expect(queued()).toHaveLength(0);
  },
);

it.each([
  ["agent:*:cron:*", 1],
  ["agent:*:cron:**", 0],
  ["**", 0],
])("matches colon boundaries in %s", async (pattern, allowedCount) => {
  register({
    scope: { skipRecallSessions: [pattern], skipRetainSessions: [pattern] },
  });
  await run("cron");
  expect(Client.prototype.recall).toHaveBeenCalledTimes(allowedCount);
  expect(queued()).toHaveLength(allowedCount);
});

it("omits the entire internal turn from multi-turn recall context", async () => {
  register({ recallContextTurns: 5 });
  await recall(
    {
      prompt: task,
      currentUserMessage: task,
      messages: [
        ...messages("subagent"),
        {
          role: "user",
          content: "Child result received",
          inputProvenance: {
            kind: "inter_session",
            sourceTool: "subagent_announce",
          },
        },
        { role: "assistant", content: "PRIVATE_COORDINATION_ARTIFACT" },
        { role: "user", content: task },
      ],
    },
    ordinaryContext,
  );
  expect(Client.prototype.recall).toHaveBeenCalledTimes(1);
  const query = vi.mocked(Client.prototype.recall).mock.calls[0][1];
  expect(query).toContain("SQLite for local durable state");
  expect(query).not.toContain("Child result received");
  expect(query).not.toContain("PRIVATE_COORDINATION_ARTIFACT");
});

it("omits the entire internal turn from a retained conversation window", async () => {
  register({ retainEveryNTurns: 2 });
  await retain(
    { success: true, messages: messages("subagent") },
    ordinaryContext,
  );
  await retain(
    {
      success: true,
      messages: [
        ...messages("subagent"),
        {
          role: "user",
          content: "Every subagent in this batch has now settled",
        },
        { role: "assistant", content: "PRIVATE_COORDINATION_ARTIFACT" },
        { role: "user", content: "Record the final storage recommendation." },
        {
          role: "assistant",
          content: "SQLite remains the recommended storage.",
        },
      ],
    },
    ordinaryContext,
  );
  expect(queued()).toHaveLength(1);
  expect(queued()[0].content).toContain("SQLite remains");
  expect(queued()[0].content).not.toContain("PRIVATE_COORDINATION_ARTIFACT");
});

it("keeps explicit tools usable when both automatic actions are globally skipped", async () => {
  register({
    scope: { skipRecallSessions: ["**"], skipRetainSessions: ["**"] },
  });
  await run("cron", ordinaryContext);
  expect(Client.prototype.recall).not.toHaveBeenCalled();
  expect(queued()).toHaveLength(0);
  expect(toolFactory).toBeTypeOf("function");
  const tools = toolFactory!({
    agentId: "librarian",
    sessionKey: ordinaryContext.sessionKey,
  });
  expect(tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([
      "memory_recall",
      "memory_reflect",
      "memory_store",
      "knowledge_page",
    ]),
  );
  const tool = tools.find((candidate) => candidate.name === "memory_recall")!;
  const result = await tool.execute("explicit-recall", { query: task });
  expect(JSON.stringify(result)).toContain("A verified storage decision");
});

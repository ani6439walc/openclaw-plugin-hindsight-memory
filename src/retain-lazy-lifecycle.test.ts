import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  PluginHookHandler,
} from "./types.js";
import { RetainQueue } from "./retain-queue.js";

let directory: string;
let queuePath: string;
let service: OpenClawPluginService;
let hook: PluginHookHandler<"agent_end">;
let flush: typeof import("./index.js").flushRetainQueue;
let Client: typeof import("@vectorize-io/hindsight-client").HindsightClient;
const ctx = {
  agentId: "main",
  sessionKey: "agent:main:discord:channel:test-channel",
  messageProvider: "discord",
};
const event = {
  success: true,
  messages: [
    {
      role: "user",
      content: "Remember that the project release is scheduled for Friday.",
    },
    {
      role: "assistant",
      content: "The project release is scheduled for Friday.",
    },
  ],
};
beforeEach(async () => {
  vi.resetModules();
  directory = mkdtempSync(join(tmpdir(), "hindsight-lazy-retain-"));
  queuePath = join(directory, "retains.jsonl");
  Client = (await import("@vectorize-io/hindsight-client")).HindsightClient;
  const module = await import("./index.js");
  flush = module.flushRetainQueue;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            api_version: "0.10.2",
            features: { store_document_text: true },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  module.default.register!({
    config: {},
    pluginConfig: {
      hindsightApiUrl: "http://localhost:8888",
      agentBankMap: { main: "test-bank" },
      dynamicBankId: true,
      retainEveryNTurns: 1,
      retainQueuePath: queuePath,
      logLevel: "off",
    },
    registerService: (registered) => {
      service = registered;
    },
    on: (name, handler) => {
      if (name === "agent_end") hook = handler;
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
});
afterEach(async () => {
  await service.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});
it("persists a Discord turn without services or a reachable API", async () => {
  const send = vi
    .spyOn(Client.prototype, "retain")
    .mockResolvedValue({} as never);
  vi.mocked(fetch).mockRejectedValue(new Error("API unavailable"));
  await hook(event, ctx);
  const rows = new RetainQueue({ filePath: queuePath }).peek();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual(
    expect.objectContaining({
      bankId: "test-bank",
      content: expect.stringContaining("Friday"),
      documentId: expect.stringContaining(`openclaw:${ctx.sessionKey}`),
      operationId: expect.any(String),
    }),
  );
  expect(send).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it("does not revive retention after service stop", async () => {
  await service.stop();
  await hook(event, ctx);
  expect(new RetainQueue({ filePath: queuePath }).size()).toBe(0);
});
it("delivers a scoped producer's persisted turn from the service with the same operation id", async () => {
  const send = vi
    .spyOn(Client.prototype, "retain")
    .mockResolvedValue({} as never);
  await hook(event, ctx);
  const queue = new RetainQueue({ filePath: queuePath });
  const item = queue.peek()[0];
  await service.start();
  await flush();
  expect(send).toHaveBeenCalledWith(
    "test-bank",
    item.content,
    expect.objectContaining({
      documentId: item.documentId,
      operationId: item.operationId,
      async: true,
    }),
  );
  expect(queue.size()).toBe(0);
});
it("retains the persisted turn when service initialization fails", async () => {
  await hook(event, ctx);
  vi.mocked(fetch).mockRejectedValue(new Error("API unavailable"));
  vi.useFakeTimers();
  const failed = expect(service.start()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(10_000);
  await failed;
  expect(new RetainQueue({ filePath: queuePath }).size()).toBe(1);
});

it("skips retention when inputProvenance indicates a subagent or inter-session event", async () => {
  await hook(event, {
    ...ctx,
    inputProvenance: {
      kind: "inter_session",
      sourceChannel: "internal",
      sourceTool: "subagent_settle",
    },
  });
  expect(new RetainQueue({ filePath: queuePath }).size()).toBe(0);
});

it("skips retention for unclassified settlement text in default JSON mode", async () => {
  await hook(
    {
      success: true,
      messages: [
        {
          role: "user",
          content:
            "[Subagent Context] Every subagent in this batch has now settled, including its descendants.\nChild completion results:\n- subagent-1: success",
        },
        {
          role: "assistant",
          content: "Understood, processing child results.",
        },
      ],
    },
    ctx,
  );
  expect(new RetainQueue({ filePath: queuePath }).size()).toBe(0);
});

it("omits provenance-skipped internal turns from subsequent chunked-retain windows while preserving normal turns", async () => {
  let chunkedHook: PluginHookHandler<"agent_end">;
  const module = await import("./index.js");
  module.default.register!({
    config: {},
    pluginConfig: {
      hindsightApiUrl: "http://localhost:8888",
      agentBankMap: { main: "test-bank" },
      dynamicBankId: true,
      retainEveryNTurns: 2,
      retainOverlapTurns: 0,
      retainQueuePath: queuePath,
      logLevel: "off",
    },
    on: (event, handler) => {
      if (event === "agent_end") chunkedHook = handler;
    },
    registerService: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });

  const chunkedSessionKey = "agent:main:discord:channel:chunked-test";
  const chunkedCtx = { ...ctx, sessionKey: chunkedSessionKey };

  // Turn 1: normal user
  await chunkedHook!(
    {
      success: true,
      messages: [
        { role: "user", content: "Turn 1 normal prompt" },
        { role: "assistant", content: "Turn 1 response" },
      ],
    },
    chunkedCtx,
  );
  expect(new RetainQueue({ filePath: queuePath }).size()).toBe(0);

  // Turn 2: internal subagent completion
  await chunkedHook!(
    {
      success: true,
      messages: [
        { role: "user", content: "Turn 1 normal prompt" },
        { role: "assistant", content: "Turn 1 response" },
        {
          role: "user",
          content:
            "[Subagent Context] Every subagent in this batch has now settled",
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "internal",
            sourceTool: "subagent_settle",
          },
        },
        { role: "assistant", content: "Acknowledged subagent completion" },
      ],
    },
    {
      ...chunkedCtx,
      inputProvenance: {
        kind: "inter_session",
        sourceChannel: "internal",
        sourceTool: "subagent_settle",
      },
    },
  );
  expect(new RetainQueue({ filePath: queuePath }).size()).toBe(0);

  // Turn 3: normal user (second genuine turn, triggers chunked retain)
  await chunkedHook!(
    {
      success: true,
      messages: [
        { role: "user", content: "Turn 1 normal prompt" },
        { role: "assistant", content: "Turn 1 response" },
        {
          role: "user",
          content:
            "[Subagent Context] Every subagent in this batch has now settled",
        },
        { role: "assistant", content: "Acknowledged subagent completion" },
        { role: "user", content: "Turn 3 normal prompt" },
        { role: "assistant", content: "Turn 3 response" },
      ],
    },
    chunkedCtx,
  );

  const queue = new RetainQueue({ filePath: queuePath });
  expect(queue.size()).toBe(1);
  const item = queue.peek()[0];
  expect(item.content).toContain("Turn 1 normal prompt");
  expect(item.content).toContain("Turn 3 normal prompt");
  expect(item.content).not.toContain("Subagent Context");
  expect(item.content).not.toContain("Acknowledged subagent completion");
});

it("retains genuine user text that carries a protected runtime context block and strips the block", async () => {
  await hook(
    {
      success: true,
      messages: [
        {
          role: "user",
          content:
            'Remember that I prefer PostgreSQL.\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nConversation data: "[Inter-session message] isUser=false"\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
        },
        {
          role: "assistant",
          content: "Understood, PostgreSQL preference noted.",
        },
      ],
    },
    ctx,
  );

  const queue = new RetainQueue({ filePath: queuePath });
  expect(queue.size()).toBe(1);
  const item = queue.peek()[0];
  expect(item.content).toContain("Remember that I prefer PostgreSQL.");
  expect(item.content).toContain("Understood, PostgreSQL preference noted.");
  expect(item.content).not.toContain("BEGIN_OPENCLAW_INTERNAL_CONTEXT");
  expect(item.content).not.toContain("Inter-session message");
});

it("retains genuine user text across adjacent text blocks in default JSON mode and strips split context block", async () => {
  await hook(
    {
      success: true,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Remember PostgreSQL.\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nSECRET_ONE",
            },
            {
              type: "text",
              text: "SECRET_TWO\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nUse UTC timestamps.",
            },
          ],
        },
        {
          role: "assistant",
          content: "Understood, PostgreSQL and UTC timestamps.",
        },
      ],
    },
    ctx,
  );

  const queue = new RetainQueue({ filePath: queuePath });
  expect(queue.size()).toBe(1);
  const item = queue.peek()[0];
  expect(item.content).toContain("Remember PostgreSQL.");
  expect(item.content).toContain("Use UTC timestamps.");
  expect(item.content).toContain("Understood, PostgreSQL and UTC timestamps.");
  expect(item.content).not.toContain("BEGIN_OPENCLAW_INTERNAL_CONTEXT");
  expect(item.content).not.toContain("END_OPENCLAW_INTERNAL_CONTEXT");
  expect(item.content).not.toContain("SECRET_ONE");
  expect(item.content).not.toContain("SECRET_TWO");
});

it("queues no retain for one-block context-only array in agent_end path", async () => {
  await hook(
    {
      success: true,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nSECRET_ONE\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
            },
          ],
        },
        {
          role: "assistant",
          content: "Internal coordination reply",
        },
      ],
    },
    ctx,
  );

  const queue = new RetainQueue({ filePath: queuePath });
  expect(queue.size()).toBe(0);
});

it("queues no retain for split-block context-only array in agent_end path", async () => {
  await hook(
    {
      success: true,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nSECRET_ONE",
            },
            {
              type: "text",
              text: "SECRET_TWO\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
            },
          ],
        },
        {
          role: "assistant",
          content: "Internal coordination reply",
        },
      ],
    },
    ctx,
  );

  const queue = new RetainQueue({ filePath: queuePath });
  expect(queue.size()).toBe(0);
});

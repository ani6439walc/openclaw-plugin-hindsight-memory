import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "./types.js";

type RegisteredDescriptor = {
  contextVersion: 2;
  create: (ctx: OpenClawPluginToolContext<2>) => Array<{
    name: string;
    execute(id: string, params: Record<string, unknown>): Promise<unknown>;
  }>;
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function extractFetchUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === "object" && "url" in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

describe("knowledge tools V2 authority & prepared memoryAudience (#13)", () => {
  let pluginModule: typeof import("./index.js");
  let HindsightClient: typeof import("@vectorize-io/hindsight-client").HindsightClient;
  let registeredDescriptor: RegisteredDescriptor | undefined;
  let registeredMeta: { names?: string[]; optional?: boolean } | undefined;
  let registeredService:
    | {
        start?: (ctx: unknown) => Promise<void>;
        stop?: (ctx: unknown) => Promise<void>;
      }
    | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    registeredDescriptor = undefined;
    registeredMeta = undefined;
    registeredService = undefined;
    pluginModule = await import("./index.js");
    HindsightClient = (await import("@vectorize-io/hindsight-client"))
      .HindsightClient;

    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = extractFetchUrl(input);
      if (url.endsWith("/version")) {
        return new Response(
          JSON.stringify({
            api_version: "0.10.2",
            features: { store_document_text: true },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          url,
          results: [{ id: "1", text: "verified-fact", type: "world" }],
          text: "synthesized answer",
          items: [],
          success: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await registeredService?.stop?.({
      config: {},
      logger: { info() {}, warn() {}, error() {} },
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function registerPluginWithConfig(
    pluginConfig: Record<string, unknown> = {},
  ): RegisteredDescriptor {
    const api: Partial<OpenClawPluginApi> = {
      config: {},
      pluginConfig: {
        hindsightApiUrl: "https://hindsight.authority.test",
        hindsightApiToken: "secret-token",
        dynamicBankGranularity: ["user"],
        bankIdPrefix: "auth_test",
        logLevel: "off",
        ...pluginConfig,
      },
      registerService(svc: unknown) {
        registeredService = svc as {
          start?: (ctx: unknown) => Promise<void>;
          stop?: (ctx: unknown) => Promise<void>;
        };
      },
      registerTool(factory: OpenClawPluginToolFactory, meta?: unknown) {
        registeredDescriptor = factory as unknown as RegisteredDescriptor;
        registeredMeta = meta as { names?: string[]; optional?: boolean };
      },
      on() {},
      logger: { info() {}, warn() {}, error() {} },
    };

    pluginModule.default.register(api as OpenClawPluginApi);
    if (!registeredDescriptor) {
      throw new Error("Expected registerTool to be called");
    }
    return registeredDescriptor;
  }

  function lastFetchUrl(): string {
    const lastCall = fetchMock.mock.calls.at(-1);
    return extractFetchUrl(lastCall?.[0]);
  }

  it("registers V2 tool descriptor ({ contextVersion: 2, create }) and allows metadata-only catalog creation", () => {
    const descriptor = registerPluginWithConfig();

    expect(descriptor.contextVersion).toBe(2);
    expect(descriptor.create).toBeTypeOf("function");
    expect(registeredMeta).toEqual({
      names: [
        "memory_recall",
        "memory_reflect",
        "memory_store",
        "knowledge_page",
      ],
      optional: false,
    });

    // OpenClaw calls `descriptor.create(ctx)` during catalog/schema inspection
    // when no admitted run is active (`assertInvocationCurrent` throws).
    const catalogTools = descriptor.create({
      assertInvocationCurrent() {
        throw new Error(
          "Plugin tool invocation authority is unavailable outside an admitted run or request",
        );
      },
    });
    expect(catalogTools.map((t) => t.name)).toEqual([
      "memory_recall",
      "memory_reflect",
      "memory_store",
      "knowledge_page",
    ]);
  });

  it("rejects pre-revoked invocation or memory-audience guards with zero SDK or HTTP calls", async () => {
    const createBankSpy = vi.spyOn(HindsightClient.prototype, "createBank");
    const updateBankSpy = vi.spyOn(
      HindsightClient.prototype,
      "updateBankConfig",
    );

    const descriptor = registerPluginWithConfig({
      bankMission: "Mission A",
      enableAutoConsolidation: true,
    });

    const sessionKey = "agent:main:discord:channel:ops";
    const revokedInvocationTools = descriptor.create({
      agentId: "main",
      sessionKey,
      requesterSenderId: "user-1",
      messageChannel: "discord",
      nativeChannelId: "ops",
      memoryAudience: {
        kind: "conversation",
        agentId: "main",
        sessionKey,
        sessionId: "sess-1",
      },
      assertInvocationCurrent() {
        throw new Error("invocation cancelled before dispatch");
      },
      assertMemoryAudienceCurrent() {},
    });
    const recallTool1 = revokedInvocationTools.find(
      (t) => t.name === "memory_recall",
    )!;
    await expect(
      recallTool1.execute("call-1", { query: "status" }),
    ).rejects.toThrow("invocation cancelled before dispatch");

    const revokedAudienceTools = descriptor.create({
      agentId: "main",
      sessionKey,
      requesterSenderId: "user-1",
      messageChannel: "discord",
      nativeChannelId: "ops",
      memoryAudience: {
        kind: "conversation",
        agentId: "main",
        sessionKey,
        sessionId: "sess-1",
      },
      assertInvocationCurrent() {},
      assertMemoryAudienceCurrent() {
        throw new Error("memory audience revoked before dispatch");
      },
    });
    const pageTool = revokedAudienceTools.find(
      (t) => t.name === "knowledge_page",
    )!;
    await expect(
      pageTool.execute("call-2", { action: "list" }),
    ).rejects.toThrow("memory audience revoked before dispatch");

    expect(createBankSpy).not.toHaveBeenCalled();
    expect(updateBankSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["invocation", "audience"] as const)(
    "aborts bank initialization in flight when %s authority is revoked and makes no downstream SDK calls",
    async (revokedGuard) => {
      const createBankStarted = createDeferred<void>();
      const releaseCreateBank = createDeferred<void>();

      const createBankSpy = vi
        .spyOn(HindsightClient.prototype, "createBank")
        .mockImplementation(async () => {
          createBankStarted.resolve();
          await releaseCreateBank.promise;
          return {} as never;
        });
      const updateBankSpy = vi
        .spyOn(HindsightClient.prototype, "updateBankConfig")
        .mockResolvedValue({} as never);

      const descriptor = registerPluginWithConfig({
        bankMission: "Apply mission defaults",
        enableAutoConsolidation: true,
      });

      let isRevoked = false;
      const sessionKey = `agent:main:discord:channel:init-${revokedGuard}`;
      const tools = descriptor.create({
        agentId: "main",
        sessionKey,
        requesterSenderId: `user-${revokedGuard}`,
        messageChannel: "discord",
        nativeChannelId: `init-${revokedGuard}`,
        memoryAudience: {
          kind: "conversation",
          agentId: "main",
          sessionKey,
          sessionId: `sess-${revokedGuard}`,
        },
        assertInvocationCurrent() {
          if (isRevoked && revokedGuard === "invocation") {
            throw new Error("invocation superseded during init");
          }
        },
        assertMemoryAudienceCurrent() {
          if (isRevoked && revokedGuard === "audience") {
            throw new Error("memory audience superseded during init");
          }
        },
      });

      const recallTool = tools.find((t) => t.name === "memory_recall")!;
      const pendingExecution = recallTool.execute("init-race", {
        query: "project roadmap",
      });

      await createBankStarted.promise;
      isRevoked = true;
      releaseCreateBank.resolve();

      await expect(pendingExecution).rejects.toThrow(
        revokedGuard === "invocation"
          ? "invocation superseded during init"
          : "memory audience superseded during init",
      );

      expect(createBankSpy).toHaveBeenCalledTimes(1);
      expect(updateBankSpy).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      // Because initialization did not complete under valid authority, a fresh
      // authorized call for the same bank must still apply bank defaults.
      createBankSpy.mockResolvedValue({} as never);
      const freshTools = descriptor.create({
        agentId: "main",
        sessionKey,
        requesterSenderId: `user-${revokedGuard}`,
        messageChannel: "discord",
        nativeChannelId: `init-${revokedGuard}`,
        memoryAudience: {
          kind: "conversation",
          agentId: "main",
          sessionKey,
          sessionId: `sess-${revokedGuard}`,
        },
        assertInvocationCurrent() {},
        assertMemoryAudienceCurrent() {},
      });
      await freshTools
        .find((t) => t.name === "memory_recall")!
        .execute("fresh-call", { query: "project roadmap" });

      expect(createBankSpy).toHaveBeenCalledTimes(2);
      expect(updateBankSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(lastFetchUrl()).toContain(
        `/v1/default/banks/auth_test-user-${revokedGuard}/memories/recall`,
      );
    },
  );

  it("withholds memory_recall and knowledge_page results when authority is revoked while a read is in flight", async () => {
    const recallStarted = createDeferred<void>();
    const releaseRecall = createDeferred<void>();
    const pageStarted = createDeferred<void>();
    const releasePage = createDeferred<void>();

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = extractFetchUrl(input);
      if (url.includes("/memories/recall")) {
        recallStarted.resolve();
        await releaseRecall.promise;
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "mem-secret",
                text: "ULTRA_SENSITIVE_MEMORY_FACT",
                type: "world",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      pageStarted.resolve();
      await releasePage.promise;
      return new Response(
        JSON.stringify({
          id: "private-notes",
          name: "Private Notes",
          content: "CONFIDENTIAL_MENTAL_MODEL_BODY",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    const descriptor = registerPluginWithConfig();
    const sessionKey = "agent:main:discord:channel:secure";

    // 1. memory_recall with invocation revoked in flight
    let invocationRevoked = false;
    const recallTools = descriptor.create({
      agentId: "main",
      sessionKey,
      requesterSenderId: "alice",
      messageChannel: "discord",
      nativeChannelId: "secure",
      memoryAudience: {
        kind: "conversation",
        agentId: "main",
        sessionKey,
        sessionId: "sess-alice",
      },
      assertInvocationCurrent() {
        if (invocationRevoked) {
          throw new Error("invocation cancelled mid-read");
        }
      },
      assertMemoryAudienceCurrent() {},
    });
    const pendingRecall = recallTools
      .find((t) => t.name === "memory_recall")!
      .execute("read-1", { query: "secrets" });

    await recallStarted.promise;
    invocationRevoked = true;
    releaseRecall.resolve();

    let caughtRecallErr: unknown;
    try {
      await pendingRecall;
    } catch (err) {
      caughtRecallErr = err;
    }
    expect(caughtRecallErr).toBeInstanceOf(Error);
    expect((caughtRecallErr as Error).message).toBe(
      "invocation cancelled mid-read",
    );
    expect(String(caughtRecallErr)).not.toContain(
      "ULTRA_SENSITIVE_MEMORY_FACT",
    );

    // 2. knowledge_page get with memoryAudience revoked in flight
    let audienceRevoked = false;
    const pageTools = descriptor.create({
      agentId: "main",
      sessionKey,
      requesterSenderId: "alice",
      messageChannel: "discord",
      nativeChannelId: "secure",
      memoryAudience: {
        kind: "conversation",
        agentId: "main",
        sessionKey,
        sessionId: "sess-alice",
      },
      assertInvocationCurrent() {},
      assertMemoryAudienceCurrent() {
        if (audienceRevoked) {
          throw new Error("conversation audience invalidated mid-read");
        }
      },
    });
    const pendingPage = pageTools
      .find((t) => t.name === "knowledge_page")!
      .execute("read-2", { action: "get", page_id: "private-notes" });

    await pageStarted.promise;
    audienceRevoked = true;
    releasePage.resolve();

    let caughtPageErr: unknown;
    try {
      await pendingPage;
    } catch (err) {
      caughtPageErr = err;
    }
    expect(caughtPageErr).toBeInstanceOf(Error);
    expect((caughtPageErr as Error).message).toBe(
      "conversation audience invalidated mid-read",
    );
    expect(String(caughtPageErr)).not.toContain(
      "CONFIDENTIAL_MENTAL_MODEL_BODY",
    );
  });

  it("routes valid owner-private, conversation, and conversation-subagent audiences across all 4 knowledge tools", async () => {
    const descriptor = registerPluginWithConfig({
      dynamicBankGranularity: ["agent", "user"],
    });

    // 1. owner-private audience
    const ownerTools = descriptor.create({
      agentId: "main",
      sessionKey: "agent:main:main",
      memoryAudience: {
        kind: "owner-private",
        agentId: "main",
      },
      assertInvocationCurrent() {},
      assertMemoryAudienceCurrent() {},
    });

    const expectedOwnerEncoded = encodeURIComponent(
      "auth_test-main::agent-user%3Amain",
    );

    await ownerTools
      .find((t) => t.name === "memory_recall")!
      .execute("owner-recall", { query: "preferences" });
    expect(lastFetchUrl()).toContain(
      `/v1/default/banks/${expectedOwnerEncoded}/memories/recall`,
    );

    await ownerTools
      .find((t) => t.name === "memory_reflect")!
      .execute("owner-reflect", { query: "summarize preferences" });
    expect(lastFetchUrl()).toContain(
      `/v1/default/banks/${expectedOwnerEncoded}/reflect`,
    );

    // 2. conversation-spawned subagent inheriting parent conversation audience
    const parentSessionKey = "agent:main:telegram:direct:554433";
    const subagentTools = descriptor.create({
      agentId: "main",
      sessionKey: "agent:main:subagent:research-helper",
      memoryAudience: {
        kind: "conversation",
        agentId: "main",
        sessionKey: parentSessionKey,
        sessionId: "sess-telegram-554433",
      },
      assertInvocationCurrent() {},
      assertMemoryAudienceCurrent() {},
    });

    const expectedSubagentEncoded = encodeURIComponent(
      "auth_test-main::554433",
    );

    await subagentTools
      .find((t) => t.name === "memory_store")!
      .execute("subagent-store", {
        title: "Architecture Spec",
        content: "Use Postgres with pgvector.",
      });
    expect(lastFetchUrl()).toContain(
      `/v1/default/banks/${expectedSubagentEncoded}/memories`,
    );

    await subagentTools
      .find((t) => t.name === "knowledge_page")!
      .execute("subagent-pages", { action: "list" });
    expect(lastFetchUrl()).toContain(
      `/v1/default/banks/${expectedSubagentEncoded}/mental-models?detail=metadata`,
    );
  });

  it("blocks session dynamic bank routing when memoryAudience is absent, while allowing static bank, agentBankMap, and valid non-session calls", async () => {
    // 1. Dynamic session turn missing memoryAudience -> rejected with zero SDK/HTTP calls
    const dynamicDescriptor = registerPluginWithConfig({
      agentBankMap: { mapped_agent: "explicit-team-bank" },
    });
    const unverifiedSessionTools = dynamicDescriptor.create({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:999888",
      requesterSenderId: "999888",
      messageChannel: "telegram",
      nativeChannelId: "direct:999888",
      assertInvocationCurrent() {},
    });
    const deniedResult = (await unverifiedSessionTools
      .find((t) => t.name === "memory_recall")!
      .execute("denied-1", { query: "test" })) as {
      details?: { error?: string };
    };
    expect(deniedResult.details?.error).toMatch(
      /missing host-prepared memoryAudience/,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    // 2. Deliberate agentBankMap policy -> allowed without memoryAudience
    const mappedTools = dynamicDescriptor.create({
      agentId: "mapped_agent",
      sessionKey: "agent:mapped_agent:cron:hourly",
      assertInvocationCurrent() {},
    });
    await mappedTools
      .find((t) => t.name === "memory_recall")!
      .execute("mapped-1", { query: "team status" });
    expect(lastFetchUrl()).toContain(
      "/v1/default/banks/explicit-team-bank/memories/recall",
    );

    // 3. Valid non-session tool invocation (no sessionKey) -> allowed via explicit host fields
    const nonSessionTools = dynamicDescriptor.create({
      agentId: "main",
      requesterSenderId: "cli-operator-7",
      messageChannel: "cli",
      nativeChannelId: "local",
      assertInvocationCurrent() {},
    });
    await nonSessionTools
      .find((t) => t.name === "memory_recall")!
      .execute("non-session-1", { query: "operator notes" });
    expect(lastFetchUrl()).toContain(
      "/v1/default/banks/auth_test-cli-operator-7/memories/recall",
    );

    // 4. Deliberate static bank policy (dynamicBankId: false) -> allowed without memoryAudience
    const staticDescriptor = registerPluginWithConfig({
      dynamicBankId: false,
      bankId: "org-static",
    });
    const staticTools = staticDescriptor.create({
      agentId: "main",
      sessionKey: "agent:main:heartbeat:check",
      assertInvocationCurrent() {},
    });
    await staticTools
      .find((t) => t.name === "memory_recall")!
      .execute("static-1", { query: "org handbook" });
    expect(lastFetchUrl()).toContain(
      "/v1/default/banks/auth_test-org-static/memories/recall",
    );
  });

  it.each(["invocation", "audience"] as const)(
    "blocks HTTP dispatch with zero fetch calls when %s authority is revoked during asynchronous SDK request preparation",
    async (revokedGuard) => {
      const descriptor = registerPluginWithConfig();
      const sessionKey = `agent:main:discord:channel:prep-${revokedGuard}`;
      const expectedMessage =
        revokedGuard === "invocation"
          ? "invocation revoked during async request prep"
          : "memory audience revoked during async request prep";

      // 1. memory_store (`retainBatch` -> `POST /memories`)
      let storeRevoked = false;
      const origRetainBatch = HindsightClient.prototype.retainBatch;
      const retainBatchSpy = vi
        .spyOn(HindsightClient.prototype, "retainBatch")
        .mockImplementation(function (
          this: InstanceType<typeof HindsightClient>,
          ...args
        ) {
          queueMicrotask(() => {
            storeRevoked = true;
          });
          return origRetainBatch.apply(this, args);
        });

      const storeTools = descriptor.create({
        agentId: "main",
        sessionKey,
        requesterSenderId: "user-prep",
        messageChannel: "discord",
        nativeChannelId: `prep-${revokedGuard}`,
        memoryAudience: {
          kind: "conversation",
          agentId: "main",
          sessionKey,
          sessionId: `sess-prep-${revokedGuard}`,
        },
        assertInvocationCurrent() {
          if (storeRevoked && revokedGuard === "invocation") {
            throw new Error(expectedMessage);
          }
        },
        assertMemoryAudienceCurrent() {
          if (storeRevoked && revokedGuard === "audience") {
            throw new Error(expectedMessage);
          }
        },
      });

      await expect(
        storeTools
          .find((t) => t.name === "memory_store")!
          .execute("prep-1", {
            title: "Uncommitted Write",
            content: "Must never leave the process",
          }),
      ).rejects.toThrow(expectedMessage);
      expect(retainBatchSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
      retainBatchSpy.mockRestore();

      // 2. knowledge_page create (`sdk.createMentalModel` -> `POST /mental-models`)
      let createPageChecks = 0;
      let createPageRevoked = false;
      const createPageTools = descriptor.create({
        agentId: "main",
        sessionKey,
        requesterSenderId: "user-prep",
        messageChannel: "discord",
        nativeChannelId: `prep-${revokedGuard}`,
        memoryAudience: {
          kind: "conversation",
          agentId: "main",
          sessionKey,
          sessionId: `sess-prep-${revokedGuard}`,
        },
        assertInvocationCurrent() {
          if (revokedGuard === "invocation") {
            createPageChecks += 1;
            if (createPageRevoked) {
              throw new Error(expectedMessage);
            }
            if (createPageChecks === 2) {
              // Check #2 is the pre-SDK check immediately before `sdk.createMentalModel`.
              // Schedule revocation so it fires during `await beforeRequest(options)`.
              queueMicrotask(() => {
                createPageRevoked = true;
              });
            }
          }
        },
        assertMemoryAudienceCurrent() {
          if (revokedGuard === "audience") {
            createPageChecks += 1;
            if (createPageRevoked) {
              throw new Error(expectedMessage);
            }
            if (createPageChecks === 2) {
              queueMicrotask(() => {
                createPageRevoked = true;
              });
            }
          }
        },
      });

      await expect(
        createPageTools
          .find((t) => t.name === "knowledge_page")!
          .execute("prep-2", {
            action: "create",
            page_id: "aborted-page",
            name: "Aborted Page",
            source_query: "Should never be created",
          }),
      ).rejects.toThrow(expectedMessage);
      expect(createPageChecks).toBe(3);
      expect(fetchMock).not.toHaveBeenCalled();

      // 3. knowledge_page delete (`deleteMentalModel` -> `DELETE /mental-models/...`)
      let deleteRevoked = false;
      const origDeleteMentalModel = HindsightClient.prototype.deleteMentalModel;
      const deleteSpy = vi
        .spyOn(HindsightClient.prototype, "deleteMentalModel")
        .mockImplementation(function (
          this: InstanceType<typeof HindsightClient>,
          ...args
        ) {
          queueMicrotask(() => {
            deleteRevoked = true;
          });
          return origDeleteMentalModel.apply(this, args);
        });

      const deletePageTools = descriptor.create({
        agentId: "main",
        sessionKey,
        requesterSenderId: "user-prep",
        messageChannel: "discord",
        nativeChannelId: `prep-${revokedGuard}`,
        memoryAudience: {
          kind: "conversation",
          agentId: "main",
          sessionKey,
          sessionId: `sess-prep-${revokedGuard}`,
        },
        assertInvocationCurrent() {
          if (deleteRevoked && revokedGuard === "invocation") {
            throw new Error(expectedMessage);
          }
        },
        assertMemoryAudienceCurrent() {
          if (deleteRevoked && revokedGuard === "audience") {
            throw new Error(expectedMessage);
          }
        },
      });

      await expect(
        deletePageTools
          .find((t) => t.name === "knowledge_page")!
          .execute("prep-3", {
            action: "delete",
            page_id: "protected-page",
          }),
      ).rejects.toThrow(expectedMessage);
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["invocation", "audience"] as const)(
    "blocks bank-defaults HTTP dispatches during async request preparation even when service.start() shared client is active (%s)",
    async (revokedGuard) => {
      const tempDir = mkdtempSync(join(tmpdir(), "hindsight-tool-auth-svc-"));
      try {
        const descriptor = registerPluginWithConfig({
          bankMission: "Mission Guard",
          enableAutoConsolidation: true,
          retainQueuePath: join(tempDir, "queue.jsonl"),
        });

        await registeredService?.start?.({
          config: {},
          stateDir: tempDir,
          logger: { info() {}, warn() {}, error() {} },
        });
        fetchMock.mockClear();

        const sessionKey = `agent:main:discord:channel:svc-${revokedGuard}`;
        const expectedMessage =
          revokedGuard === "invocation"
            ? "invocation revoked during active-service bank defaults prep"
            : "audience revoked during active-service bank defaults prep";

        // Phase A: Revoke during `createBank` async request preparation -> zero HTTP calls
        let createRevoked = false;
        const origCreateBank = HindsightClient.prototype.createBank;
        const createBankSpy = vi
          .spyOn(HindsightClient.prototype, "createBank")
          .mockImplementation(function (
            this: InstanceType<typeof HindsightClient>,
            ...args
          ) {
            queueMicrotask(() => {
              createRevoked = true;
            });
            return origCreateBank.apply(this, args);
          });

        const toolsA = descriptor.create({
          agentId: "main",
          sessionKey,
          requesterSenderId: `svc-user-${revokedGuard}`,
          messageChannel: "discord",
          nativeChannelId: `svc-${revokedGuard}`,
          memoryAudience: {
            kind: "conversation",
            agentId: "main",
            sessionKey,
            sessionId: `sess-svc-${revokedGuard}`,
          },
          assertInvocationCurrent() {
            if (createRevoked && revokedGuard === "invocation") {
              throw new Error(expectedMessage);
            }
          },
          assertMemoryAudienceCurrent() {
            if (createRevoked && revokedGuard === "audience") {
              throw new Error(expectedMessage);
            }
          },
        });

        await expect(
          toolsA
            .find((t) => t.name === "memory_recall")!
            .execute("svc-a", { query: "status" }),
        ).rejects.toThrow(expectedMessage);
        expect(createBankSpy).toHaveBeenCalledTimes(1);
        expect(fetchMock).not.toHaveBeenCalled();
        createBankSpy.mockRestore();

        // Phase B: Let `createBank` PUT succeed, then revoke during `updateBankConfig`
        // async request preparation -> exactly 1 fetch (the authorized PUT), zero PATCH/recall!
        let patchRevoked = false;
        const origUpdateBankConfig = HindsightClient.prototype.updateBankConfig;
        const updateBankSpy = vi
          .spyOn(HindsightClient.prototype, "updateBankConfig")
          .mockImplementation(function (
            this: InstanceType<typeof HindsightClient>,
            ...args
          ) {
            queueMicrotask(() => {
              patchRevoked = true;
            });
            return origUpdateBankConfig.apply(this, args);
          });

        const toolsB = descriptor.create({
          agentId: "main",
          sessionKey,
          requesterSenderId: `svc-user-${revokedGuard}`,
          messageChannel: "discord",
          nativeChannelId: `svc-${revokedGuard}`,
          memoryAudience: {
            kind: "conversation",
            agentId: "main",
            sessionKey,
            sessionId: `sess-svc-${revokedGuard}`,
          },
          assertInvocationCurrent() {
            if (patchRevoked && revokedGuard === "invocation") {
              throw new Error(expectedMessage);
            }
          },
          assertMemoryAudienceCurrent() {
            if (patchRevoked && revokedGuard === "audience") {
              throw new Error(expectedMessage);
            }
          },
        });

        await expect(
          toolsB
            .find((t) => t.name === "memory_recall")!
            .execute("svc-b", { query: "status" }),
        ).rejects.toThrow(expectedMessage);
        expect(updateBankSpy).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const onlyDispatchedRequest = fetchMock.mock.calls[0]?.[0] as Request;
        expect(onlyDispatchedRequest.method).toBe("PUT");
        expect(extractFetchUrl(onlyDispatchedRequest)).toContain(
          `/v1/default/banks/auth_test-svc-user-${revokedGuard}`,
        );
      } finally {
        await registeredService?.stop?.({
          config: {},
          logger: { info() {}, warn() {}, error() {} },
        });
        registeredService = undefined;
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["invocation", "audience"] as const)(
    "re-checks %s authority synchronously before capacity retry dispatches for memory_recall and memory_reflect",
    async (revokedGuard) => {
      const descriptor = registerPluginWithConfig();
      const sessionKey = `agent:main:discord:channel:retry-${revokedGuard}`;
      const expectedMessage =
        revokedGuard === "invocation"
          ? "invocation revoked before capacity retry"
          : "audience revoked before capacity retry";

      for (const toolName of ["memory_recall", "memory_reflect"] as const) {
        fetchMock.mockReset();
        let revokedAfterFirstAttempt = false;
        fetchMock.mockImplementation(async () => {
          // Schedule revocation after Attempt 1's response is returned to
          // `retryOnCapacity`, so Attempt 1 remains valid while Attempt 2 hits
          // the transport guard synchronously before dispatching fetch.
          setTimeout(() => {
            revokedAfterFirstAttempt = true;
          }, 0);
          return new Response(JSON.stringify({ detail: "at capacity" }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "0.02",
            },
          });
        });

        const tools = descriptor.create({
          agentId: "main",
          sessionKey,
          requesterSenderId: `retry-user-${revokedGuard}`,
          messageChannel: "discord",
          nativeChannelId: `retry-${revokedGuard}`,
          memoryAudience: {
            kind: "conversation",
            agentId: "main",
            sessionKey,
            sessionId: `sess-retry-${revokedGuard}`,
          },
          assertInvocationCurrent() {
            if (revokedAfterFirstAttempt && revokedGuard === "invocation") {
              throw new Error(expectedMessage);
            }
          },
          assertMemoryAudienceCurrent() {
            if (revokedAfterFirstAttempt && revokedGuard === "audience") {
              throw new Error(expectedMessage);
            }
          },
        });

        await expect(
          tools
            .find((t) => t.name === toolName)!
            .execute(`retry-${toolName}`, { query: "capacity check" }),
        ).rejects.toThrow(expectedMessage);

        // Attempt 1 dispatched prior to revocation; zero retry dispatches occurred after revocation.
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("preserves post-operation authority guards when authority is revoked while streaming the response body", async () => {
    const descriptor = registerPluginWithConfig();
    const sessionKey = "agent:main:discord:channel:body-stream";
    let audienceRevokedDuringBodyRead = false;

    // Revoke inside `pull()` so revocation occurs strictly during `response.text()`
    // after `guardedFetch` has returned the 200 OK `Response` headers.
    fetchMock.mockImplementationOnce(async () => {
      const encoder = new TextEncoder();
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            audienceRevokedDuringBodyRead = true;
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  results: [
                    {
                      id: "stream-1",
                      text: "SECRET_STREAMED_PAYLOAD",
                      type: "world",
                    },
                  ],
                }),
              ),
            );
            controller.close();
          }
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const tools = descriptor.create({
      agentId: "main",
      sessionKey,
      requesterSenderId: "stream-user",
      messageChannel: "discord",
      nativeChannelId: "body-stream",
      memoryAudience: {
        kind: "conversation",
        agentId: "main",
        sessionKey,
        sessionId: "sess-stream",
      },
      assertInvocationCurrent() {},
      assertMemoryAudienceCurrent() {
        if (audienceRevokedDuringBodyRead) {
          throw new Error("audience revoked while reading response body");
        }
      },
    });

    let caughtErr: unknown;
    try {
      await tools
        .find((t) => t.name === "memory_recall")!
        .execute("stream-call", { query: "streamed" });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(Error);
    expect((caughtErr as Error).message).toBe(
      "audience revoked while reading response body",
    );
    expect(String(caughtErr)).not.toContain("SECRET_STREAMED_PAYLOAD");
  });
});

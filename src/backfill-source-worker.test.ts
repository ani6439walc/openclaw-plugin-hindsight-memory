import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackfillWorkerService } from "./backfill-source-worker.js";
import { mirrorBackfillPath } from "./backfill-snapshot-config.js";
import type { BackfillSnapshotReader } from "./backfill-source.js";

vi.mock("./backfill-projection.js", () => {
  class BackfillProjectionError extends Error {
    constructor(public reason: string) {
      super("Invalid transcript");
    }
  }
  return {
    BackfillProjectionError,
    projectBackfillTranscript(events: unknown[], expected: string) {
      const header = events[0] as { type?: string; id?: string } | undefined;
      if (header?.type !== "session" || header.id !== expected)
        throw new BackfillProjectionError("missing-transcript");
      return events;
    },
  };
});

const environment = {
  OPENCLAW_STATE_DIR: "/synthetic/selected",
  OPENCLAW_CONFIG_PATH: "/synthetic/selected/openclaw.json",
};
const source = {
  kind: "sqlite" as const,
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  storePath: "/synthetic/logical/sessions.json",
  artifactKind: "active-session" as const,
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(snapshotMode = false, claimStore = true) {
  const root = await mkdtemp(join(tmpdir(), "hindsight-worker-test-"));
  roots.push(root);
  const snapshotPath = join(root, "snapshot.sqlite");
  const config = {
    agents: { ownership: "explicit", entries: { main: {}, other: {} } },
    session: { store: snapshotMode ? snapshotPath : source.storePath },
    privateSentinel: "never-copy",
    plugins: {
      entries: { "hindsight-memory": { config: { bankId: "selected" } } },
    },
  };
  const readConfigFileSnapshot = vi.fn(async () => ({
    exists: true,
    valid: true,
    config,
  }));
  const listAgentIds = vi.fn(() => ["main", "other"]);
  const normalizeAgentIdStrict = vi.fn((value: string) =>
    value === "../main"
      ? { ok: true, value: "main" }
      : value === "!!!"
        ? { ok: false, error: "unrepresentable" }
        : { ok: true, value },
  );
  const resolveStorePath = vi.fn((store?: string) => store ?? source.storePath);
  const resolveSessionStoreBackupPaths = vi.fn(() =>
    snapshotMode
      ? [snapshotPath, `${snapshotPath}-wal`, `${snapshotPath}-shm`]
      : [
          source.storePath,
          "/synthetic/physical/custom.db",
          "/synthetic/physical/custom.db-wal",
          "/synthetic/physical/custom.db-shm",
        ],
  );
  const corpus = vi.fn(async (): Promise<unknown> => []);
  const raw = vi.fn(async (): Promise<unknown> => [
    { type: "session", id: source.sessionId },
  ]);
  const loadModule = vi.fn(async (specifier: string): Promise<unknown> => {
    switch (specifier) {
      case "openclaw/plugin-sdk/health":
        return { readConfigFileSnapshot };
      case "openclaw/plugin-sdk/agent-scope-runtime":
        return { listAgentIds };
      case "openclaw/plugin-sdk/routing":
        return { normalizeAgentIdStrict };
      case "openclaw/plugin-sdk/session-store-runtime":
        return {
          resolveStorePath,
          resolveSessionStoreBackupPaths,
          loadTranscriptEvents: raw,
        };
      case "openclaw/plugin-sdk/memory-core-host-engine-sessions":
        return { listSessionTranscriptCorpusEntriesForAgent: corpus };
      case "openclaw/plugin-sdk/agent-sessions":
        return {
          SessionManager: class {
            static fromEntries() {
              return {};
            }
          },
          buildSessionContext: () => ({}),
        };
      default:
        throw Error("Unsupported module");
    }
  });
  const privateLogical = mirrorBackfillPath(root, source.storePath);
  const stateRoot = mirrorBackfillPath(root, environment.OPENCLAW_STATE_DIR);
  const inner: BackfillSnapshotReader = {
    selectStore: vi.fn(async () => ({ storePath: privateLogical })),
    prepare: vi.fn(async () => ({
      pluginConfig: {},
      agentIds: ["main", "other"],
    })),
    discover: vi.fn(async () => ({
      status: "available",
      sources: [{ ...source, storePath: privateLogical }],
    })),
    read: vi.fn(async () => ({
      status: "available",
      events: [{ type: "message" }],
    })),
    close: vi.fn(async () => {}),
  };
  const get = vi.fn(
    async (): Promise<
      | { status: "available"; root: string; storePath: string }
      | { status: "unavailable"; reason: string }
    > => ({ status: "available", root, storePath: snapshotPath }),
  );
  const materialize = vi.fn(async () =>
    mirrorBackfillPath(root, "/synthetic/physical/custom.db"),
  );
  const close = vi.fn(async () => {});
  const reader = vi.fn(() => inner);
  const selectedEnvironment = snapshotMode
    ? {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: join(root, "openclaw.json"),
        HINDSIGHT_BACKFILL_CONTAINER_ROOT: root,
      }
    : environment;
  if (snapshotMode)
    await writeFile(
      selectedEnvironment.OPENCLAW_CONFIG_PATH,
      JSON.stringify(config),
    );
  if (snapshotMode)
    await writeFile(snapshotPath, "private synthetic SQLite file");
  const service = createBackfillWorkerService(
    loadModule,
    selectedEnvironment,
    { snapshots: { get, materialize, close }, reader },
    snapshotMode,
  );
  if (snapshotMode && claimStore)
    await service.selectStore("main", snapshotPath);
  return {
    materialize,
    privateLogical,
    stateRoot,
    selectedEnvironment,
    normalizeAgentIdStrict,
    service,
    config,
    root,
    snapshotPath,
    loadModule,
    readConfigFileSnapshot,
    listAgentIds,
    resolveStorePath,
    resolveSessionStoreBackupPaths,
    corpus,
    raw,
    inner,
    get,
    close,
    reader,
  };
}

describe("stock backfill original-root worker", () => {
  it("prepares selected config once without importing nonexistent or source host readers", async () => {
    const f = await fixture();
    const before = { ...process.env };
    expect(await f.service.prepare()).toEqual({
      pluginConfig: { bankId: "selected" },
      agentIds: ["main", "other"],
    });
    await f.service.prepare();
    expect(f.readConfigFileSnapshot).toHaveBeenCalledExactlyOnceWith({
      observe: false,
      isolateEnv: true,
      pluginValidation: "core-only",
      recoverSuspicious: false,
    });
    expect(f.loadModule.mock.calls.map(([name]) => name).sort()).toEqual([
      "openclaw/plugin-sdk/agent-scope-runtime",
      "openclaw/plugin-sdk/health",
    ]);
    expect(process.env).toEqual(before);
    await f.service.close();
  });
  it("copies only the resolved physical database and maps corpus metadata back to original logical identity", async () => {
    const f = await fixture();
    expect(await f.service.discover("main", true)).toEqual({
      status: "available",
      sources: [source],
    });
    expect(f.get).toHaveBeenCalledWith("/synthetic/physical/custom.db");
    expect(f.resolveStorePath).toHaveBeenCalledWith(source.storePath, {
      agentId: "main",
      env: environment,
    });
    expect(f.resolveSessionStoreBackupPaths).toHaveBeenCalledWith({
      agentId: "main",
      storePath: source.storePath,
    });
    const scratchConfig = JSON.parse(
      await readFile(join(f.stateRoot, "openclaw.json"), "utf8"),
    );
    expect(scratchConfig).toEqual({
      agents: { ownership: "explicit", entries: { main: {}, other: {} } },
      session: { store: f.privateLogical },
    });
    expect(f.corpus).not.toHaveBeenCalled();
    expect(f.raw).not.toHaveBeenCalled();
    expect(await f.service.read(source)).toEqual({
      status: "available",
      events: [{ type: "message" }],
    });
    expect(f.inner.read).toHaveBeenCalledWith({
      ...source,
      storePath: f.privateLogical,
    });
    expect(f.inner.discover).toHaveBeenCalledOnce();
    await f.service.close();
    expect(f.inner.close).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("shares one physical snapshot reader for multiple agents without copying private configuration", async () => {
    const f = await fixture();
    vi.mocked(f.inner.discover).mockImplementation(async (agentId) => ({
      status: "available",
      sources: [{ ...source, agentId, storePath: f.privateLogical }],
    }));
    await f.service.discover("main", true);
    await f.service.discover("other", true);
    expect(f.reader).toHaveBeenCalledOnce();
    expect(f.inner.prepare).toHaveBeenCalledOnce();
    expect(
      await readFile(join(f.stateRoot, "openclaw.json"), "utf8"),
    ).not.toContain("never-copy");
    await f.service.close();
  });
  it("returns missing-store without original host reads so legacy scanning can continue", async () => {
    const f = await fixture();
    f.get.mockResolvedValue({ status: "unavailable", reason: "missing-store" });
    expect(await f.service.discover("main", true)).toEqual({
      status: "unavailable",
      reason: "missing-store",
    });
    expect(f.reader).not.toHaveBeenCalled();
    expect(f.corpus).not.toHaveBeenCalled();
    expect(f.raw).not.toHaveBeenCalled();
    await f.service.close();
  });
  it("fails closed on invalid config and ambiguous resolver families without copying or reading", async () => {
    const f = await fixture();
    f.resolveSessionStoreBackupPaths.mockReturnValue([source.storePath]);
    await expect(f.service.discover("main", true)).rejects.toThrow(
      /resolve.*SQLite/i,
    );
    expect(f.get).not.toHaveBeenCalled();
    await f.service.close();
    const invalid = await fixture();
    invalid.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: invalid.config,
    });
    await expect(invalid.service.prepare()).rejects.toThrow(
      "Selected OpenClaw config is missing or invalid",
    );
    await invalid.service.close();
  });
  it("resolves a requested retired agent without fabricating a configured roster identity", async () => {
    const f = await fixture();
    vi.mocked(f.inner.discover).mockResolvedValue({
      status: "available",
      sources: [
        { ...source, agentId: "retired-worker", storePath: f.privateLogical },
      ],
    });
    expect(await f.service.discover("retired-worker", true)).toEqual({
      status: "available",
      sources: [{ ...source, agentId: "retired-worker" }],
    });
    expect(f.resolveStorePath).toHaveBeenCalledWith(source.storePath, {
      agentId: "retired-worker",
      env: environment,
    });
    const config = JSON.parse(
      await readFile(join(f.stateRoot, "openclaw.json"), "utf8"),
    );
    expect(config.agents.entries).toEqual({
      main: {},
      other: {},
    });
    expect(config).not.toHaveProperty("privateSentinel");
    await f.service.close();
  });

  it("preserves sanitized child preparation errors with their isolation stage", async () => {
    const f = await fixture();
    vi.mocked(f.inner.prepare).mockRejectedValue(
      Error("Selected OpenClaw config is missing or invalid"),
    );
    await expect(f.service.discover("main", true)).rejects.toThrow(
      "OpenClaw snapshot reader preparation failed: Selected OpenClaw config is missing or invalid",
    );
    await f.service.close();
  });
  it("adds discovery/read stages while withholding native or source data errors", async () => {
    const f = await fixture();
    vi.mocked(f.inner.discover).mockRejectedValue(
      Error("Unsupported OpenClaw host: missing released corpus reader"),
    );
    await expect(f.service.discover("main", true)).rejects.toThrow(
      "OpenClaw snapshot reader discovery failed: Unsupported OpenClaw host: missing released corpus reader",
    );
    vi.mocked(f.inner.read).mockRejectedValue(
      Error("private transcript/source filesystem error"),
    );
    await expect(f.service.read(source)).rejects.toThrow(
      /^OpenClaw snapshot reader transcript read failed$/,
    );
    await f.service.close();
  });

  it("rejects original source substitution and noncanonical agent identities", async () => {
    const f = await fixture();
    await expect(
      f.service.read({ ...source, storePath: "/another/store" }),
    ).rejects.toThrow(/identity changed/);
    await expect(f.service.discover("../main", true)).rejects.toThrow(
      /invalid.*agent/i,
    );
    await expect(f.service.discover("!!!", true)).rejects.toThrow(
      /invalid.*agent/i,
    );
    expect(f.raw).not.toHaveBeenCalled();
    await f.service.close();
  });
});

describe("isolated stock snapshot reader", () => {
  it("uses the released corpus signature with readOnly and no revision reads", async () => {
    const f = await fixture(true);
    const selected = { ...source, storePath: f.snapshotPath };
    f.corpus.mockResolvedValue([
      { ...selected, transcriptSource: "sqlite" },
      { artifactKind: "archive-artifact" },
      {
        ...selected,
        sessionId: "retained",
        artifactKind: "retained-session",
        transcriptSource: "sqlite",
      },
    ]);
    expect(await f.service.discover("main", false)).toEqual({
      status: "available",
      sources: [selected],
    });
    expect(f.corpus).toHaveBeenCalledWith("main", {
      config: f.config,
      readOnly: true,
      includeRetainedSqlite: false,
      includeContentRevision: false,
    });
    expect(f.get).not.toHaveBeenCalled();
    await f.service.close();
  });
  it("allows a qualified retired agent without changing the original scratch roster", async () => {
    const f = await fixture(true);
    await f.service.selectStore("retired-worker", f.snapshotPath);
    expect(await f.service.discover("retired-worker", true)).toEqual({
      status: "available",
      sources: [],
    });
    expect(f.config.agents.entries).toEqual({ main: {}, other: {} });
    expect(f.readConfigFileSnapshot).toHaveBeenCalledOnce();
    expect(f.corpus).toHaveBeenCalledWith(
      "retired-worker",
      expect.objectContaining({ config: f.config }),
    );
    await f.service.close();
  });
  it("refuses unselected, missing, mismatching and escaped targets before any corpus/raw host read", async () => {
    const f = await fixture(true, false);
    await expect(f.service.discover("main", true)).rejects.toThrow(
      /not selected/,
    );
    await rm(f.snapshotPath);
    await expect(f.service.selectStore("main", f.snapshotPath)).rejects.toThrow(
      /missing or unavailable/,
    );
    await writeFile(f.snapshotPath, "private fixture");
    const other = join(f.root, "other.sqlite");
    f.resolveSessionStoreBackupPaths.mockReturnValue([
      other,
      `${other}-wal`,
      `${other}-shm`,
    ]);
    await expect(f.service.selectStore("main", f.snapshotPath)).rejects.toThrow(
      /does not match/,
    );
    await expect(
      f.service.selectStore("main", "/original/source.sqlite"),
    ).rejects.toThrow(/escaped/);
    expect(f.corpus).not.toHaveBeenCalled();
    expect(f.raw).not.toHaveBeenCalled();
    await f.service.close();
  });
  it("rechecks resolver custody before each corpus/raw call after a successful selection", async () => {
    const f = await fixture(true);
    const other = join(f.root, "other.sqlite");
    f.resolveSessionStoreBackupPaths.mockReturnValue([
      other,
      `${other}-wal`,
      `${other}-shm`,
    ]);
    await expect(f.service.discover("main", true)).rejects.toThrow(
      /does not match/,
    );
    await expect(
      f.service.read({ ...source, storePath: f.snapshotPath }),
    ).rejects.toThrow(/does not match/);
    expect(f.corpus).not.toHaveBeenCalled();
    expect(f.raw).not.toHaveBeenCalled();
    await f.service.close();
  });

  it("reads raw events through public SDK and returns projected records", async () => {
    const f = await fixture(true);
    const event = {
      type: "message",
      timestamp: "2026-11-12",
      message: { role: "user", content: "hello" },
    };
    f.raw.mockResolvedValue([{ type: "session", id: source.sessionId }, event]);
    expect(
      await f.service.read({ ...source, storePath: f.snapshotPath }),
    ).toEqual({
      status: "available",
      events: [{ type: "session", id: source.sessionId }, event],
    });
    expect(f.raw).toHaveBeenCalledWith({
      agentId: source.agentId,
      sessionId: source.sessionId,
      sessionKey: source.sessionKey,
      storePath: f.snapshotPath,
      env: f.selectedEnvironment,
    });
    await f.service.close();
  });
  it.each([
    { events: [] },
    { events: [{ type: "session", id: "wrong" }] },
    { events: [{ type: "message" }] },
  ])(
    "classifies absent original transcript header as missing, not empty (%j)",
    async ({ events }) => {
      const f = await fixture(true);
      f.raw.mockResolvedValue(events);
      expect(
        await f.service.read({ ...source, storePath: f.snapshotPath }),
      ).toEqual({ status: "unavailable", reason: "missing-transcript" });
      await f.service.close();
    },
  );
  it("accepts a matching header-only transcript as valid empty", async () => {
    const f = await fixture(true);
    expect(
      await f.service.read({ ...source, storePath: f.snapshotPath }),
    ).toEqual({
      status: "available",
      events: [{ type: "session", id: source.sessionId }],
    });
    await f.service.close();
  });
  it("fails closed on host read/cold restore errors without exposing contents or original fallback", async () => {
    const f = await fixture(true);
    f.raw.mockRejectedValue(Error("private transcript contents"));
    expect(
      await f.service.read({ ...source, storePath: f.snapshotPath }),
    ).toEqual({ status: "unavailable", reason: "unavailable" });
    expect(f.get).not.toHaveBeenCalled();
    await f.service.close();
  });
});

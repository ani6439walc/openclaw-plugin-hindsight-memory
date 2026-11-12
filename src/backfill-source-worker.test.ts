import { describe, expect, it, vi } from "vitest";
import { createBackfillWorkerService } from "./backfill-source-worker.js";

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

function fixture() {
  const config = {
    agents: { entries: { main: {}, other: {} } },
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
  const discover = vi.fn(async (): Promise<unknown> => ({
    status: "available",
    entries: [],
  }));
  const read = vi.fn(async (): Promise<unknown> => ({
    status: "available",
    events: [],
  }));
  const host: Record<string, unknown> = {
    listSessionTranscriptCorpusEntriesReadOnlyForAgent: discover,
    readSessionTranscriptSnapshotReadOnly: read,
  };
  const loadModule = vi.fn(async (specifier: string): Promise<unknown> => {
    if (specifier === "openclaw/plugin-sdk/health")
      return { readConfigFileSnapshot };
    if (specifier === "openclaw/plugin-sdk/agent-scope-runtime")
      return { listAgentIds };
    if (specifier === "openclaw/plugin-sdk/session-transcript-readonly")
      return host;
    throw new Error(`unexpected import ${specifier}`);
  });
  return {
    service: createBackfillWorkerService(loadModule, environment),
    config,
    host,
    loadModule,
    readConfigFileSnapshot,
    listAgentIds,
    discover,
    read,
  };
}

describe("isolated backfill host service", () => {
  it("prepares only the selected plugin config and public agent roster once", async () => {
    const f = fixture();
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
    expect(f.listAgentIds).toHaveBeenCalledExactlyOnceWith(f.config);
    expect(
      f.loadModule.mock.calls.map(([specifier]) => specifier).sort(),
    ).toEqual([
      "openclaw/plugin-sdk/agent-scope-runtime",
      "openclaw/plugin-sdk/health",
      "openclaw/plugin-sdk/session-transcript-readonly",
    ]);
    expect(process.env).toEqual(before);
  });

  it("rejects an old host instead of falling back to its writable corpus API", async () => {
    const f = fixture();
    delete f.host.listSessionTranscriptCorpusEntriesReadOnlyForAgent;
    const oldApi = vi.fn();
    f.host.listSessionTranscriptCorpusEntriesForAgent = oldApi;

    await expect(f.service.prepare()).rejects.toThrow(
      /unsupported OpenClaw host.*listSessionTranscriptCorpusEntriesReadOnlyForAgent/i,
    );
    expect(oldApi).not.toHaveBeenCalled();
    expect(f.readConfigFileSnapshot).not.toHaveBeenCalled();
  });

  it("reports a missing read-only public module without reading config", async () => {
    const f = fixture();
    f.loadModule.mockRejectedValue(
      new Error("synthetic module resolution failure"),
    );

    await expect(f.service.prepare()).rejects.toThrow(
      /unsupported OpenClaw host.*session-transcript-readonly/i,
    );
    expect(f.readConfigFileSnapshot).not.toHaveBeenCalled();
  });

  it("rejects invalid config without returning config contents", async () => {
    const f = fixture();
    f.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: { ...f.config, privateSentinel: "never-disclose" },
    });

    await expect(f.service.prepare()).rejects.toThrow(
      "Selected OpenClaw config is missing or invalid",
    );
    expect(f.discover).not.toHaveBeenCalled();
  });

  it("classifies SQLite rows and preserves their logical store identity", async () => {
    const f = fixture();
    const retained = {
      ...source,
      sessionId: "retained-1",
      artifactKind: "retained-session",
      updatedAtMs: 1234,
    };
    f.discover.mockResolvedValue({
      status: "available",
      entries: [
        { ...source, transcriptSource: "sqlite" },
        { ...retained, transcriptSource: "sqlite" },
        {
          artifactKind: "archive-artifact",
          sessionFile: "/synthetic/archive.jsonl",
        },
        {
          agentId: "main",
          artifactKind: "active-session",
          sessionId: "legacy",
        },
      ],
    });

    expect(await f.service.discover("main", true)).toEqual({
      status: "available",
      sources: [source, retained],
    });
    expect(f.discover).toHaveBeenCalledWith("main", {
      config: f.config,
      includeRetainedSqlite: true,
      includeContentRevision: false,
    });
    expect(await f.service.discover("main", false)).toEqual({
      status: "available",
      sources: [source],
    });
  });

  it.each([
    { agentId: "other" },
    { sessionId: "" },
    { storePath: undefined },
    { artifactKind: "unrecognized" },
  ])("rejects malformed SQLite identity %j", async (replacement) => {
    const f = fixture();
    f.discover.mockResolvedValue({
      status: "available",
      entries: [{ ...source, ...replacement, transcriptSource: "sqlite" }],
    });

    await expect(f.service.discover("main", true)).rejects.toThrow(
      /invalid.*corpus/i,
    );
  });

  it.each(["missing-store", "schema-unavailable", "refused", "unavailable"])(
    "preserves corpus refusal %s",
    async (reason) => {
      const f = fixture();
      f.discover.mockResolvedValue({
        status: "unavailable",
        reason,
        detail: "synthetic detail",
      });

      expect(await f.service.discover("main", true)).toEqual({
        status: "unavailable",
        reason,
        detail: "synthetic detail",
      });
    },
  );

  it("reads the host snapshot unchanged with selected-root environment", async () => {
    const f = fixture();
    const events = [
      {
        type: "message",
        timestamp: "2026-11-12T00:00:00Z",
        message: { role: "toolResult", content: [], toolCallId: "fixture" },
      },
    ];
    f.read.mockResolvedValue({ status: "available", events });

    expect(await f.service.read(source)).toEqual({
      status: "available",
      events,
    });
    expect(f.read).toHaveBeenCalledWith({
      agentId: source.agentId,
      sessionId: source.sessionId,
      sessionKey: source.sessionKey,
      storePath: source.storePath,
      env: environment,
    });
  });

  it.each([
    "missing-store",
    "missing-transcript",
    "schema-unavailable",
    "cold",
    "refused",
    "unavailable",
  ])("preserves snapshot refusal %s", async (reason) => {
    const f = fixture();
    f.read.mockResolvedValue({ status: "unavailable", reason });

    expect(await f.service.read(source)).toEqual({
      status: "unavailable",
      reason,
    });
  });
});

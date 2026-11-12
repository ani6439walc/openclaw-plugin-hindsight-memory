import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  BackfillSourceReader,
  SqliteBackfillSource,
} from "./backfill-source.js";

const calls = vi.hoisted(() => ({
  retain: vi.fn(async () => ({})),
  client: vi.fn(),
  server: vi.fn(),
}));
vi.mock("@vectorize-io/hindsight-client", () => ({
  HindsightClient: class {
    constructor() {
      calls.client();
    }
    retain = calls.retain;
  },
}));
vi.mock("@vectorize-io/hindsight-all", () => ({
  HindsightServer: class {
    constructor() {
      calls.server();
    }
  },
}));
import { runCli } from "./backfill.js";

const roots: string[] = [];
const sqliteSource: SqliteBackfillSource = {
  kind: "sqlite",
  agentId: "main",
  sessionId: "sqlite-session",
  sessionKey: "agent:main:discord:group:fixture",
  storePath: "/synthetic/main/sessions/sessions.json",
  artifactKind: "retained-session",
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "backfill-cli-sqlite-"));
  roots.push(root);
  const configPath = join(root, "openclaw.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      plugins: {
        entries: {
          "hindsight-memory": { config: { bankId: "raw-config-bank" } },
        },
      },
    }),
  );
  const reader = {
    prepare: vi.fn(async () => ({
      pluginConfig: {
        dynamicBankId: false,
        bankId: "prepared-bank",
        hindsightApiUrl: "http://fake-hindsight.invalid",
      },
      agentIds: ["main"],
    })),
    discover: vi.fn<BackfillSourceReader["discover"]>(
      async (_agent, includeRetained) => ({
        status: "available",
        sources: includeRetained ? [sqliteSource] : [],
      }),
    ),
    read: vi.fn<BackfillSourceReader["read"]>(async () => ({
      status: "available",
      events: [
        {
          type: "message",
          timestamp: "2026-11-12T00:00:00Z",
          message: { role: "user", content: "Remember the synthetic project." },
        },
      ],
    })),
    close: vi.fn(async () => {}),
  };
  return { root, configPath, reader };
}
beforeEach(() => {
  calls.retain.mockClear();
  calls.client.mockClear();
  calls.server.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("SQLite backfill CLI boundary", () => {
  it("dry-run uses prepared config and explicit retained choice without API or checkpoint writes", async () => {
    const { root, configPath, reader } = fixture();
    const before = readFileSync(configPath, "utf8");
    await runCli(
      [
        "--openclaw-root",
        root,
        "--include-retained-sqlite",
        "--dry-run",
        "--json",
      ],
      { createSourceReader: () => reader },
    );
    const output = vi
      .mocked(console.log)
      .mock.calls.map(([line]) => String(line));
    const summary = JSON.parse(output.at(-1)!);
    expect(summary).toMatchObject({
      dry_run: true,
      planned_sessions: 1,
      include_retained_sqlite: true,
    });
    expect(output.join("\n")).toContain("prepared-bank");
    expect(calls.client).not.toHaveBeenCalled();
    expect(calls.server).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      existsSync(join(root, "data", "hindsight-backfill-checkpoint.json")),
    ).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(reader.close).toHaveBeenCalledOnce();
  });

  it("refuses partial source plans before Hindsight initialization and closes the reader", async () => {
    const { root, reader } = fixture();
    reader.read.mockResolvedValue({ status: "unavailable", reason: "cold" });
    await expect(
      runCli(["--openclaw-root", root, "--include-retained-sqlite"], {
        createSourceReader: () => reader,
      }),
    ).rejects.toThrow(/cold/);
    expect(calls.client).not.toHaveBeenCalled();
    expect(calls.server).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(reader.close).toHaveBeenCalledOnce();
  });

  it("refuses a limited session's conflicting JSONL copy before any Hindsight initialization", async () => {
    const { root, reader } = fixture();
    const sessions = join(root, "agents", "main", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "sqlite-session.jsonl"),
      [
        {
          type: "session",
          id: "sqlite-session",
          sessionKey: sqliteSource.sessionKey,
        },
        {
          type: "message",
          message: { role: "user", content: "Conflicting legacy content." },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    await expect(
      runCli(
        ["--openclaw-root", root, "--include-retained-sqlite", "--limit", "1"],
        { createSourceReader: () => reader },
      ),
    ).rejects.toThrow(/conflict/i);
    expect(calls.client).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(reader.close).toHaveBeenCalledOnce();
  });

  it("retains SQLite provenance without a fake file_path and persists a v1 checkpoint", async () => {
    const { root, reader } = fixture();
    await runCli(["--openclaw-root", root, "--include-retained-sqlite"], {
      createSourceReader: () => reader,
    });
    expect(calls.retain).toHaveBeenCalledOnce();
    const [bank, transcript, request] = calls.retain.mock.calls[0];
    expect(bank).toBe("prepared-bank");
    expect(transcript).toContain("synthetic project");
    expect(request).toMatchObject({
      documentId: "backfill::prepared-bank::main::sqlite-session",
      metadata: {
        source: "openclaw-backfill",
        transcript_source: "sqlite",
        store_path: sqliteSource.storePath,
      },
    });
    expect(request.metadata).not.toHaveProperty("file_path");
    const checkpoint = JSON.parse(
      readFileSync(
        join(root, "data", "hindsight-backfill-checkpoint.json"),
        "utf8",
      ),
    );
    expect(checkpoint.version).toBe(1);
    expect(
      checkpoint.entries[
        "prepared-bank::backfill::prepared-bank::main::sqlite-session"
      ],
    ).toMatchObject({ status: "enqueued", source: sqliteSource });
  });

  it("resumes completed v1 SQLite entries without duplicate retain requests", async () => {
    const { root, reader } = fixture();
    const checkpoint = join(root, "checkpoint.json");
    writeFileSync(
      checkpoint,
      JSON.stringify({
        version: 1,
        entries: {
          "prepared-bank::backfill::prepared-bank::main::sqlite-session": {
            status: "completed",
            bankId: "prepared-bank",
            sessionId: "sqlite-session",
            source: sqliteSource,
            updatedAt: "2026-11-12T00:00:00Z",
          },
        },
      }),
    );
    await runCli(
      [
        "--openclaw-root",
        root,
        "--include-retained-sqlite",
        "--resume",
        "--checkpoint",
        checkpoint,
      ],
      { createSourceReader: () => reader },
    );
    expect(calls.retain).not.toHaveBeenCalled();
    expect(reader.close).toHaveBeenCalledOnce();
  });
});

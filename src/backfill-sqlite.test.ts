import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBackfillPlan } from "./backfill-lib.js";

const roots: string[] = [];
const config = { dynamicBankId: false, bankId: "test-bank" };
const alice = { id: "alice-id", name: "Alice", username: "alice" };
const bob = { id: "bob-id", name: "Bob", username: "bob" };

function root() {
  const directory = mkdtempSync(join(tmpdir(), "backfill-sqlite-"));
  roots.push(directory);
  return directory;
}

function source(sessionId = "session-1", agentId = "main") {
  return {
    kind: "sqlite" as const,
    agentId,
    sessionId,
    sessionKey: `agent:${agentId}:discord:group:test`,
    storePath: `/synthetic/${agentId}/sessions/sessions.json`,
    artifactKind: "active-session" as "active-session" | "retained-session",
  };
}

function message(content: string, sender?: unknown) {
  return {
    type: "message",
    timestamp: "2026-11-12T00:00:00.000Z",
    message: {
      role: "user",
      content: sender
        ? `Conversation info: ⟦openclaw:ctx⟧\n${JSON.stringify({ sender, chat_id: "discard-chat" })}\n\n${content}`
        : content,
    },
  };
}

function reader(
  sources = [source()],
  events: unknown[] = [message("I cancelled my subscription.", alice)],
) {
  return {
    prepare: vi.fn(async () => ({
      pluginConfig: config,
      agentIds: ["main", "other"],
    })),
    discover: vi.fn(async (agentId: string, includeRetained: boolean) => ({
      status: "available" as const,
      sources: sources.filter(
        (entry) =>
          entry.agentId === agentId &&
          (includeRetained || entry.artifactKind === "active-session"),
      ),
    })),
    read: vi.fn(async () => ({ status: "available" as const, events })),
    close: vi.fn(async () => {}),
  };
}

function options(openclawRoot: string) {
  return {
    openclawRoot,
    includeArchive: false,
    bankStrategy: "mirror-config" as const,
  };
}

function jsonl(directory: string, sessionId: string, events: unknown[]) {
  const folder = join(directory, "agents", "main", "sessions");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, `${sessionId}.jsonl`),
    [
      {
        type: "session",
        id: sessionId,
        sessionKey: source(sessionId).sessionKey,
      },
      ...events,
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
}

afterEach(() => {
  for (const directory of roots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("SQLite-aware backfill planning", () => {
  it("plans an active SQLite transcript without a JSONL file and keeps logical source identity", async () => {
    const host = reader();
    const plan = await buildBackfillPlan(config, options(root()), host);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      agentId: "main",
      sessionId: "session-1",
      bankId: "test-bank",
      documentId: "backfill::test-bank::main::session-1",
      source: source(),
    });
    expect(plan.entries[0].filePath).toBeUndefined();
    expect(JSON.parse(plan.entries[0].transcript)[0]).toMatchObject({
      sender: alice,
      timestamp: "2026-11-12T00:00:00.000Z",
    });
    expect(plan.entries[0].transcript).not.toContain("discard-chat");
  });

  it("keeps retained SQLite an explicit choice independent of migration JSONL archives", async () => {
    const retained = {
      ...source("retained"),
      artifactKind: "retained-session" as const,
    };
    const host = reader([retained]);
    const openclawRoot = root();
    expect(
      (
        await buildBackfillPlan(
          config,
          { ...options(openclawRoot), includeArchive: true },
          host,
        )
      ).entries,
    ).toHaveLength(0);
    expect(
      (
        await buildBackfillPlan(
          config,
          { ...options(openclawRoot), includeRetainedSqlite: true },
          host,
        )
      ).entries,
    ).toHaveLength(1);
    expect(host.discover).toHaveBeenCalledWith("main", true);
  });

  it("preserves tool linkage, provenance filtering, event time and distinct speakers", async () => {
    const host = reader(
      [source()],
      [
        message("Read my subscription status.", alice),
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "read-1",
                name: "read",
                arguments: { path: "synthetic" },
              },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "read-1",
            toolName: "read",
            content: [{ type: "text", text: "Cancelled." }],
          },
        },
        {
          type: "message",
          message: {
            role: "user",
            inputProvenance: {
              kind: "inter_session",
              sourceChannel: "internal",
            },
            content: "Internal settlement to omit.",
          },
        },
        {
          type: "message",
          message: { role: "assistant", content: "Internal response to omit." },
        },
        message("Mine is still active.", bob),
        message("My sender is unavailable."),
      ],
    );
    const plan = await buildBackfillPlan(config, options(root()), host);
    expect(plan.entries).toHaveLength(1);
    const transcript = plan.entries[0].transcript;
    const messages = JSON.parse(transcript);
    expect(messages[0].sender).toEqual(alice);
    expect(
      messages.find(
        (entry: { sender?: { id?: string } }) => entry.sender?.id === bob.id,
      )?.sender,
    ).toEqual(bob);
    expect(messages.at(-1)).not.toHaveProperty("sender");
    expect(transcript).toContain('"tool_use_id":"read-1"');
    expect(transcript).toContain('"type":"tool_use"');
    expect(transcript).toContain('"type":"tool_result"');
    expect(transcript).not.toContain("Internal settlement");
    expect(transcript).not.toContain("Internal response");
  });

  it("deduplicates equal JSONL and SQLite copies without changing document identity", async () => {
    const directory = root();
    const events = [message("I cancelled my subscription.", alice)];
    jsonl(directory, "session-1", events);
    const plan = await buildBackfillPlan(
      config,
      options(directory),
      reader([source()], events),
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].documentId).toBe(
      "backfill::test-bank::main::session-1",
    );
    expect(plan.entries[0].source.kind).toBe("sqlite");
    expect(plan.duplicateSources).toBe(1);
  });

  it("keeps raw nullable blocks usable in text-only retention", async () => {
    const host = reader(
      [source()],
      [
        {
          type: "message",
          message: {
            role: "user",
            content: [
              null,
              { type: "text", text: "Remember the synthetic project." },
            ],
          },
        },
      ],
    );
    const plan = await buildBackfillPlan(
      { ...config, retainToolCalls: false },
      options(root()),
      host,
    );
    expect(JSON.parse(plan.entries[0].transcript)[0].content).toBe(
      "Remember the synthetic project.",
    );
  });

  it("refuses conflicting copies instead of silently choosing stale content", async () => {
    const directory = root();
    jsonl(directory, "session-1", [message("A conflicting legacy copy.")]);
    await expect(
      Promise.resolve(buildBackfillPlan(config, options(directory), reader())),
    ).rejects.toThrow(/conflict/i);
  });

  it.each([false, true])(
    "checks all copies of the selected session with limit=1 (conflict=%s)",
    async (conflict) => {
      const directory = root();
      jsonl(directory, "session-1", [
        message(
          conflict
            ? "A conflicting legacy copy."
            : "I cancelled my subscription.",
          alice,
        ),
      ]);
      const plan = buildBackfillPlan(
        config,
        { ...options(directory), limit: 1 },
        reader(),
      );
      if (conflict) await expect(plan).rejects.toThrow(/conflict/i);
      else {
        const result = await plan;
        expect(result.entries).toHaveLength(1);
        expect(result.duplicateSources).toBe(1);
      }
    },
  );

  it.each(["cold", "schema-unavailable", "refused", "missing-transcript"])(
    "fails an incomplete plan for %s rather than counting it empty",
    async (reason) => {
      const host = {
        ...reader(),
        read: vi.fn(async () => ({ status: "unavailable" as const, reason })),
      };
      await expect(
        Promise.resolve(buildBackfillPlan(config, options(root()), host)),
      ).rejects.toThrow(new RegExp(reason));
    },
  );

  it("distinguishes missing stores from successfully empty transcripts", async () => {
    const host = reader([], []);
    host.discover.mockImplementation(async () => ({
      status: "unavailable",
      reason: "missing-store",
    }));
    const absent = await buildBackfillPlan(config, options(root()), host);
    expect(absent.entries).toHaveLength(0);
    expect(absent.missingStores).toBe(2);
    expect(absent.skippedEmpty).toBe(0);
    const empty = await buildBackfillPlan(
      config,
      options(root()),
      reader([source()], []),
    );
    expect(empty.entries).toHaveLength(0);
    expect(empty.skippedEmpty).toBe(1);
  });

  it("restricts host discovery before reading and applies a deterministic logical-session limit", async () => {
    const host = reader([
      source("z"),
      source("a"),
      source("other-session", "other"),
    ]);
    const plan = await buildBackfillPlan(
      config,
      { ...options(root()), selectedAgents: new Set(["main"]), limit: 1 },
      host,
    );
    expect(host.discover.mock.calls).toEqual([["main", false]]);
    expect(plan.entries.map((entry) => entry.sessionId)).toEqual(["a"]);
    expect(host.read).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildBackfillPlan,
  loadPluginConfigFromOpenClawRoot,
  stableDocumentId,
} from "./backfill-lib.js";

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "hindsight-memory-backfill-"));
  tempDirs.push(dir);
  return dir;
}

function writeOpenClawConfig(root: string, config: Record<string, unknown>) {
  writeFileSync(join(root, "openclaw.json"), JSON.stringify(config, null, 2));
}

function writeSession(
  root: string,
  agentId: string,
  fileName: string,
  lines: unknown[],
  archive = false,
) {
  const dir = archive
    ? join(root, "agents", agentId, "sessions-archive-from-migration_backup")
    : join(root, "agents", agentId, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, fileName),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("backfill planning", () => {
  it("preserves each message's Conversation info sender in backfill content", () => {
    const root = makeTempRoot();
    const message = (sender: Record<string, string>, text: string) => ({
      type: "message",
      message: {
        role: "user",
        content: `Conversation info: ⟦openclaw:ctx⟧\n\`\`\`json\n${JSON.stringify({ sender, chat_id: "discard-chat" })}\n\`\`\`\n\n${text}`,
      },
    });
    const alice = { id: "alice-id", name: "Alice", username: "alice" };
    const bob = { id: "bob-id", name: "Bob", username: "bob" };
    writeSession(root, "main", "speakers.jsonl", [
      {
        type: "session",
        id: "speakers",
        sessionKey: "agent:main:discord:group:test",
      },
      message(alice, "I cancelled my subscription."),
      message(bob, "Mine is still active."),
      {
        type: "message",
        message: { role: "user", content: "My sender is unavailable." },
      },
    ]);

    const result = buildBackfillPlan(
      { dynamicBankId: false, bankId: "test" },
      {
        openclawRoot: root,
        includeArchive: false,
        bankStrategy: "mirror-config",
      },
    );

    expect(result.entries).toHaveLength(1);
    const retained = JSON.parse(result.entries[0].transcript);
    expect(retained.map((entry: { sender?: unknown }) => entry.sender)).toEqual(
      [alice, bob, undefined],
    );
    expect(result.entries[0].transcript).not.toContain("discard-chat");
  });

  it("mirrors plugin bank routing from config by default", () => {
    const root = makeTempRoot();
    writeOpenClawConfig(root, {
      plugins: {
        entries: {
          "hindsight-memory": {
            config: {
              dynamicBankId: true,
              dynamicBankGranularity: ["agent", "provider", "channel"],
            },
          },
        },
      },
    });
    writeSession(root, "proj-run", "one.jsonl", [
      {
        type: "session",
        id: "session-1",
        sessionKey: "agent:proj-run:discord:channel:123",
      },
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "assistant", content: "world" } },
    ]);

    const config = loadPluginConfigFromOpenClawRoot(root);
    const result = buildBackfillPlan(config, {
      openclawRoot: root,
      includeArchive: true,
      bankStrategy: "mirror-config",
    });

    expect(result.discoveredSessions).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].bankId).toBe("proj-run::discord::channel%3A123");
    expect(result.entries[0].documentId).toBe(
      stableDocumentId(
        {
          filePath: result.entries[0].filePath,
          agentId: "proj-run",
          sessionId: "session-1",
          sessionKey: "agent:proj-run:discord:channel:123",
          messages: [],
        },
        result.entries[0].bankId,
      ),
    );
  });

  it("supports migration overrides for agent-only banks", () => {
    const root = makeTempRoot();
    writeOpenClawConfig(root, {
      plugins: { entries: { "hindsight-memory": { config: {} } } },
    });
    writeSession(root, "proj-debug", "two.jsonl", [
      {
        type: "session",
        id: "session-2",
        sessionKey: "agent:proj-debug:discord:group:abc",
      },
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "assistant", content: "world" } },
    ]);

    const config = loadPluginConfigFromOpenClawRoot(root);
    const result = buildBackfillPlan(config, {
      openclawRoot: root,
      includeArchive: true,
      bankStrategy: "agent",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].bankId).toBe("proj-debug");
  });

  it("can exclude archive sessions", () => {
    const root = makeTempRoot();
    writeOpenClawConfig(root, {
      plugins: { entries: { "hindsight-memory": { config: {} } } },
    });
    writeSession(root, "main", "live.jsonl", [
      { type: "session", id: "live" },
      { type: "message", message: { role: "user", content: "live" } },
      { type: "message", message: { role: "assistant", content: "reply" } },
    ]);
    writeSession(
      root,
      "main",
      "archive.jsonl",
      [
        { type: "session", id: "archive" },
        { type: "message", message: { role: "user", content: "archived" } },
        { type: "message", message: { role: "assistant", content: "reply" } },
      ],
      true,
    );

    const config = loadPluginConfigFromOpenClawRoot(root);
    const result = buildBackfillPlan(config, {
      openclawRoot: root,
      includeArchive: false,
      bankStrategy: "mirror-config",
    });

    expect(result.discoveredSessions).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].sessionId).toBe("live");
  });
});

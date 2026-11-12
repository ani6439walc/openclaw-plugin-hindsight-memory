import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionFile, readSessionFileIdentity } from "./session-file.js";

const temporaryDirectories: string[] = [];

function transcript(records: unknown[]): string {
  const directory = mkdtempSync(join(tmpdir(), "hindsight-session-file-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "filename-session.jsonl");
  writeFileSync(
    filePath,
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  return filePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseSessionFile", () => {
  it("reports missing and malformed identity sources instead of returning an empty identity", async () => {
    const filePath = transcript([{ type: "session", id: "logical-session" }]);
    await expect(readSessionFileIdentity(filePath, "main")).resolves.toEqual({
      agentId: "main",
      sessionId: "logical-session",
    });
    await expect(
      readSessionFileIdentity(`${filePath}.missing`, "main"),
    ).rejects.toThrow();
    writeFileSync(filePath, "not valid JSONL");
    await expect(readSessionFileIdentity(filePath, "main")).rejects.toThrow();
  });
  it("preserves raw message fields and structured content without flattening", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Review this image", annotations: ["source"] },
          { type: "image", data: "synthetic-image", mimeType: "image/png" },
          null,
        ],
        timestamp: 1794441600000,
        trigger: "heartbeat",
        inputProvenance: {
          kind: "internal",
          sourceSessionKey: "agent:main:cron:job",
        },
        provenance: { kind: "inter_session", sourceRole: "assistant" },
        customMetadata: { origin: "fixture" },
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Inspect the fixture",
            signature: "synthetic",
          },
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "fixture" },
          },
        ],
        timestamp: "2026-11-12T00:00:01.000Z",
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "fixture result" }],
        toolCallId: "call-1",
        toolName: "read",
        details: { exitCode: 0 },
        isError: false,
        timestamp: 1794441602000,
      },
      { role: "system", content: "system context", timestamp: 1794441603000 },
      {
        role: "tool",
        content: "legacy tool result",
        tool_call_id: "legacy-1",
        timestamp: 1794441604000,
      },
    ];
    const filePath = transcript(
      messages.map((message) => ({ type: "message", message })),
    );

    expect(parseSessionFile(filePath, "main").messages).toEqual(messages);
  });

  it("uses only an actual event timestamp when the message timestamp is absent", () => {
    const messages = [
      { role: "user", content: "own timestamp", timestamp: 0 },
      { role: "assistant", content: "event timestamp" },
      { role: "user", content: "unknown time" },
      { role: "assistant", content: "explicit null", timestamp: null },
    ];
    const filePath = transcript([
      {
        type: "session",
        id: "header-id",
        timestamp: "2026-11-12T00:00:00.000Z",
      },
      {
        type: "message",
        timestamp: "2026-11-12T00:00:01.000Z",
        message: messages[0],
      },
      {
        type: "message",
        timestamp: "2026-11-12T00:00:02.000Z",
        message: messages[1],
      },
      { type: "message", message: messages[2] },
      {
        type: "message",
        timestamp: "2026-11-12T00:00:04.000Z",
        message: messages[3],
      },
    ]);

    expect(parseSessionFile(filePath, "main").messages).toEqual([
      messages[0],
      { ...messages[1], timestamp: "2026-11-12T00:00:02.000Z" },
      messages[2],
      messages[3],
    ]);
  });

  it("preserves session header identity and metadata", () => {
    const filePath = transcript([
      {
        type: "session",
        id: "header-id",
        sessionKey: "agent:main:header",
        timestamp: "2026-11-12T00:00:00.000Z",
      },
      {
        type: "message",
        sessionKey: "agent:main:other",
        message: { role: "user", content: "hello" },
      },
    ]);

    expect(parseSessionFile(filePath, "main")).toEqual({
      filePath,
      agentId: "main",
      sessionId: "header-id",
      sessionKey: "agent:main:header",
      startedAt: "2026-11-12T00:00:00.000Z",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("keeps filename and message session-key fallbacks without inventing a start time", () => {
    const filePath = transcript([
      { type: "custom", data: "ignored" },
      { type: "message", message: { role: "unknown", content: "ignored" } },
      {
        type: "message",
        sessionKey: "agent:main:fallback",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-only", name: "test", arguments: {} },
          ],
        },
      },
    ]);

    expect(parseSessionFile(filePath, "main")).toMatchObject({
      sessionId: "filename-session",
      sessionKey: "agent:main:fallback",
      startedAt: undefined,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-only", name: "test", arguments: {} },
          ],
        },
      ],
    });
  });
});

// The OpenClaw transcript on disk, and the reader for it.
//
// Lifted out of `backfill-lib.ts` so the plugin can read a transcript without
// importing that module: `backfill-lib` imports `./index.js`, and having index
// import it back would make the cycle load-order dependent. The parsing is
// shared with the JSONL backfill source; `backfill-lib` re-exports its surface.
import { createReadStream, readFileSync } from "fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import type { OpenClawMessage } from "./types.js";

export interface SessionMessage extends OpenClawMessage {
  role: "user" | "assistant" | "system" | "tool" | "toolResult";
}

export interface ParsedSessionTranscript {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  startedAt?: string;
  messages: SessionMessage[];
}

export interface ParsedSessionFile extends ParsedSessionTranscript {
  filePath: string;
}

/** Resolve logical identity without loading every transcript's message window. */
export async function readSessionFileIdentity(
  filePath: string,
  agentId: string,
): Promise<{ agentId: string; sessionId: string }> {
  const sessionId = basename(filePath).replace(/\.jsonl$/, "") || "session";
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const record: unknown = JSON.parse(line);
      if (
        record &&
        typeof record === "object" &&
        "type" in record &&
        record.type === "session"
      ) {
        return {
          agentId,
          sessionId:
            "id" in record && typeof record.id === "string"
              ? record.id
              : sessionId,
        };
      }
    }
    return { agentId, sessionId };
  } finally {
    lines.close();
    input.destroy();
  }
}

function readJsonLines(filePath: string): unknown[] {
  const content = readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function parseSessionFile(
  filePath: string,
  agentId: string,
): ParsedSessionFile {
  const sessionId =
    filePath
      .split("/")
      .pop()
      ?.replace(/\.jsonl$/, "") || "session";
  return {
    filePath,
    ...parseSessionRecords(readJsonLines(filePath), { agentId, sessionId }),
  };
}

/** Share raw event handling between legacy JSONL and host-owned snapshots. */
export function parseSessionRecords(
  records: readonly unknown[],
  identity: { agentId: string; sessionId: string; sessionKey?: string },
): ParsedSessionTranscript {
  const { agentId } = identity;
  let { sessionId, sessionKey } = identity;
  let startedAt: string | undefined;
  const messages: SessionMessage[] = [];

  for (const value of records) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.type === "session") {
      sessionId = typeof record.id === "string" ? record.id : sessionId;
      startedAt =
        typeof record.timestamp === "string" ? record.timestamp : startedAt;
      sessionKey =
        typeof record.sessionKey === "string" ? record.sessionKey : sessionKey;
      continue;
    }
    if (
      record.type !== "message" ||
      !record.message ||
      typeof record.message !== "object" ||
      Array.isArray(record.message)
    ) {
      continue;
    }
    const message = record.message as Record<string, unknown>;
    const role = message.role;
    if (
      role !== "user" &&
      role !== "assistant" &&
      role !== "system" &&
      role !== "tool" &&
      role !== "toolResult"
    ) {
      continue;
    }
    // Preserve provenance, tool links and non-text blocks for the shared
    // retention pipeline. Text projection here loses classification evidence.
    const parsedMessage = { ...message, role } as SessionMessage;
    if (
      !("timestamp" in message) &&
      (typeof record.timestamp === "string" ||
        typeof record.timestamp === "number")
    ) {
      parsedMessage.timestamp = record.timestamp;
    }
    messages.push(parsedMessage);
    if (!sessionKey && typeof record.sessionKey === "string") {
      sessionKey = record.sessionKey;
    }
  }

  return {
    agentId,
    sessionId,
    sessionKey,
    startedAt,
    messages,
  };
}

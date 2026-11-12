import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackfillProjectionError,
  projectBackfillTranscript,
  type BackfillProjectionHost,
} from "./backfill-projection.js";

let host: BackfillProjectionHost;
const root = mkdtempSync(join(tmpdir(), "hindsight-projection-"));

beforeAll(async () => {
  vi.stubEnv("HOME", root);
  vi.stubEnv("OPENCLAW_HOME", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", join(root, "openclaw.json"));
  host = await import("openclaw/plugin-sdk/agent-sessions");
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const header = { type: "session", id: "projection", version: 3 };
const message = (
  id: string,
  parentId: string | null,
  body: Record<string, unknown>,
) => ({ type: "message", id, parentId, message: body });
const user = (id: string, parentId: string | null) =>
  message(id, parentId, { role: "user", content: id });

describe("stock public transcript projection", () => {
  it("preserves the original session header and recorded start time", () => {
    const datedHeader = { ...header, timestamp: "2026-11-12T00:00:00.000Z" };
    const first = user("first", null);
    expect(
      projectBackfillTranscript([datedHeader, first], "projection", host),
    ).toEqual([datedHeader, first]);
  });

  it("follows canonical leaf controls and preserves original envelopes", () => {
    const answer = message("answer", "first", {
      role: "assistant",
      content: [{ type: "text", text: "original" }],
      timestamp: 0,
      provenance: { kind: "synthetic" },
    });
    const raw = [
      header,
      user("first", null),
      answer,
      { ...user("side", "first"), appendMode: "side" },
      { type: "leaf", id: "leaf", parentId: "side", targetId: "answer" },
    ];
    const before = JSON.stringify(raw);
    expect(projectBackfillTranscript(raw, "projection", host)).toEqual([
      header,
      raw[1],
      answer,
    ]);
    expect(projectBackfillTranscript(raw, "projection", host)[2]).toBe(answer);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each([false, true])(
    "retains reset-kept tool pairs and raw post-reset history across compaction=%s",
    (compacted) => {
      const call = message("call", "ask", {
        role: "assistant",
        content: [
          { type: "toolCall", id: "read-1", name: "read", arguments: {} },
        ],
        __openclaw: { preserved: "original" },
      });
      const result = {
        ...message("result", "call", {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "result" }],
          __openclaw: { resultContentSource: "network" },
        }),
        timestamp: "2026-11-12T01:02:03.000Z",
      };
      const raw = [
        header,
        user("old", null),
        user("ask", "old"),
        call,
        result,
        message("orphan", "result", {
          role: "toolResult",
          toolCallId: "absent-call",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "must not be retained" }],
        }),
        {
          type: "reset",
          id: "reset",
          parentId: "orphan",
          reason: "reset",
          firstKeptEntryId: "ask",
        },
        user("after", "reset"),
        ...(compacted
          ? [
              {
                type: "compaction",
                id: "compact",
                parentId: "after",
                firstKeptEntryId: "after",
                summary: "synthetic summary",
                tokensBefore: 0,
              },
            ]
          : []),
        user("last", compacted ? "compact" : "after"),
      ];
      const before = JSON.stringify(raw);
      const projected = projectBackfillTranscript(raw, "projection", host);
      expect(projected).toEqual([
        header,
        raw[2],
        call,
        result,
        raw[7],
        raw.at(-1),
      ]);
      expect(projected[2]).toBe(call);
      expect(projected[3]).toBe(result);
      expect(Object.getOwnPropertySymbols(call.message)).toEqual([]);
      expect(Object.getOwnPropertySymbols(result.message)).toEqual([]);
      expect(JSON.stringify(raw)).toBe(before);
      expect(JSON.stringify(projected)).not.toContain("absent-call");
    },
  );

  it("retains context-excluded raw messages after the reset", () => {
    const after = message("after", "reset", {
      role: "assistant",
      content: "recorded history",
      excludeFromContext: true,
    });
    expect(
      projectBackfillTranscript(
        [
          header,
          user("old", null),
          { type: "reset", id: "reset", parentId: "old", reason: "reset" },
          after,
        ],
        "projection",
        host,
      ),
    ).toEqual([header, after]);
  });

  it("distinguishes an original header-only transcript from a missing transcript", () => {
    expect(projectBackfillTranscript([header], "projection", host)).toEqual([
      header,
    ]);
    for (const raw of [
      [],
      [user("missing-header", null)],
      [{ ...header, id: "different" }],
    ]) {
      expect(() => projectBackfillTranscript(raw, "projection", host)).toThrow(
        BackfillProjectionError,
      );
      try {
        projectBackfillTranscript(raw, "projection", host);
      } catch (error) {
        expect(error).toMatchObject({ reason: "missing-transcript" });
      }
    }
  });

  it.each([
    { type: "reset", id: "invalid", parentId: null },
    message("invalid", null, {
      role: "toolResult",
      content: "private-sentinel",
    }),
  ])(
    "fails closed when the host cannot index a recorded message or reset",
    (entry) => {
      expect(() =>
        projectBackfillTranscript([header, entry], "projection", host),
      ).toThrow(BackfillProjectionError);
      try {
        projectBackfillTranscript([header, entry], "projection", host);
      } catch (error) {
        expect(error).toMatchObject({ reason: "invalid-transcript" });
        expect(String(error)).not.toContain("private-sentinel");
      }
    },
  );
});

import { describe, expect, it } from "vitest";
import {
  composeRecallQuery,
  extractRecallQuery,
  prepareRetentionTranscript,
  stripMemoryTags,
} from "./index.js";

const injectedContext = [
  "<hindsight_memory_plugin>Old recalled preference</hindsight_memory_plugin>",
  '<skill_harness_plugin><matched_skills><skill name="old-skill">Old skill guidance</skill></matched_skills></skill_harness_plugin>',
  "Context:\n<active_memory_plugin>Old native memory</active_memory_plugin>",
].join("\n");

describe("plugin context sanitization", () => {
  it("removes repeated plugin blocks while preserving surrounding text", () => {
    const text = `Before\n${injectedContext}\nBetween\n${injectedContext}\nAfter`;
    const cleaned = stripMemoryTags(text);

    expect(cleaned.replace(/\s+/g, " ").trim()).toBe("Before Between After");
    expect(stripMemoryTags(cleaned)).toBe(cleaned);
  });

  it("preserves ordinary text and unrelated XML", () => {
    const text =
      "Discuss skill_harness_plugin and <project>database</project>.";
    expect(stripMemoryTags(text)).toBe(text);
  });

  it.each(["current", "legacy"])(
    "cleans injected context from the %s recall input",
    (source) => {
      const text = `${injectedContext}\nWhat did we decide about the database?`;
      expect(
        source === "current"
          ? extractRecallQuery(text, undefined)
          : extractRecallQuery(undefined, text),
      ).toBe("What did we decide about the database?");
    },
  );

  it.each(["current", "legacy"])(
    "skips a %s recall input containing only injected context",
    (source) => {
      expect(
        source === "current"
          ? extractRecallQuery(injectedContext, undefined)
          : extractRecallQuery(undefined, injectedContext),
      ).toBeNull();
    },
  );

  it("cleans prior recall turns in string and block-array messages without mutating them", () => {
    const messages = [
      { role: "user", content: `${injectedContext}\nWe chose SQLite.` },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `${injectedContext}\nSQLite is the chosen store.`,
          },
          { type: "image", data: "fixture-image" },
        ],
      },
      { role: "user", content: "What did we decide about the database?" },
    ];
    const original = structuredClone(messages);

    expect(
      composeRecallQuery("What did we decide about the database?", messages, 2),
    ).toBe(
      "Prior context:\n\nuser: We chose SQLite.\nassistant: SQLite is the chosen store.\n\nWhat did we decide about the database?",
    );
    expect(messages).toEqual(original);
  });

  it("cleans the latest recall query even when prior context is disabled", () => {
    expect(
      composeRecallQuery(
        `${injectedContext}\nFind the database decision`,
        [],
        1,
      ),
    ).toBe("Find the database decision");
  });

  it.each([true, false])(
    "cleans retained user and assistant text with retainToolCalls=%s",
    (retainToolCalls) => {
      const messages = [
        { role: "user", content: `${injectedContext}\nWe chose SQLite.` },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `${injectedContext}\nI recorded that decision.`,
            },
          ],
        },
      ];
      const original = structuredClone(messages);
      const result = prepareRetentionTranscript(messages, {
        retainEveryNTurns: 1,
        retainToolCalls,
        retainRoles: ["user", "assistant"],
      });

      expect(result).not.toBeNull();
      expect(JSON.parse(result!.transcript)).toEqual([
        {
          role: "user",
          content: retainToolCalls
            ? [{ type: "text", text: "We chose SQLite." }]
            : "We chose SQLite.",
        },
        {
          role: "assistant",
          content: retainToolCalls
            ? [{ type: "text", text: "I recorded that decision." }]
            : "I recorded that decision.",
        },
      ]);
      expect(messages).toEqual(original);
    },
  );

  it.each([true, false])(
    "does not retain injection-only messages with retainToolCalls=%s",
    (retainToolCalls) => {
      expect(
        prepareRetentionTranscript(
          [{ role: "user", content: injectedContext }],
          { retainEveryNTurns: 1, retainToolCalls },
        ),
      ).toBeNull();
    },
  );

  it.each([
    "skill_harness_plugin",
    "hindsight_memory_plugin",
    "active_memory_plugin",
    "hindsight_memories",
    "relevant_memories",
  ])(
    "cleans %s split across text blocks while preserving tool order",
    (tag) => {
      const messages = [
        { role: "user", content: "We chose SQLite." },
        {
          role: "assistant",
          content: [
            { type: "text", text: `Before\n<${tag}>Old injected guidance` },
            {
              type: "toolCall",
              id: "tool-1",
              name: "read",
              arguments: { path: "notes.md" },
            },
            { type: "text", text: `More injected guidance</${tag}>\nAfter` },
          ],
        },
      ];
      const original = structuredClone(messages);
      const result = prepareRetentionTranscript(messages, {
        retainToolCalls: true,
      });

      expect(JSON.parse(result!.transcript)[1].content).toEqual([
        { type: "text", text: "Before" },
        {
          type: "tool_use",
          id: "tool-1",
          name: "read",
          input: { path: "notes.md" },
        },
        { type: "text", text: "After" },
      ]);
      expect(messages).toEqual(original);
    },
  );
});

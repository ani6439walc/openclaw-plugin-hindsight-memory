import { afterEach, describe, expect, it } from "vitest";
import {
  configureSenderPrefixStripping,
  DEFAULT_RETAIN_CONTEXT,
  extractRecallQuery,
  extractSenderIdFromText,
  prepareRetentionTranscript,
} from "./index.js";

const alice = { id: "alice-id", name: "Alice", username: "alice" };
const bob = { id: "bob-id", name: "Bob", username: "bob" };

function envelope(sender: unknown, body: string, legacy = false): string {
  const header = legacy
    ? "Conversation info (untrusted metadata):"
    : "Conversation info: ⟦openclaw:ctx⟧";
  return `[Tue 2026-11-03 21:21 GMT+8] ${header}\n\`\`\`json\n${JSON.stringify({
    sender,
    chat_id: "discard-chat",
    message_id: "discard-message",
    reply_to_id: "discard-reply",
    conversation_label: "discard-label",
    group_subject: "discard-subject",
    thread_label: "discard-thread",
    topic_id: "discard-topic",
    history_count: 42,
  })}\n\`\`\`\n\n${body}`;
}

afterEach(() => configureSenderPrefixStripping(undefined));

describe("per-message retain sender attribution", () => {
  it.each(["not-json", "null", "[]", '{"sender":'])(
    "leaves invalid unfenced metadata unknown (%s)",
    (metadata) => {
      const result = prepareRetentionTranscript(
        [
          {
            role: "user",
            content: `Conversation info: ⟦openclaw:ctx⟧\n${metadata}\n\nMy subscription is cancelled.`,
          },
        ],
        {},
      );
      expect(JSON.parse(result!.transcript)).toEqual([
        {
          role: "user",
          content: [{ type: "text", text: "My subscription is cancelled." }],
        },
      ]);
    },
  );

  it("does not expand bank routing identity parsing for unfenced metadata", () => {
    const content = `Conversation info: ⟦openclaw:ctx⟧\n${JSON.stringify({ sender: alice, sender_id: "routing-id" })}\n\nMy subscription is cancelled.`;
    const result = prepareRetentionTranscript([{ role: "user", content }], {});
    expect(JSON.parse(result!.transcript)[0].sender).toEqual(alice);
    expect(extractSenderIdFromText(content)).toBeUndefined();
  });

  it.each([{}, { retainToolCalls: false }, { retainFormat: "text" as const }])(
    "preserves unfenced Conversation info sender with %j",
    (config) => {
      const content = (sender: unknown, body: string) =>
        `[Tue 2026-11-03 21:36 GMT+8] Conversation info: ⟦openclaw:ctx⟧\n${JSON.stringify({ sender, chat_id: "discard-chat" })}\n\n${body}`;
      const result = prepareRetentionTranscript(
        [
          {
            role: "user",
            content: content(alice, "I cancelled my subscription."),
          },
          { role: "user", content: content(bob, "Mine is still active.") },
          { role: "user", content: "My sender is unavailable." },
        ],
        config,
        true,
      );

      expect(result!.transcript).not.toContain("discard-chat");
      expect(result!.transcript).not.toContain("Conversation info");
      if (config.retainFormat === "text") {
        expect(result!.transcript).toContain(
          `[sender: ${JSON.stringify(alice)}]`,
        );
        expect(result!.transcript).toContain(
          `[sender: ${JSON.stringify(bob)}]`,
        );
        expect(result!.transcript.match(/\[sender:/g)).toHaveLength(2);
      } else {
        const retained = JSON.parse(result!.transcript);
        expect(
          retained.map((message: { sender?: unknown }) => message.sender),
        ).toEqual([alice, bob, undefined]);
      }
    },
  );

  it("preserves sender from the legacy envelope's outer fences", () => {
    const result = prepareRetentionTranscript(
      [
        {
          role: "user",
          content: `---\n${envelope(alice, "My subscription is cancelled.", true)}\n---`,
        },
      ],
      {},
    );
    expect(JSON.parse(result!.transcript)[0].sender).toEqual(alice);
    expect(JSON.parse(result!.transcript)[0].content).toEqual([
      { type: "text", text: "My subscription is cancelled." },
    ]);
  });

  it.each([true, false])(
    "preserves each sender independently with retainToolCalls=%s",
    (retainToolCalls) => {
      configureSenderPrefixStripping("Alice|Bob");
      const messages = [
        {
          role: "user",
          timestamp: "2026-11-03T13:21:00Z",
          content: envelope(
            { ...alice, extra: "discard-extra" },
            "Alice: I cancelled my subscription.",
          ),
        },
        { role: "assistant", content: "I recorded Alice's update." },
        { role: "user", content: envelope(bob, "Bob: Mine is still active.") },
        { role: "assistant", content: "I recorded Bob's update." },
        { role: "user", content: "My sender is unavailable." },
      ];
      const original = structuredClone(messages);
      const result = prepareRetentionTranscript(
        messages,
        { retainToolCalls },
        true,
      );
      const retained = JSON.parse(result!.transcript);

      expect(
        retained.map((message: { sender?: unknown }) => message.sender),
      ).toEqual([alice, undefined, bob, undefined, undefined]);
      expect(retained[0].timestamp).toBe("2026-11-03T13:21:00.000Z");
      expect(result!.transcript).toContain("I cancelled my subscription.");
      expect(result!.transcript).toContain("Mine is still active.");
      expect(result!.transcript).not.toContain("discard-");
      expect(result!.transcript).not.toContain("Conversation info");
      expect(result!.transcript).not.toContain("Alice: I cancelled");
      expect(messages).toEqual(original);
    },
  );

  it("preserves attribution in legacy text output", () => {
    const result = prepareRetentionTranscript(
      [
        {
          role: "user",
          content: envelope(alice, "I cancelled my subscription."),
        },
        { role: "user", content: envelope(bob, "Mine is still active.") },
      ],
      { retainFormat: "text" },
      true,
    );

    expect(result!.transcript).toBe(
      `[role: user]\n[sender: ${JSON.stringify(alice)}]\nI cancelled my subscription.\n[user:end]\n\n` +
        `[role: user]\n[sender: ${JSON.stringify(bob)}]\nMine is still active.\n[user:end]`,
    );
  });

  it("takes the current turn's own sender after excluding earlier turns", () => {
    const result = prepareRetentionTranscript(
      [
        {
          role: "user",
          content: envelope(alice, "I cancelled my subscription."),
        },
        { role: "assistant", content: "Recorded." },
        { role: "user", content: envelope(bob, "Mine is still active.") },
      ],
      {},
    );
    expect(JSON.parse(result!.transcript)).toEqual([
      {
        role: "user",
        sender: bob,
        content: [{ type: "text", text: "Mine is still active." }],
      },
    ]);
  });

  it("extracts sender from an envelope split across text blocks and still strips injections", () => {
    const raw = envelope(
      alice,
      "<hindsight_memory_plugin>Old recalled fact</hindsight_memory_plugin>\n<skill_harness_plugin>Old skill</skill_harness_plugin>\nMy subscription is cancelled.",
    );
    const split = raw.indexOf('"name"');
    const result = prepareRetentionTranscript(
      [
        {
          role: "user",
          content: [
            { type: "text", text: raw.slice(0, split) },
            { type: "text", text: raw.slice(split) },
          ],
        },
      ],
      {},
    );
    const retained = JSON.parse(result!.transcript);
    expect(retained[0].sender).toEqual(alice);
    expect(result!.transcript).not.toContain("Old recalled fact");
    expect(result!.transcript).not.toContain("Old skill");
    expect(result!.transcript).not.toContain("discard-");
    expect(result!.transcript).not.toContain("```");
  });

  it("keeps only supplied string sender fields from a legacy envelope", () => {
    const result = prepareRetentionTranscript(
      [
        {
          role: "user",
          content: envelope(
            { id: "alice-id", name: [], username: null },
            "I cancelled my subscription.",
            true,
          ),
        },
      ],
      {},
    );
    expect(JSON.parse(result!.transcript)[0].sender).toEqual({
      id: "alice-id",
    });
  });

  it.each([
    { sender: undefined, body: "My subscription is cancelled." },
    {
      sender: { id: 123, name: [], username: " " },
      body: "My subscription is cancelled.",
    },
    { sender: [alice], body: "My subscription is cancelled." },
  ])(
    "leaves missing or invalid attribution unknown ($sender)",
    ({ sender, body }) => {
      const result = prepareRetentionTranscript(
        [{ role: "user", content: envelope(sender, body) }],
        {},
      );
      expect(JSON.parse(result!.transcript)[0]).not.toHaveProperty("sender");
    },
  );

  it("does not infer sender from display-name prefixes or arbitrary message JSON", () => {
    configureSenderPrefixStripping("Alice|Bob");
    const result = prepareRetentionTranscript(
      [
        {
          role: "user",
          content: `Alice: My subscription is cancelled.\n${JSON.stringify({ sender: alice })}`,
        },
      ],
      {},
    );
    expect(JSON.parse(result!.transcript)[0]).not.toHaveProperty("sender");
  });

  it("does not use quoted or plugin-injected sender envelopes as attribution", () => {
    const injected = `<hindsight_memory_plugin>\n${envelope(bob, "Old memory")}\n</hindsight_memory_plugin>\n`;
    const result = prepareRetentionTranscript(
      [
        {
          role: "user",
          content: `${injected}${envelope(alice, "My subscription is cancelled.")}\nQuoted example:\n${envelope(bob, "Example only")}`,
        },
      ],
      {},
    );
    expect(JSON.parse(result!.transcript)[0].sender).toEqual(alice);

    const quoted = prepareRetentionTranscript(
      [
        {
          role: "user",
          content: `Quoted example:\n${envelope(bob, "Example only")}`,
        },
      ],
      {},
    );
    expect(JSON.parse(quoted!.transcript)[0]).not.toHaveProperty("sender");
  });

  it("does not attach human sender to assistant or synthetic tool-result messages", () => {
    const result = prepareRetentionTranscript(
      [
        {
          role: "user",
          content: envelope(alice, "Read the subscription status."),
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: envelope(bob, "I will read it.") },
            { type: "toolCall", id: "read-1", name: "read", arguments: {} },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: "Cancelled." }],
        },
      ],
      {},
    );
    const retained = JSON.parse(result!.transcript);
    expect(retained[0].sender).toEqual(alice);
    expect(
      retained
        .slice(1)
        .every((message: { sender?: unknown }) => message.sender === undefined),
    ).toBe(true);
    expect(retained[2].content[0].type).toBe("tool_result");
  });

  it("keeps recall queries free of sender metadata", () => {
    expect(
      extractRecallQuery(
        envelope(alice, "What is my subscription status?"),
        undefined,
      ),
    ).toBe("What is my subscription status?");
  });

  it("explains per-message attribution separately from document routing IDs", () => {
    expect(DEFAULT_RETAIN_CONTEXT).toContain("per-message");
    expect(DEFAULT_RETAIN_CONTEXT).toContain("sender");
    expect(DEFAULT_RETAIN_CONTEXT).toContain("different speakers");
  });
});

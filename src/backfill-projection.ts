// The pinned stock package ships this public runtime without declarations.
// Describe only the operations used here and narrow its unknown records once.
export interface BackfillProjectionHost {
  SessionManager: {
    fromEntries(events: readonly unknown[]): {
      getEntry(id: string): unknown;
      getBranch(): unknown[];
    };
  };
  buildSessionContext(entries: readonly unknown[]): { messages: unknown[] };
}

type BranchEntry = Record<string, unknown> & { id: string; type: string };

export class BackfillProjectionError extends Error {
  constructor(
    public readonly reason: "missing-transcript" | "invalid-transcript",
  ) {
    super(
      reason === "missing-transcript"
        ? "Original session transcript header is missing or mismatched"
        : "Unable to project the original session transcript",
    );
    this.name = "BackfillProjectionError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Select through stock owners, then return original persisted message envelopes. */
export function projectBackfillTranscript(
  events: readonly unknown[],
  expectedSessionId: string,
  host: BackfillProjectionHost,
): unknown[] {
  const header = events.find(
    (event) => record(event) && event.type === "session",
  );
  if (!record(header) || header.id !== expectedSessionId) {
    throw new BackfillProjectionError("missing-transcript");
  }
  try {
    const manager = host.SessionManager.fromEntries(events);
    const originals = new Map<string, Record<string, unknown>>();
    for (const event of events) {
      if (!record(event) || typeof event.id !== "string") continue;
      originals.set(event.id, event);
      // The stock manager tolerates unknown records. An unreadable retained
      // message or reset must not silently disappear from a successful plan.
      const retainedMessage =
        event.type === "message" &&
        record(event.message) &&
        ["user", "assistant", "toolResult"].includes(
          String(event.message.role),
        );
      if (retainedMessage || event.type === "reset") {
        const indexed = manager.getEntry(event.id);
        if (!record(indexed) || indexed.type !== event.type) {
          throw new BackfillProjectionError("invalid-transcript");
        }
      }
    }
    const branch = manager.getBranch().map((entry): BranchEntry => {
      if (
        !record(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.type !== "string"
      ) {
        throw new BackfillProjectionError("invalid-transcript");
      }
      return { ...entry, id: entry.id, type: entry.type };
    });
    let resetIndex = branch.length - 1;
    while (resetIndex >= 0 && branch[resetIndex].type !== "reset")
      resetIndex -= 1;
    let selected = branch;
    if (resetIndex >= 0) {
      const marker = Symbol("backfill entry identity");
      const prefix: BranchEntry[] = branch
        .slice(0, resetIndex + 1)
        .map((entry) =>
          entry.type === "message" && record(entry.message)
            ? { ...entry, message: { ...entry.message, [marker]: entry.id } }
            : entry,
        );
      // The prefix ends at reset, so its context owner selects the reset-kept
      // tool pairs without letting a later compaction truncate historical data.
      // Its cloned/model-facing payloads are used only for identity selection.
      const retainedIds = new Set<string>();
      for (const message of host.buildSessionContext(prefix).messages) {
        if (!record(message))
          throw new BackfillProjectionError("invalid-transcript");
        const id: unknown = Reflect.get(message, marker);
        if (typeof id === "string") retainedIds.add(id);
        else if (
          ["user", "assistant", "toolResult"].includes(String(message.role))
        ) {
          throw new BackfillProjectionError("invalid-transcript");
        }
      }
      selected = [
        ...branch
          .slice(0, resetIndex)
          .filter((entry) => retainedIds.has(entry.id)),
        ...branch.slice(resetIndex + 1),
      ];
    }
    const messages = selected
      .filter((entry) => entry.type === "message")
      .map((entry) => {
        const original = originals.get(entry.id);
        if (!original || original.type !== "message") {
          throw new BackfillProjectionError("invalid-transcript");
        }
        return original;
      });
    return [header, ...messages];
  } catch (error) {
    if (error instanceof BackfillProjectionError) throw error;
    // Host validation errors may contain transcript bytes.
    throw new BackfillProjectionError("invalid-transcript");
  }
}

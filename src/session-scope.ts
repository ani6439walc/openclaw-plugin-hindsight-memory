import type { MemoryScope } from "./types.js";
import { matchesSessionPattern } from "./session-patterns.js";

/** Validate at the config boundary: malformed exclusions must never become []. */
export function normalizeMemoryScope(value: unknown): Required<MemoryScope> {
  if (value === undefined) {
    return { skipRecallSessions: [], skipRetainSessions: [] };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scope must be an object");
  }
  const keys = ["skipRecallSessions", "skipRetainSessions"] as const;
  for (const key of Object.keys(value)) {
    if (!keys.some((allowed) => allowed === key)) {
      throw new Error(`Unknown scope setting: ${key}`);
    }
  }
  const raw = value as Record<string, unknown>;
  function patterns(key: (typeof keys)[number]): string[] {
    if (!Object.hasOwn(raw, key)) return [];
    const list = raw[key];
    if (
      !Array.isArray(list) ||
      list.some((pattern) => typeof pattern !== "string" || !pattern.length)
    ) {
      throw new Error(`scope.${key} must be an array of nonempty strings`);
    }
    return [...list];
  }
  return {
    skipRecallSessions: patterns("skipRecallSessions"),
    skipRetainSessions: patterns("skipRetainSessions"),
  };
}

/** Configured exclusions cannot be bypassed by an event without a session key. */
export function shouldSkipSession(
  sessionKey: string | undefined,
  patterns: RegExp[],
): boolean {
  return (
    patterns.length > 0 &&
    (!sessionKey || matchesSessionPattern(sessionKey, patterns))
  );
}

import type {
  InputProvenance,
  OpenClawPluginApi,
  OpenClawMessage,
  OpenClawMessageContentBlock,
  PluginConfig,
  PluginHookAgentContext,
  PluginHookEvent,
  PluginHookSessionContext,
  OpenClawPluginToolContext,
  MemoryResult,
  RetainRequest,
} from "./types.js";
import { HindsightServer, type Logger } from "@vectorize-io/hindsight-all";
import {
  HindsightClient,
  type HindsightClientOptions,
  type MinScores,
} from "@vectorize-io/hindsight-client";
import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { RetainQueue } from "./retain-queue.js";
import {
  compileSessionPatterns,
  matchesSessionPattern,
} from "./session-patterns.js";
import {
  definePluginEntry,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/plugin-entry";
import { createHash, randomUUID } from "crypto";
import { join } from "path";
import * as log from "./logger.js";
import { configureLogger, setApiLogger, stopLogger } from "./logger.js";
import { createRequire } from "module";
import {
  createKnowledgeTools,
  TOOL_NAMES,
} from "@vectorize-io/hindsight-agent-sdk";

export const KNOWLEDGE_TOOL_RENAMES: Record<
  string,
  { name: string; label?: string; description?: string }
> = {
  agent_knowledge_recall: {
    name: "memory_recall",
  },
  agent_knowledge_reflect: {
    name: "memory_reflect",
    description:
      "Generate a concise answer using the memory bank. Use for deliberate synthesis, retrospectives, or long-term preference/pattern questions; use memory_recall for ordinary lookup.",
  },
  agent_knowledge_ingest: {
    name: "memory_store",
    label: "Store a document in memory",
  },
};

export const PAGE_TOOL_ACTION_MAP: Record<string, string> = {
  list: "agent_knowledge_list_pages",
  get: "agent_knowledge_get_page",
  create: "agent_knowledge_create_page",
  update: "agent_knowledge_update_page",
  delete: "agent_knowledge_delete_page",
};

export const KNOWLEDGE_PAGE_TOOL_DEFINITION = {
  name: "knowledge_page",
  label: "Manage knowledge pages",
  description:
    "Manage synthesized knowledge pages (mental models). Actions: list, get, create, update, or delete. Knowledge pages auto-update over time based on conversation observations and their source_query.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "create", "update", "delete"],
        description:
          "Operation to perform: 'list' (list all pages), 'get' (read full page content), 'create' (create new page), 'update' (update page metadata), 'delete' (delete page).",
      },
      page_id: {
        type: "string",
        description:
          "Unique page ID, lowercase with hyphens (e.g. 'user-preferences'). Required for get, create, update, and delete.",
      },
      name: {
        type: "string",
        description:
          "Human-readable page name. Required for create, optional for update.",
      },
      source_query: {
        type: "string",
        description:
          "The recurring question used during consolidation to rebuild the page content (e.g. 'What are the user\\'s editorial preferences?'). Required for create, optional for update.",
      },
    },
    required: ["action"],
  },
};

export const REGISTERED_KNOWLEDGE_TOOL_NAMES: readonly string[] = [
  "memory_recall",
  "memory_reflect",
  "memory_store",
  KNOWLEDGE_PAGE_TOOL_DEFINITION.name,
];

export async function executeKnowledgePageAction<Result>(
  rawToolsByName: Map<
    string,
    { execute: (params: Record<string, unknown>) => Promise<Result> }
  >,
  params: Record<string, unknown>,
): Promise<Result> {
  const action = String(params?.action || "")
    .toLowerCase()
    .trim();
  const targetToolName = PAGE_TOOL_ACTION_MAP[action];
  if (!targetToolName) {
    const validActions = Object.keys(PAGE_TOOL_ACTION_MAP).join(", ");
    throw new Error(
      `Unsupported action "${params?.action}". Supported actions: ${validActions}.`,
    );
  }

  if (
    action !== "list" &&
    (!params?.page_id ||
      typeof params.page_id !== "string" ||
      !params.page_id.trim())
  ) {
    throw new Error(`page_id is required for action "${action}".`);
  }

  if (action === "create") {
    if (
      !params?.name ||
      typeof params.name !== "string" ||
      !params.name.trim()
    ) {
      throw new Error(`name is required for action "create".`);
    }
    if (
      !params?.source_query ||
      typeof params.source_query !== "string" ||
      !params.source_query.trim()
    ) {
      throw new Error(`source_query is required for action "create".`);
    }
  }

  const delegate = rawToolsByName.get(targetToolName);
  if (!delegate) {
    throw new Error(`Underlying tool ${targetToolName} not found`);
  }

  return await delegate.execute(params);
}

import {
  applyConfiguredBankDefaults,
  hasConfiguredBankDefaults,
  normalizeDispositionTrait,
  normalizeEntityLabels,
  normalizeRetainExtractionMode,
} from "./bank-defaults.js";

/**
 * Structured payload for a knowledge tool result.
 *
 * The SDK returns the payload only as JSON text in `content[0].text`. OpenClaw's
 * Code Mode hands a tool result's `details` (and nothing else) to the guest as the
 * structured value, so `details: {}` made every knowledge tool look empty there
 * (#4308). Parse the text back into an object; a non-object payload is wrapped and
 * unparseable text yields `{}` as before.
 */
export function knowledgeToolDetails(result: unknown): Record<string, unknown> {
  const content = (result as { content?: unknown })?.content;
  const first = Array.isArray(content)
    ? (content[0] as { text?: unknown } | undefined)
    : undefined;
  const text = first?.text;
  if (typeof text !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return {};
  }
}

function loadPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const USER_AGENT = `openclaw-plugin-hindsight-memory/${loadPackageVersion()}`;

export const DEFAULT_RETAIN_CONTEXT =
  "This content is an AI-assistant conversation transcript from OpenClaw. " +
  "Retain request metadata may include routing identifiers such as " +
  "'sender_id' (an opaque user ID, not a human name), 'channel_id' (a chat identifier), " +
  "and 'provider' (the messaging platform name). " +
  "These are operational routing metadata, not semantic actors or people. " +
  "Messages with role 'assistant' are from the AI assistant; first-person statements " +
  "in assistant messages refer to the AI, not the human user. " +
  "Messages with role 'user' are from the human user. " +
  "Bank IDs, session keys, agent IDs, thread IDs, source systems, " +
  "and tags in metadata are also operational routing identifiers, " +
  "not human names, project names, or organizations.";

// Logger adapter that routes the embed wrapper's output through openclaw's
// batched structured logger so messages share the same prefix and respect
// the configured log level.
const embedLogger: Logger = {
  debug: (msg) => log.verbose(msg),
  info: (msg) => log.info(msg),
  warn: (msg) => log.warn(msg),
  error: (msg) => log.error(msg),
};

// Debug logging: silent by default, enable with debug: true or logLevel: 'debug'
let debugEnabled = false;
const debug = (...args: unknown[]) => {
  if (debugEnabled)
    log.verbose(
      args
        .map((a) =>
          typeof a === "string"
            ? a.replace(/^\[Hindsight\]\s*/, "")
            : String(a),
        )
        .join(" "),
    );
};

// Module-level state
let hindsightServer: HindsightServer | null = null;
let client: HindsightClient | null = null;
let clientOptions: HindsightClientOptions | null = null;
let initPromise: Promise<void> | null = null;
let isInitialized = false;
let usingExternalApi = false; // Track if using external API (skip daemon management)

// Capability detected once per service.start() against `<apiUrl>/version`.
// `true` when the Hindsight API supports `update_mode: 'append'` (added in
// 0.5.0 — see vectorize-io/hindsight#932) and stores document text. When false,
// retain falls back to a per-turn document id so prior turns aren't silently
// overwritten or rejected by text-disabled deployments.
let supportsUpdateModeAppend = false;
let appendCapabilityProbed = false;
const MIN_VERSION_FOR_UPDATE_MODE_APPEND = "0.5.0";

/** Whether retain is currently using session-scoped documents + `update_mode: 'append'`. */
export function isAppendModeSupported(): boolean {
  return supportsUpdateModeAppend;
}

export type AsyncRetainOperationIdCapability =
  "supported" | "unsupported" | "unknown";
let asyncRetainOperationIdCapability: AsyncRetainOperationIdCapability =
  "unknown";
const MIN_VERSION_FOR_ASYNC_RETAIN_OPERATION_ID = "0.8.6";

// Store the current plugin config for bank ID derivation
let currentPluginConfig: PluginConfig | null = null;
let serviceGeneration = 0;
let serviceAbortController: AbortController | null = null;
// External-API hooks can lazy-initialize before the first service.start(). Keep
// that hook lifetime cancellable for both recall and retention.
const preServiceHookController = new AbortController();

// Track which banks have had configured defaults applied (missions + bank config).
const banksWithDefaultsApplied = new Set<string>();

// In-flight recall deduplication: concurrent recalls for the same bank reuse one promise
import type { RecallResponse } from "./types.js";
const inflightRecalls = new Map<string, Promise<RecallResponse>>();
type CachedRecallPromptResult = {
  prependContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
} | null;
const recallResultByRunId = new Map<string, CachedRecallPromptResult>();

// Bank-scoped recall handle created by getClientForContext(). Retention is
// delivered separately by the durable outbox worker.
export interface BankScopedClient {
  readonly bankId: string;
  recall(
    req: {
      query: string;
      maxTokens?: number;
      budget?: "low" | "mid" | "high";
      types?: Array<"world" | "experience" | "observation">;
      preferObservations?: boolean;
      minScores?: MinScores;
    },
    timeoutMs?: number,
    signal?: globalThis.AbortSignal,
  ): Promise<RecallResponse>;
}

export function scopeClient(
  c: HindsightClient,
  bankId: string,
): BankScopedClient {
  return {
    bankId,
    async recall(req, timeoutMs, signal) {
      signal?.throwIfAborted();
      // Two independent reasons to stop: the caller's service-owned signal (stop
      // or restart) and this call's own deadline. Compose them so the transport is
      // cancelled by whichever fires first, while the reason the caller classifies
      // on survives — a TimeoutError for the deadline, an AbortError for a stop.
      const deadline = new AbortController();
      const effective = signal
        ? AbortSignal.any([signal, deadline.signal])
        : deadline.signal;
      let onAbort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(effective.reason);
        effective.addEventListener("abort", onAbort, { once: true });
      });
      const timer = timeoutMs
        ? setTimeout(
            () =>
              deadline.abort(
                new DOMException(
                  `Recall timed out after ${timeoutMs}ms`,
                  "TimeoutError",
                ),
              ),
            timeoutMs,
          )
        : undefined;
      try {
        // A race alone only stopped the hook's wait. Forward cancellation to the
        // client too, so its HTTP request receives the deadline and service stops.
        //
        // The race stays as a backstop for a transport that ignores the signal,
        // which is not hypothetical: from client 0.10.x recall routes through
        // `retryOnCapacity`, whose backoff sleeps in a plain setTimeout, so an
        // abort during a 429/503 wait does not interrupt it. (#4445)
        const response = await Promise.race([
          c.recall(bankId, req.query, {
            maxTokens: req.maxTokens,
            budget: req.budget,
            types: req.types,
            preferObservations: req.preferObservations,
            minScores: req.minScores,
            signal: effective,
          }),
          cancelled,
        ]);
        effective.throwIfAborted();
        return response;
      } finally {
        clearTimeout(timer);
        effective.removeEventListener("abort", onAbort);
      }
    },
  };
}

async function ensureBankDefaultsApplied(
  bankId: string,
  config: PluginConfig,
): Promise<void> {
  if (!client || !clientOptions || !hasConfiguredBankDefaults(config)) {
    return;
  }
  if (banksWithDefaultsApplied.has(bankId)) {
    return;
  }
  try {
    await applyConfiguredBankDefaults(client, bankId, config);
    banksWithDefaultsApplied.add(bankId);
    debug(`[Hindsight] Applied configured defaults for bank: ${bankId}`);
  } catch (error) {
    log.warn(
      `could not apply bank defaults for ${bankId}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * Format a single perf line for the `debugPerfTiming` flag. Pure function so
 * the formatting can be unit-tested without standing up the full hook pipeline.
 * Caller is responsible for stringifying durations with the `ms` suffix —
 * counts and identifiers are rendered as-is.
 */
export function formatHookPerf(
  hook: string,
  hookTotalMs: number,
  fields: Record<string, string | number | undefined>,
): string {
  const parts = [`hook_total=${hookTotalMs}ms`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${v}`);
  }
  return `perf: ${hook} ${parts.join(" ")}`;
}

/**
 * The generated client's metadata type is `Record<string, string>`; the
 * openclaw builder uses `Record<string, unknown>` because some fields come
 * from optional plugin context. Drop undefined/null, stringify the rest.
 */
function toStringMetadata(
  input: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!input) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}
const turnCountBySession = new Map<string, number>();
const MAX_TRACKED_SESSIONS = 10_000;
const DEFAULT_RECALL_TIMEOUT_MS = 10_000;

type SessionIdentityRecord = Pick<
  PluginHookAgentContext,
  "senderId" | "messageProvider" | "channelId"
>;
export type IdentitySkipReason =
  | {
      kind: "retryable";
      detail:
        "missing stable message provider" | "missing stable sender identity";
    }
  | { kind: "final"; detail: string };

const sessionIdentityBySession = new Map<string, SessionIdentityRecord>();
const skipHindsightTurnBySession = new Map<string, IdentitySkipReason>();
const documentSequenceBySession = new Map<string, number>();

// Random token minted once per host process and mixed into fallback (non-append)
// document ids. `documentSequenceBySession` lives only in memory, so it restarts
// at 1 on every host restart — and it is FIFO-capped at MAX_TRACKED_SESSIONS, so
// a busy host can evict a live session's counter and recycle its ids without any
// restart at all. Either way the replayed id hits an existing server-side
// document, and retain's default `update_mode: 'replace'` *deletes* that
// document's memories before reprocessing: months of history collapsed to a
// single restart cycle's worth of turns. (#3686)
let documentIdBootToken: string | null = null;

/** Per-process token that keeps fallback document ids unique across restarts. */
export function getDocumentIdBootToken(): string {
  if (!documentIdBootToken) {
    documentIdBootToken = randomUUID().replace(/-/g, "").slice(0, 8);
  }
  return documentIdBootToken;
}

// Cooldown + guard to prevent concurrent reinit attempts
let lastReinitAttempt = 0;
let isReinitInProgress = false;
const REINIT_COOLDOWN_MS = 30_000;

// Retain queue (both external-API and local-daemon mode)
let retainQueue: RetainQueue | null = null;
let retainQueueFlushTimer: ReturnType<typeof setInterval> | null = null;
// Scoped module instances share one process; only one Gateway worker may drain a path.
const flushOwnersKey = Symbol.for("hindsight.retainQueue.flushOwners");
const processState = globalThis as typeof globalThis & {
  [key: symbol]: Set<string> | undefined;
};
const flushOwners = (processState[flushOwnersKey] ??= new Set<string>());
const DEFAULT_FLUSH_INTERVAL_MS = 60_000; // 1 min

/**
 * Open the durable retain queue and start its periodic flush timer.
 *
 * Service-owned timer; agent registries open producer handles without timers.
 * Initialization errors are reported without taking down the agent reply.
 */
export function defaultRetainQueuePath(): string {
  return join(
    resolveStateDir(),
    "plugins",
    "hindsight-memory",
    "retain-queue.jsonl",
  );
}

function openRetainQueue(pluginConfig: PluginConfig): RetainQueue {
  const queuePath = pluginConfig.retainQueuePath || defaultRetainQueuePath();
  return new RetainQueue({
    filePath: queuePath,
    maxAgeMs: pluginConfig.retainQueueMaxAgeMs ?? -1,
  });
}

function initRetainQueue(
  pluginConfig: PluginConfig,
  expectedGeneration: number,
  signal: globalThis.AbortSignal,
): void {
  if (retainQueueFlushTimer) clearInterval(retainQueueFlushTimer);
  retainQueueFlushTimer = null;
  try {
    retainQueue = openRetainQueue(pluginConfig);
    const pending = retainQueue.size();
    if (pending > 0) {
      log.info(
        `retain queue: ${pending} items pending from previous session, will flush shortly`,
      );
    }
    const interval =
      pluginConfig.retainQueueFlushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    if (interval > 0) {
      retainQueueFlushTimer = setInterval(() => {
        void flushRetainQueue(
          undefined,
          undefined,
          undefined,
          expectedGeneration,
          signal,
        ).catch((error) => log.error("retain queue flush failed", error));
      }, interval);
      retainQueueFlushTimer.unref?.();
    }
  } catch (error) {
    retainQueue = null;
    log.error("could not initialize durable retain queue", error);
  }
}

/**
 * Attempt to flush pending retains from the queue.
 * Each item is sent exactly as it would have been originally — same bank, payload, metadata.
 */
export async function flushRetainQueue(
  queueOverride?: RetainQueue,
  clientOverride?: HindsightClient,
  capabilityOverride?: AsyncRetainOperationIdCapability,
  expectedGeneration = serviceGeneration,
  signal: globalThis.AbortSignal | undefined = serviceAbortController?.signal,
): Promise<void> {
  const activeQueue = queueOverride ?? retainQueue;
  if (
    !activeQueue ||
    flushOwners.has(activeQueue.directory) ||
    expectedGeneration !== serviceGeneration ||
    signal?.aborted
  )
    return;

  flushOwners.add(activeQueue.directory);
  let flushed = 0;
  let failed = 0;

  try {
    // Read a bounded payload batch asynchronously from a filename snapshot.
    // New producer entries are picked up by the next cycle.
    const { items, pending } = await activeQueue.batch(50, signal);
    if (
      expectedGeneration !== serviceGeneration ||
      signal?.aborted ||
      pending === 0
    )
      return;
    const capability =
      capabilityOverride ??
      (await refreshQueueOperationIdCapability(expectedGeneration, signal));
    if (expectedGeneration !== serviceGeneration || signal?.aborted) return;
    if (capability === "unknown") {
      // Held back on purpose: a replay without operation_id is the one path that
      // can duplicate durable memories. Warn rather than debug — if /version
      // stays unreachable the queue grows without ever draining, and that must
      // not be silent.
      log.warn(
        `retain queue flush deferred (${pending} queued): server operation-id capability unknown`,
      );
      return;
    }
    if (!clientOverride && !client) await lazyReinit();
    if (expectedGeneration !== serviceGeneration || signal?.aborted) return;
    const activeClient = clientOverride ?? client;
    if (!activeClient) return;

    for (const item of items) {
      try {
        if (expectedGeneration !== serviceGeneration || signal?.aborted) return;
        const operationId =
          capability === "supported"
            ? item.operationId ||
              activeQueue.ensureOperationId(item.id, randomUUID())
            : undefined;
        if (
          capability === "supported" ? !operationId : !activeQueue.has(item.id)
        )
          continue;
        if (!clientOverride && currentPluginConfig) {
          await ensureBankDefaultsApplied(item.bankId, currentPluginConfig);
          if (expectedGeneration !== serviceGeneration || signal?.aborted)
            return;
        }
        if (!activeQueue.has(item.id)) continue;
        await activeClient.retain(item.bankId, item.content, {
          documentId: item.documentId,
          context: item.context,
          metadata: toStringMetadata(item.metadata),
          tags: item.tags,
          updateMode: item.updateMode,
          async: true,
          signal,
          ...(operationId ? { operationId } : {}),
        });

        if (expectedGeneration !== serviceGeneration || signal?.aborted) return;
        // Checkpoint each acknowledgement before the next network await. A
        // later abort must not replay already-accepted work on legacy servers.
        activeQueue.remove(item.id);
        log.trackRetain(item.bankId, Number(item.metadata?.message_count) || 0);
        flushed++;
      } catch (error) {
        if (expectedGeneration !== serviceGeneration || signal?.aborted) return;
        log.warn(
          `retain delivery failed; item remains queued (bank: ${item.bankId}): ${error instanceof Error ? error.message : error}`,
        );
        // API still down — stop trying this batch
        failed++;
        break;
      }
    }

    if (expectedGeneration !== serviceGeneration || signal?.aborted) return;
    const remaining = activeQueue.size();
    if (flushed > 0) {
      log.info(
        `queue flush: ${flushed} queued retains delivered${remaining > 0 ? `, ${remaining} still pending` : ", queue empty"}`,
      );
    } else if (failed > 0) {
      debug(
        `[Hindsight] Queue flush: API still unreachable, ${remaining} retains pending`,
      );
    }
  } catch (error) {
    if (expectedGeneration !== serviceGeneration || signal?.aborted) return;
    throw error;
  } finally {
    flushOwners.delete(activeQueue.directory);
  }
}

const DEFAULT_RECALL_PROMPT_PREAMBLE =
  "Relevant memories from past conversations (prioritize recent when conflicting). Only use memories that are directly useful to continue this conversation; ignore the rest:";

export function formatCurrentTimeForRecall(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  // Suffix with " UTC" so the LLM doesn't misread the timestamp as local
  // time and make wrong recency judgments. Mirrors the fix landed for the
  // Claude Code integration in #1568. (#1789)
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

/** Connect either transport, then apply the same client and bank initialization. */
async function initializeConnection(
  config: PluginConfig,
  llmConfig?: ReturnType<typeof detectLLMConfig>,
): Promise<string> {
  const externalApi = detectExternalApi(config);
  usingExternalApi = Boolean(externalApi.apiUrl);
  if (externalApi.apiUrl) {
    await checkExternalApiHealth(externalApi.apiUrl, externalApi.apiToken);
    await detectAppendCapability(externalApi.apiUrl, externalApi.apiToken);
    clientOptions = buildClientOptions(externalApi);
  } else {
    llmConfig ??= detectLLMConfig(config);
    hindsightServer = new HindsightServer({
      profile: "openclaw",
      port: config.apiPort || 9077,
      embedVersion: config.embedVersion,
      embedPackagePath: config.embedPackagePath,
      env: {
        HINDSIGHT_API_LLM_PROVIDER: llmConfig.provider || "",
        HINDSIGHT_API_LLM_API_KEY: llmConfig.apiKey || "",
        HINDSIGHT_API_LLM_MODEL: llmConfig.model,
        HINDSIGHT_API_LLM_BASE_URL: llmConfig.baseUrl,
        HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT: String(
          config.daemonIdleTimeout ?? 0,
        ),
      },
      logger: embedLogger,
    });
    await hindsightServer.start();
    await detectAppendCapability(hindsightServer.getBaseUrl());
    clientOptions = { baseUrl: hindsightServer.getBaseUrl() };
  }
  banksWithDefaultsApplied.clear();
  client = new HindsightClient(clientOptions);
  const defaultBankId = deriveBankId(undefined, config);
  if (usesStaticBank(config)) {
    await ensureBankDefaultsApplied(defaultBankId, config);
  }
  isInitialized = true;
  return defaultBankId;
}

/**
 * Lazy re-initialization after startup failure.
 * Called by waitForReady when initPromise rejected but API may now be reachable.
 * Throttled to one attempt per 30s to avoid hammering a down service.
 * Only works if initialization was attempted at least once (isInitialized guard).
 */
async function lazyReinit(configOverride?: PluginConfig): Promise<void> {
  const now = Date.now();
  if (now - lastReinitAttempt < REINIT_COOLDOWN_MS || isReinitInProgress) {
    return;
  }

  const config = configOverride ?? currentPluginConfig;
  if (!config) {
    debug("[Hindsight] lazyReinit skipped - no plugin config available");
    return;
  }

  // Persist config if we only have it from the live hook registration path.
  currentPluginConfig = config;

  isReinitInProgress = true;
  lastReinitAttempt = now;
  const externalApi = detectExternalApi(config);
  if (!externalApi.apiUrl) {
    isReinitInProgress = false;
    return; // Only external API mode supports lazy reinit
  }

  debug("[Hindsight] Attempting lazy re-initialization...");
  try {
    await initializeConnection(config);
    // Replace the rejected initPromise with a resolved one
    initPromise = Promise.resolve();
    debug("[Hindsight] ✓ Lazy re-initialization succeeded");
  } catch (error) {
    log.warn(
      `lazy re-init failed (retry in ${REINIT_COOLDOWN_MS / 1000}s): ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    isReinitInProgress = false;
  }
}

// Process-local state shared by hooks and the service owner.
if (typeof global !== "undefined") {
  (global as any).__hindsightClient = {
    getClient: () => client,
    waitForReady: async () => {
      if (isInitialized) {
        return;
      }
      // If initPromise is null, it means service.start() hasn't been called yet
      // (CLI mode, not gateway mode). Hooks should gracefully no-op.
      if (!initPromise) {
        if (currentPluginConfig) {
          log.warn(
            "waitForReady called before service.start() — attempting lazy initialization fallback",
          );
          await lazyReinit(currentPluginConfig);
          return;
        }
        log.warn(
          "waitForReady called before service.start() — hooks will no-op (expected in CLI mode)",
        );
        return;
      }
      try {
        await initPromise;
      } catch {
        // Init failed (e.g., health check timeout at startup).
        // Attempt lazy re-initialization so Hindsight recovers
        // once the API becomes reachable again.
        if (!isInitialized) {
          await lazyReinit();
        }
      }
    },
    /**
     * Get a bank-scoped client handle for a specific agent context.
     * Derives the bank ID from the context for per-channel isolation and
     * ensures the bank mission is set on first use.
     */
    getClientForContext: async (
      ctx: PluginHookAgentContext | undefined,
    ): Promise<BankScopedClient | null> => {
      if (!client) return null;
      const config = currentPluginConfig || {};
      // deriveBankId already returns the static bank when dynamicBankId is false,
      // so the branch that used to stand here was redundant — and it routed around
      // the agentBankMap lookup for static configs. (#3890)
      const bankId = deriveBankId(ctx, config);
      const scoped = scopeClient(client, bankId);

      // Stamp configured defaults onto this bank on first use (recall or retain).
      await ensureBankDefaultsApplied(bankId, config);

      return scoped;
    },
    getPluginConfig: () => currentPluginConfig,
  };
}

// Default bank name (fallback when channel context not available)
const DEFAULT_BANK_NAME = "openclaw";

// Default granularity fields used by deriveBankId when not explicitly configured.
// This constant is shared between getPluginConfig (normalisation) and deriveBankId
// (fallback) so the skip-reason check and the bank-routing logic always agree.
const DEFAULT_DYNAMIC_BANK_GRANULARITY: Array<
  "agent" | "provider" | "channel" | "user"
> = ["agent", "channel", "user"];

// Throttle set: log an info-level skip message at most once per (sessionKey) per
// process lifetime so operators can discover silent retention/recall skips without
// flooding the log on every turn.
const loggedSkipSessions = new Set<string>();

function getConfiguredBankId(pluginConfig: PluginConfig): string | undefined {
  if (typeof pluginConfig.bankId !== "string") {
    return undefined;
  }

  const trimmed = pluginConfig.bankId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function usesStaticBank(pluginConfig: PluginConfig): boolean {
  return pluginConfig.dynamicBankId === false;
}

/**
 * Normalise the optional `agentBankMap` (agentId -> bankId).
 *
 * The value comes from user-edited config, so an entry whose bank is not a
 * non-empty string is dropped rather than trusted — an empty one would otherwise
 * route that agent to a bank literally named "". A map left with no usable entry
 * is treated as unset. (#3890)
 */
export function normalizeAgentBankMap(
  input: unknown,
): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;

  const normalized: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [agentId, bankId] of Object.entries(
    input as Record<string, unknown>,
  )) {
    const trimmedAgentId = agentId.trim();
    const trimmedBank = typeof bankId === "string" ? bankId.trim() : "";
    if (!trimmedAgentId || !trimmedBank) {
      dropped.push(agentId);
      continue;
    }
    // Key on the trimmed id. Storing the raw key would keep an entry that can
    // never match a resolved agent id — inert rather than wrong, and silent.
    normalized[trimmedAgentId] = trimmedBank;
  }

  // Silently dropped config keys have bitten this plugin before (#1443), so say so.
  if (dropped.length > 0) {
    log.warn(
      `agentBankMap: ignoring ${dropped.length} entr${dropped.length === 1 ? "y" : "ies"} with a missing or blank bank id (${dropped.join(", ")})`,
    );
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * The bank an agent is explicitly mapped to, if any.
 *
 * `agentBankMap` exists so one gateway can mix topologies: several agents share a
 * named bank while the rest keep their derived per-agent/channel/user banks
 * (#3890). The mapped name is used exactly as configured — `bankIdPrefix` is
 * deliberately not applied, because the operator named this bank themselves.
 */
function mappedBankIdForAgent(
  ctx: PluginHookAgentContext | undefined,
  pluginConfig: PluginConfig,
): string | undefined {
  const map = pluginConfig.agentBankMap;
  if (!map || !ctx) return undefined;

  const resolvedCtx = resolveSessionIdentity(ctx);
  const agentId =
    resolvedCtx?.agentId ||
    (resolvedCtx?.sessionKey
      ? parseSessionKey(resolvedCtx.sessionKey).agentId
      : undefined);
  // Object.hasOwn, not a plain lookup: an agent literally called "toString" or
  // "constructor" would otherwise inherit a function from the prototype, which is
  // truthy and is not a bank id.
  if (!agentId || !Object.hasOwn(map, agentId)) return undefined;

  // Re-check the value instead of trusting the caller to have normalised it: the
  // backfill CLI builds its PluginConfig straight from openclaw.json and never
  // passes through normalizeAgentBankMap, so it would otherwise back-fill into a
  // differently-trimmed bank than the live gateway writes to.
  const mapped = map[agentId];
  return typeof mapped === "string" && mapped.trim().length > 0
    ? mapped.trim()
    : undefined;
}

function getDefaultBankId(pluginConfig: PluginConfig): string {
  return pluginConfig.bankIdPrefix
    ? `${pluginConfig.bankIdPrefix}-${DEFAULT_BANK_NAME}`
    : DEFAULT_BANK_NAME;
}

function getStaticBankId(pluginConfig: PluginConfig): string {
  const configuredBankId = getConfiguredBankId(pluginConfig);
  const baseBankId = configuredBankId || DEFAULT_BANK_NAME;
  return pluginConfig.bankIdPrefix
    ? `${pluginConfig.bankIdPrefix}-${baseBankId}`
    : baseBankId;
}

/**
 * Strip plugin-injected memory tags from content to prevent retain feedback loop.
 * Removes <hindsight_memories> and <relevant_memories> blocks that were injected
 * during before_prompt_build so they don't get re-stored into the memory bank.
 */
export function stripMemoryTags(content: string): string {
  content = content.replace(
    /<hindsight_memory_plugin>[\s\S]*?<\/hindsight_memory_plugin>/g,
    "",
  );
  content = content.replace(
    /<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g,
    "",
  );
  content = content.replace(
    /<relevant_memories>[\s\S]*?<\/relevant_memories>/g,
    "",
  );
  return content;
}

/**
 * Extract per-message retain tag overrides from inline user content.
 *
 * Supported forms:
 * - <retain_tags>tag:a, tag:b</retain_tags>
 * - <hindsight_retain_tags>tag:a, tag:b</hindsight_retain_tags>
 */
export function extractInlineRetainTags(content: string): string[] {
  if (!content) return [];

  const tags: string[] = [];
  const blockRe =
    /<(?:hindsight_)?retain_tags>([\s\S]*?)<\/(?:hindsight_)?retain_tags>/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRe.exec(content)) !== null) {
    const normalized = normalizeRetainTags(match[1]);
    for (const tag of normalized) {
      if (!tags.includes(tag)) {
        tags.push(tag);
      }
    }
  }

  return tags;
}

/**
 * Remove inline retain tag directives from message content before storing it.
 */
export function stripInlineRetainTags(content: string): string {
  if (!content) return content;
  return content.replace(
    /<(?:hindsight_)?retain_tags>[\s\S]*?<\/(?:hindsight_)?retain_tags>/gi,
    "",
  );
}

/**
 * Strip OpenClaw's inline timestamp prefix (e.g. "[Wed 2026-04-15 10:44 GMT+2] ")
 * from the start of user-facing text. We lift this into a structured `timestamp`
 * field on the retained message instead, so facts aren't polluted by a weekday
 * prefix that varies per message.
 */
const INLINE_TIMESTAMP_PREFIX_RE =
  /^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\s+(?:GMT|UTC)(?:[+\-]\d{1,2}(?::\d{2})?)?\]\s*/;

export function stripInlineTimestampPrefix(content: string): string {
  if (!content) return content;
  return content.replace(INLINE_TIMESTAMP_PREFIX_RE, "");
}

/**
 * Provenance marker OpenClaw appends to every injected inbound context header
 * since 2026.8.1 — e.g. `Conversation info: ⟦openclaw:ctx⟧`. Older hosts label
 * the same blocks `Conversation info (untrusted metadata):` instead. Both forms
 * are recognised: the plugin has to keep working against hosts on either side
 * of that change.
 */
const INBOUND_CONTEXT_MARKER = "⟦openclaw:ctx⟧";

/** Matches a header line in either the marker (2026.8.1+) or legacy form. */
const INBOUND_META_HEADER_RE = new RegExp(
  `^[^\\n]*(?:${INBOUND_CONTEXT_MARKER}|\\(untrusted metadata\\))[^\\n]*$`,
);

/** True when `line` opens an OpenClaw-injected inbound metadata block. */
function isInboundMetaHeaderLine(line: string): boolean {
  return INBOUND_META_HEADER_RE.test(line.trim());
}

interface InboundMetaBlock {
  /** Index of the header line's first character. */
  start: number;
  /** Index just past the block (header + body), i.e. where normal text resumes. */
  end: number;
  /** Parsed body when the block is a ```json fence, otherwise undefined. */
  json?: unknown;
}

/**
 * Locate every OpenClaw-injected inbound metadata block in `text`.
 *
 * Mirrors the host's own stripper: a header line is followed either by a
 * ```json fence (block ends at the closing fence) or by free-form lines that
 * end at the first blank line. Keying on the header rather than on a fenced
 * payload is what makes marker-form blocks like `Chat history since last
 * reply: ⟦openclaw:ctx⟧` strippable too.
 */
function findInboundMetaBlocks(text: string): InboundMetaBlock[] {
  if (!text) return [];
  const lines = text.split("\n");
  // Byte offset of the start of each line, plus a terminator past the end.
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += line.length + 1;
  }
  offsets.push(cursor);

  const blocks: InboundMetaBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isInboundMetaHeaderLine(lines[i])) continue;
    const start = offsets[i];
    let end: number;
    let json: unknown;
    if (lines[i + 1]?.trim() === "```json") {
      let close = i + 2;
      while (close < lines.length && lines[close].trim() !== "```") close++;
      if (close < lines.length) {
        try {
          json = JSON.parse(lines.slice(i + 2, close).join("\n"));
        } catch {
          // Leave `json` undefined; the block is still stripped.
        }
      }
      end = offsets[Math.min(close + 1, lines.length)];
      i = close;
    } else {
      let blank = i + 1;
      while (blank < lines.length && lines[blank].trim() !== "") blank++;
      end = offsets[Math.min(blank + 1, lines.length)];
      i = blank;
    }
    blocks.push({ start, end, json });
  }
  return blocks;
}

/**
 * Extract sender_id from OpenClaw's injected inbound metadata blocks.
 * Reads both "Conversation info" and "Sender" blocks, in either the 2026.8.1+
 * `⟦openclaw:ctx⟧` marker form or the legacy "(untrusted metadata)" form.
 * Returns the first sender_id / id string found, or undefined if none.
 */
export function extractSenderIdFromText(text: string): string | undefined {
  if (!text) return undefined;
  for (const block of findInboundMetaBlocks(text)) {
    const obj = block.json as { sender_id?: unknown; id?: unknown } | undefined;
    const id = obj?.sender_id ?? obj?.id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

const INTERNAL_RUNTIME_CONTEXT_RE =
  /(?:^|\r?\n)?<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?(?:<<<END_OPENCLAW_INTERNAL_CONTEXT>>>(?:\r?\n|$)?|$)/g;

/**
 * Strip OpenClaw's protected internal runtime context blocks
 * (<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> ... <<<END_OPENCLAW_INTERNAL_CONTEXT>>>).
 */
export function stripInternalRuntimeContext(content: string): string {
  if (!content || typeof content !== "string") return content;
  if (
    !content.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") &&
    !content.includes("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>")
  ) {
    return content;
  }
  return content.replace(INTERNAL_RUNTIME_CONTEXT_RE, "\n").trim();
}

/**
 * Sanitize protected OpenClaw internal runtime context blocks across adjacent
 * text blocks within a message.
 *
 * OpenClaw message content can arrive as an array of content blocks where the
 * opening delimiter (<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>) is in one block and
 * the closing delimiter (<<<END_OPENCLAW_INTERNAL_CONTEXT>>>) is in a subsequent block.
 * This function tracks context-block state across blocks so that:
 * 1. Surrounding genuine user text before and after the delimiters is preserved.
 * 2. Intermediate payload text and delimiters are stripped across all affected blocks.
 * 3. The original ordering of text and toolCall blocks is preserved.
 */
export function sanitizeInternalRuntimeContextFromBlocks<T = any>(
  blocks: T[],
): T[] {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks;
  }

  const hasMarker = blocks.some(
    (b: any) =>
      b &&
      typeof b === "object" &&
      typeof b.text === "string" &&
      (b.text.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") ||
        b.text.includes("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>")),
  );
  if (!hasMarker) {
    return blocks;
  }

  let inContext = false;
  const result: T[] = [];

  for (const block of blocks) {
    if (
      !block ||
      typeof block !== "object" ||
      ((block as any).type !== "text" && (block as any).type !== undefined) ||
      typeof (block as any).text !== "string"
    ) {
      result.push(block);
      continue;
    }

    let remaining = (block as any).text as string;
    let resultText = "";

    while (remaining.length > 0) {
      if (!inContext) {
        const beginMatch = remaining.match(
          /(?:^|\r?\n)?<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>/i,
        );
        if (!beginMatch || beginMatch.index === undefined) {
          const orphanEndMatch = remaining.match(
            /<<<END_OPENCLAW_INTERNAL_CONTEXT>>>(?:\r?\n|$)?/i,
          );
          if (orphanEndMatch && orphanEndMatch.index !== undefined) {
            resultText += remaining.slice(0, orphanEndMatch.index);
            remaining = remaining.slice(
              orphanEndMatch.index + orphanEndMatch[0].length,
            );
            continue;
          }
          resultText += remaining;
          remaining = "";
        } else {
          resultText += remaining.slice(0, beginMatch.index);
          remaining = remaining.slice(beginMatch.index + beginMatch[0].length);
          inContext = true;
        }
      } else {
        const endMatch = remaining.match(
          /<<<END_OPENCLAW_INTERNAL_CONTEXT>>>(?:\r?\n|$)?/i,
        );
        if (!endMatch || endMatch.index === undefined) {
          remaining = "";
        } else {
          remaining = remaining.slice(endMatch.index + endMatch[0].length);
          inContext = false;
        }
      }
    }

    result.push({
      ...block,
      text: resultText,
    });
  }

  return result;
}

/**
 * Strip OpenClaw sender/conversation metadata envelopes from message content.
 * These blocks are injected by OpenClaw but are noise for memory storage and recall.
 */
export function stripMetadataEnvelopes(content: string): string {
  if (!content) return content;
  content = stripInternalRuntimeContext(content);
  const blocks = findInboundMetaBlocks(content);
  if (blocks.length > 0) {
    const parts: string[] = [];
    let cursor = 0;
    for (const block of blocks) {
      parts.push(content.slice(cursor, Math.max(cursor, block.start)));
      cursor = Math.max(cursor, block.end);
    }
    parts.push(content.slice(cursor));
    content = parts.join("");
  }
  // Drop the `---` fences that wrapped the legacy envelope form.
  content = content.replace(/^---\n/, "").replace(/\n---$/, "");
  return stripRuntimeEnvelope(content).trim();
}

const RUNTIME_MESSAGE_ID_LINE_RE =
  /^\[message_id:\s*(?:om|ou|oc)_[A-Za-z0-9_-]+\]$/i;
const RUNTIME_OPAQUE_ID_LINE_RE = /^(?:om|ou|oc)_[A-Za-z0-9_-]+$/i;
const RUNTIME_OPAQUE_SENDER_PREFIX_RE =
  /^\s*(?:om|ou|oc)_[A-Za-z0-9_-]+\s*:\s*/i;

// Opt-in display-name prefix stripping (#3070). Some channels prepend a human
// display name to the user text ("Alice: today weather?"), which pollutes both
// the recall query and the retained transcript (the name gets extracted as a
// fact). No payload field carries the display name, and a generic `Word:`
// heuristic would eat ordinary user text ("计划: 今天修 retain 污染"), so the
// pattern is operator-supplied. Unset = byte-identical to the old behaviour.
// One process-global compiled pattern, armed from getPluginConfig(): the host
// holds a single hindsight config, so every session in the process
// shares it. Compile per config if that ever stops being true.
let senderPrefixRe: RegExp | undefined;
let senderPrefixSource: string | undefined;

/**
 * Set (or clear) the display-name prefix pattern stripped by
 * {@link stripRuntimeEnvelope}. The pattern is the name alternation only
 * (e.g. `Alice|Bob` or `[A-Za-z ]{1,20}`); the anchor, surrounding whitespace
 * and the `:` separator are supplied here. An invalid regex fails closed:
 * stripping stays off and nothing throws.
 */
export function configureSenderPrefixStripping(
  pattern: string | undefined,
): void {
  if (pattern === senderPrefixSource) return; // no recompile, and no repeat warn
  senderPrefixSource = pattern;
  if (!pattern) {
    senderPrefixRe = undefined;
    return;
  }
  try {
    senderPrefixRe = new RegExp(`^\\s*(?:${pattern})\\s*:\\s*`);
  } catch (error) {
    senderPrefixRe = undefined;
    log.warn(
      `ignoring invalid senderPrefixPattern ${JSON.stringify(pattern)}: ${error}`,
    );
  }
}

/**
 * Strip inline OpenClaw/Feishu runtime headers that can appear before user text.
 * These identifiers are routing/runtime metadata, not semantic conversation content.
 */
export function stripRuntimeEnvelope(content: string): string {
  if (!content) return content;

  const lines = content.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    return (
      !RUNTIME_MESSAGE_ID_LINE_RE.test(trimmed) &&
      !RUNTIME_OPAQUE_ID_LINE_RE.test(trimmed)
    );
  });

  const stripped = kept.join("\n").replace(RUNTIME_OPAQUE_SENDER_PREFIX_RE, "");
  return senderPrefixRe ? stripped.replace(senderPrefixRe, "") : stripped;
}

/**
 * Sanitize the current request, or a legacy prepared prompt when unavailable.
 *
 * Prefers the current request. Falls back to the legacy prompt, stripping
 * envelope formatting (System: lines, [Channel ...] headers, [from: X] footers).
 *
 * Returns null when no usable query (< 5 chars) can be extracted.
 */
export function extractRecallQuery(
  currentRequest: string | undefined,
  prompt: string | undefined,
): string | null {
  // Reject known metadata/system message patterns — these are not user queries
  const METADATA_PATTERNS = [
    /^\s*conversation info\s*\(untrusted metadata\)/i,
    /^\s*\(untrusted metadata\)/i,
    /^\s*system:/i,
    /^\s*\[Subagent Context\]/i,
    /^\s*\[Inter-session message\]/i,
  ];
  const isMetadata = (s: string) =>
    METADATA_PATTERNS.some((p) => p.test(s)) ||
    // 2026.8.1+ marker form: a leftover header line is metadata, not a query.
    isInboundMetaHeaderLine(s.split("\n")[0] ?? "");

  let recallQuery = currentRequest;
  // Strip sender metadata envelope before any checks
  if (recallQuery) {
    recallQuery = stripRuntimeEnvelope(
      stripInlineTimestampPrefix(stripMetadataEnvelopes(recallQuery)),
    );
  }
  if (
    !recallQuery ||
    typeof recallQuery !== "string" ||
    recallQuery.trim().length < 5 ||
    isMetadata(recallQuery) ||
    isEphemeralOperationalText(recallQuery)
  ) {
    recallQuery = prompt;
    // Strip metadata envelopes from prompt too, then check if anything useful remains
    if (recallQuery) {
      recallQuery = stripRuntimeEnvelope(
        stripInlineTimestampPrefix(stripMetadataEnvelopes(recallQuery)),
      );
    }
    if (!recallQuery || recallQuery.length < 5) {
      return null;
    }

    // Strip envelope-formatted prompts from any channel
    let cleaned = recallQuery;

    // Remove leading "System: ..." lines (from prependSystemEvents)
    cleaned = cleaned.replace(/^(?:System:.*\n)+\n?/, "");

    // Remove session abort hint
    cleaned = cleaned.replace(
      /^Note: The previous agent run was aborted[^\n]*\n\n/,
      "",
    );

    if (isMetadata(cleaned) || isEphemeralOperationalText(cleaned)) {
      return null;
    }

    // Extract message after [ChannelName ...] envelope header
    const envelopeMatch = cleaned.match(
      /\[[A-Z][A-Za-z]*(?:\s[^\]]+)?\]\s*([\s\S]+)$/,
    );
    if (envelopeMatch) {
      cleaned = envelopeMatch[1];
    }

    // Remove trailing [from: SenderName] metadata (group chats)
    cleaned = cleaned.replace(/\n\[from:[^\]]*\]\s*$/, "");

    // Strip metadata envelopes again after channel envelope extraction, in case
    // the metadata block appeared after the [ChannelName] header
    cleaned = stripRuntimeEnvelope(
      stripInlineTimestampPrefix(stripMetadataEnvelopes(cleaned)),
    );

    recallQuery = cleaned.trim() || recallQuery;
  }

  const trimmed = recallQuery.trim();
  if (
    trimmed.length < 5 ||
    isMetadata(trimmed) ||
    isEphemeralOperationalText(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

export function composeRecallQuery(
  latestQuery: string,
  messages: any[] | undefined,
  recallContextTurns: number,
  recallRoles: Array<"user" | "assistant" | "system" | "tool"> = [
    "user",
    "assistant",
  ],
): string {
  const latest = latestQuery.trim();
  if (
    recallContextTurns <= 1 ||
    !Array.isArray(messages) ||
    messages.length === 0
  ) {
    return latest;
  }

  const allowedRoles = new Set(recallRoles);
  const contextualMessages = sliceLastTurnsByUserBoundary(
    messages,
    recallContextTurns,
  );
  const contextLines = contextualMessages
    .map((msg: any) => {
      const role = msg?.role;
      if (!allowedRoles.has(role)) {
        return null;
      }

      let content = "";
      if (typeof msg?.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg?.content)) {
        content = msg.content
          .filter(
            (block: any) =>
              block?.type === "text" && typeof block?.text === "string",
          )
          .map((block: any) => block.text)
          .join("\n");
      }

      content = stripMemoryTags(content).trim();
      content = stripMetadataEnvelopes(content);
      content = stripRuntimeEnvelope(stripInlineTimestampPrefix(content));
      if (!content) {
        return null;
      }
      if (
        role === "user" &&
        (content === latest || isEphemeralOperationalText(content))
      ) {
        return null;
      }
      return `${role}: ${content}`;
    })
    .filter((line: string | null): line is string => Boolean(line));

  if (contextLines.length === 0) {
    return latest;
  }

  return ["Prior context:", contextLines.join("\n"), latest].join("\n\n");
}

export function truncateRecallQuery(
  query: string,
  latestQuery: string,
  maxChars: number,
): string {
  if (maxChars <= 0) {
    return query;
  }

  const latest = latestQuery.trim();
  if (query.length <= maxChars) {
    return query;
  }

  const latestOnly =
    latest.length <= maxChars ? latest : latest.slice(0, maxChars);

  if (!query.includes("Prior context:")) {
    return latestOnly;
  }

  // New order: Prior context at top, latest user message at bottom.
  // Truncate by dropping oldest context lines first to preserve the suffix.
  const contextMarker = "Prior context:\n\n";
  const markerIndex = query.indexOf(contextMarker);
  if (markerIndex === -1) {
    return latestOnly;
  }

  const suffixMarker = "\n\n" + latest;
  const suffixIndex = query.lastIndexOf(suffixMarker);
  if (suffixIndex === -1) {
    return latestOnly;
  }

  const suffix = query.slice(suffixIndex); // \n\n<latest>
  if (suffix.length >= maxChars) {
    return latestOnly;
  }

  const contextBody = query.slice(
    markerIndex + contextMarker.length,
    suffixIndex,
  );
  const contextLines = contextBody.split("\n").filter(Boolean);
  const keptContextLines: string[] = [];

  // Add context lines from newest (bottom) to oldest (top), stopping when we exceed maxChars
  for (let i = contextLines.length - 1; i >= 0; i--) {
    keptContextLines.unshift(contextLines[i]);
    const candidate = `${contextMarker}${keptContextLines.join("\n")}${suffix}`;
    if (candidate.length > maxChars) {
      keptContextLines.shift();
      break;
    }
  }

  if (keptContextLines.length > 0) {
    return `${contextMarker}${keptContextLines.join("\n")}${suffix}`;
  }

  return latestOnly;
}

/**
 * Parse the OpenClaw sessionKey to extract context fields.
 * Format: "agent:{agentId}:{provider}:{channelType}:{channelId}[:{extra}]"
 * Example: "agent:c0der:telegram:group:-1003825475854:topic:42"
 */
// Some OpenClaw hook contexts populate `ctx.channelId` with the provider name
// (e.g. "discord") instead of the actual channel ID. Treat those as missing so
// we fall through to the sessionKey-derived channel. See issue #854.
const PROVIDER_CHANNEL_ID_TOKENS = new Set([
  "discord",
  "telegram",
  "slack",
  "matrix",
  "whatsapp",
  "signal",
  "messenger",
  "sms",
  "email",
  "web",
  "cli",
]);

function sanitizeChannelId(
  channelId: string | undefined,
  provider?: string,
): string | undefined {
  if (!channelId) return undefined;
  if (provider && channelId === provider) return undefined;
  if (PROVIDER_CHANNEL_ID_TOKENS.has(channelId.toLowerCase())) return undefined;
  return channelId;
}

export interface ParsedSessionKey {
  agentId?: string;
  provider?: string;
  channel?: string;
}

export function parseSessionKey(sessionKey: string): ParsedSessionKey {
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent") return {};
  if (parts.length === 3 && parts[2] === "main") {
    return {
      agentId: parts[1],
      provider: "main",
      channel: "main",
    };
  }
  // OpenClaw's Control UI creates `agent:<id>:dashboard:<opaque-id>` keys.
  // Recover only the agent identity: "dashboard" is a session namespace, not
  // the live message provider used for dynamic bank routing.
  if (parts.length === 4 && parts[2] === "dashboard") {
    return {
      agentId: parts[1],
    };
  }
  if (
    parts.length >= 4 &&
    ["cron", "heartbeat", "subagent"].includes(parts[2])
  ) {
    return {
      agentId: parts[1],
      provider: parts[2],
      channel: parts.slice(3).join(":"),
    };
  }
  if (parts.length < 5) return {};
  // parts[1] = agentId, parts[2] = provider, parts[3] = channelType, parts[4..] = channelId + extras
  return {
    agentId: parts[1],
    provider: parts[2],
    // Rejoin from channelType onward as the channel identifier (e.g. "group:-1003825475854:topic:42")
    channel: parts.slice(3).join(":"),
  };
}

export function extractTelegramDirectSenderId(
  channelId: string | undefined,
): string | undefined {
  if (typeof channelId !== "string") return undefined;
  const match = channelId.match(/^direct:([^:]+)$/);
  return match?.[1];
}

export function resolveSessionIdentity(
  ctx: PluginHookAgentContext | undefined,
): PluginHookAgentContext | undefined {
  if (!ctx) return undefined;

  const sessionParsed = ctx.sessionKey ? parseSessionKey(ctx.sessionKey) : {};
  const messageProvider = ctx.messageProvider || sessionParsed.provider;
  const channelId = ctx.channelId || sessionParsed.channel;
  // direct:<id> channel ids carry the user id for any provider (telegram, msteams, …).
  const senderId = ctx.senderId || extractTelegramDirectSenderId(channelId);

  return {
    ...ctx,
    agentId: ctx.agentId || sessionParsed.agentId,
    messageProvider,
    channelId,
    senderId,
  };
}

function retryableSkipReason(
  detail: "missing stable message provider" | "missing stable sender identity",
): IdentitySkipReason {
  return { kind: "retryable", detail };
}

function finalSkipReason(detail: string): IdentitySkipReason {
  return { kind: "final", detail };
}

function formatIdentitySkipReason(
  reason: IdentitySkipReason | undefined,
): string | undefined {
  return reason?.detail;
}

function isRetryableIdentitySkipReason(
  reason: IdentitySkipReason | undefined,
): boolean {
  return reason?.kind === "retryable";
}

/**
 * Log an identity-skip event at info level, throttled to once per session key
 * per process lifetime. This makes silent skips visible to operators without
 * flooding the log on every turn.
 */
function logSkipOnce(
  operation: "recall" | "retain" | "dispatch",
  sessionKey: string | undefined,
  reason: IdentitySkipReason,
): void {
  if (!sessionKey) return;
  const cacheKey = `${operation}:${sessionKey}`;
  if (loggedSkipSessions.has(cacheKey)) return;
  loggedSkipSessions.add(cacheKey);
  const hint =
    reason.kind === "final"
      ? ". If unexpected, set dynamicBankGranularity to ['agent','channel','user'] or use static banking (dynamicBankId: false + bankId: '<name>')"
      : "";
  log.info(
    `Skipping ${operation} on session '${sessionKey}': ${reason.detail}${hint}`,
  );
}

function cacheSessionIdentity(
  sessionKey: string | undefined,
  resolvedCtx: PluginHookAgentContext | undefined,
): void {
  if (!sessionKey || !resolvedCtx) return;
  if (
    !resolvedCtx.messageProvider &&
    !resolvedCtx.channelId &&
    !resolvedCtx.senderId
  )
    return;

  setCappedMapValue(sessionIdentityBySession, sessionKey, {
    senderId: resolvedCtx.senderId,
    messageProvider: resolvedCtx.messageProvider,
    channelId: resolvedCtx.channelId,
  });
}

export interface ResolveAndCacheIdentityOptions {
  sessionKey?: string;
  ctx?: PluginHookAgentContext;
  senderIdHint?: string;
  dispatchChannel?: string;
  pluginConfig?: PluginConfig;
}

export function resolveAndCacheIdentity(
  options: ResolveAndCacheIdentityOptions,
): {
  effectiveCtx: PluginHookAgentContext | undefined;
  resolvedCtx: PluginHookAgentContext | undefined;
  skipReason?: IdentitySkipReason;
} {
  const sessionKey = options.sessionKey ?? options.ctx?.sessionKey;
  const parsedSession = sessionKey ? parseSessionKey(sessionKey) : {};
  const cachedIdentity = sessionKey
    ? sessionIdentityBySession.get(sessionKey)
    : undefined;
  const baseCtx =
    options.ctx ||
    (sessionKey ? ({ sessionKey } as PluginHookAgentContext) : undefined);
  // "main" is the synthetic provider produced by parseSessionKey for default
  // `agent:<id>:main` sessions — the *real* dispatch surface (telegram,
  // webchat, qqbot, …) is whatever the dispatcher provides. Treat it as if
  // the session key carried no provider so the dispatchChannel flows through
  // as the effective surface for downstream identity resolution. (#1541)
  const sessionProvider =
    parsedSession.provider && parsedSession.provider !== "main"
      ? parsedSession.provider
      : undefined;
  const effectiveCtx =
    baseCtx ||
    cachedIdentity ||
    options.senderIdHint ||
    options.dispatchChannel ||
    sessionKey
      ? {
          ...baseCtx,
          sessionKey: baseCtx?.sessionKey || sessionKey,
          agentId: baseCtx?.agentId || parsedSession.agentId,
          messageProvider:
            baseCtx?.messageProvider ?? cachedIdentity?.messageProvider,
          channelId: baseCtx?.channelId ?? cachedIdentity?.channelId,
          senderId:
            baseCtx?.senderId ||
            cachedIdentity?.senderId ||
            options.senderIdHint,
        }
      : undefined;
  const resolvedCtx = resolveSessionIdentity(
    effectiveCtx
      ? {
          ...effectiveCtx,
          messageProvider:
            effectiveCtx.messageProvider ??
            sessionProvider ??
            options.dispatchChannel,
          channelId: effectiveCtx.channelId ?? parsedSession.channel,
        }
      : undefined,
  );

  // The dispatch-surface gate guards against retaining a turn into a bank
  // keyed by the *wrong* channel when the user has explicitly opted into
  // channel-scoped routing. Only fire when:
  //   - The session key carries a real (non-synthetic) provider.
  //   - The live dispatch surface actually differs from it.
  //   - Bank routing depends on the dispatch surface (granularity includes
  //     "channel" or "provider") AND the user has not pinned a static bank.
  // Without these guards, default `agent:<id>:main` sessions dispatched via
  // a real surface (telegram, webchat, …) and statically-banked setups were
  // silently skipped on every turn. (#1541)
  const granularity =
    options.pluginConfig?.dynamicBankGranularity ??
    DEFAULT_DYNAMIC_BANK_GRANULARITY;
  const bankRoutingDependsOnSurface =
    granularity.includes("channel") || granularity.includes("provider");
  const staticBanking =
    options.pluginConfig?.dynamicBankId === false &&
    typeof options.pluginConfig?.bankId === "string" &&
    options.pluginConfig.bankId.length > 0;
  // A mapped agent is pinned the same way a static bank is: its bank comes from
  // the map, not from the dispatch surface, so a surface mismatch cannot route
  // the turn into the wrong bank and must not skip it. (#3890)
  const mappedBanking =
    options.pluginConfig !== undefined &&
    mappedBankIdForAgent(resolvedCtx ?? effectiveCtx, options.pluginConfig) !==
      undefined;

  if (
    sessionProvider &&
    options.dispatchChannel &&
    sessionProvider !== options.dispatchChannel &&
    bankRoutingDependsOnSurface &&
    !staticBanking &&
    !mappedBanking
  ) {
    const skipReason = finalSkipReason(
      `dispatch surface ${options.dispatchChannel} does not match session provider ${sessionProvider}`,
    );
    if (sessionKey) {
      setCappedMapValue(skipHindsightTurnBySession, sessionKey, skipReason);
    }
    return { effectiveCtx, resolvedCtx, skipReason };
  }

  const { resolvedCtx: identityCtx, reason: skipReason } =
    getIdentitySkipReason(resolvedCtx, options.pluginConfig);
  cacheSessionIdentity(sessionKey, identityCtx);
  if (sessionKey) {
    if (skipReason) {
      setCappedMapValue(skipHindsightTurnBySession, sessionKey, skipReason);
    } else {
      skipHindsightTurnBySession.delete(sessionKey);
    }
  }

  return { effectiveCtx, resolvedCtx: identityCtx, skipReason };
}

export function getIdentitySkipReason(
  ctx: PluginHookAgentContext | undefined,
  pluginConfig?: PluginConfig,
): {
  resolvedCtx: PluginHookAgentContext | undefined;
  reason?: IdentitySkipReason;
} {
  const resolvedCtx = resolveSessionIdentity(ctx);
  const sessionKey = resolvedCtx?.sessionKey;
  // The "internal main" / "operational provider main" / "anonymous sender" filters
  // exist to keep the default multi-tenant bank from being polluted by CLI/main
  // sessions that lack a stable identity. They should NOT fire when the user has
  // explicitly opted into a routing scheme that expects those sessions:
  //   - dynamicBankGranularity includes 'agent' (the default) → each agent
  //     (including 'main') gets its own bank
  //   - dynamicBankId === false with a configured bankId → user pinned a single
  //     named bank and wants every session retained into it
  // When dynamicBankGranularity is unset, the default is ["agent","channel","user"]
  // which includes "agent", so agentBanking defaults to true to match deriveBankId.
  const agentBanking =
    pluginConfig?.dynamicBankGranularity?.includes("agent") ?? true;
  const staticBanking =
    pluginConfig?.dynamicBankId === false &&
    typeof pluginConfig?.bankId === "string" &&
    pluginConfig.bankId.length > 0;
  //   - the agent has an explicit agentBankMap entry → the operator named that
  //     bank for this agent, so its sessions belong there too (#3890)
  const mappedBanking =
    pluginConfig !== undefined &&
    mappedBankIdForAgent(resolvedCtx, pluginConfig) !== undefined;
  const allowCliSessions = agentBanking || staticBanking || mappedBanking;

  if (typeof sessionKey === "string") {
    if (/^agent:[^:]+:(cron|heartbeat|subagent):/.test(sessionKey)) {
      return {
        resolvedCtx,
        reason: finalSkipReason(`operational session ${sessionKey}`),
      };
    }
    if (!allowCliSessions && /^agent:[^:]+:main$/.test(sessionKey)) {
      return {
        resolvedCtx,
        reason: finalSkipReason(`internal main session ${sessionKey}`),
      };
    }
    if (/^temp:/.test(sessionKey)) {
      return {
        resolvedCtx,
        reason: finalSkipReason(`ephemeral temp session ${sessionKey}`),
      };
    }
  }

  const operationalProviders = allowCliSessions
    ? ["cron", "heartbeat", "subagent"]
    : ["cron", "heartbeat", "subagent", "main"];
  if (
    resolvedCtx?.messageProvider &&
    operationalProviders.includes(resolvedCtx.messageProvider)
  ) {
    return {
      resolvedCtx,
      reason: finalSkipReason(
        `operational provider ${resolvedCtx.messageProvider}`,
      ),
    };
  }
  if (
    !resolvedCtx?.messageProvider ||
    resolvedCtx.messageProvider === "unknown"
  ) {
    return {
      resolvedCtx,
      reason: retryableSkipReason("missing stable message provider"),
    };
  }
  if (!resolvedCtx?.senderId || resolvedCtx.senderId === "anonymous") {
    if (allowCliSessions && resolvedCtx?.agentId) {
      resolvedCtx.senderId = `agent-user:${resolvedCtx.agentId}`;
    } else {
      return {
        resolvedCtx,
        reason: retryableSkipReason("missing stable sender identity"),
      };
    }
  }
  if (
    resolvedCtx.messageProvider === "telegram" &&
    typeof resolvedCtx.channelId === "string" &&
    resolvedCtx.channelId.startsWith("direct:")
  ) {
    const directSenderId = extractTelegramDirectSenderId(resolvedCtx.channelId);
    if (!directSenderId || directSenderId !== resolvedCtx.senderId) {
      return {
        resolvedCtx,
        reason: finalSkipReason(
          `telegram direct identity mismatch (${resolvedCtx.channelId} vs ${resolvedCtx.senderId})`,
        ),
      };
    }
  }

  return { resolvedCtx, reason: undefined };
}

// OpenClaw-generated operational/session-bootstrap prefixes. These are not
// user-authored content, so they should not create recall/retain entries.
const OPERATIONAL_TEXT_PATTERNS: readonly RegExp[] = [
  /^A new session was started via \/(?:new|reset)\./i,
  /^Based on this conversation, generate a short 1-2/i,
  /^This (?:script|task|job|workflow) updates .* index/i,
  /^\[Subagent Context\]/i,
  /^Every subagent in this batch has now settled/i,
  /^Your prior run ended while waiting for descendant subagent completions/i,
  /^All pending descendants for that run have now settled/i,
  /^Child completion results:/i,
  /^\[Inter-session message\]/i,
  /^System Alert: The Gateway service has just restarted\./i,
  /^The conversation history before this point was compacted into the following summary:/i,
  /^The following is a summary of a branch that this conversation came back from:/i,
];

// OpenClaw internal in-turn continuation / recovery retry prompts injected
// when an embedded attempt retries after auto-compaction or incomplete output.
// These must not trigger memory recall and must not split or suppress the
// surrounding user turn during retention.
const CONTINUATION_RETRY_TEXT_PATTERNS: readonly RegExp[] = [
  /^Continue the current task from the existing transcript, preserving completed work\./i,
  /^The session context was compacted during this turn, and the previous reply only acknowledged starting the work\./i,
  /^A final-turn hook rejected the previous draft reply before delivery\./i,
  /^The previous assistant turn recorded reasoning but did not produce a user-visible answer\./i,
  /^The previous attempt did not produce a user-visible answer\./i,
  /^The previous assistant turn stopped for tool use but contained no tool call, so nothing ran\./i,
  /^The previous assistant turn completed its tool calls but did not produce a user-visible answer\./i,
];

const INTERNAL_CONTEXT_MARKER_RE = /<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>/i;

export function isContinuationRetryPromptText(
  text: string | undefined,
): boolean {
  if (!text || typeof text !== "string") return false;

  let normalized = text
    .replace(/\[role:\s*[^\]]+\]\s*/gi, "")
    .replace(/\[[a-z]+:end\]\s*/gi, "")
    .trim();

  if (INTERNAL_CONTEXT_MARKER_RE.test(normalized)) {
    normalized = stripInternalRuntimeContext(normalized).trim();
  }
  if (!normalized) return false;

  return CONTINUATION_RETRY_TEXT_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

export function isEphemeralOperationalText(text: string | undefined): boolean {
  if (!text || typeof text !== "string") return false;

  let normalized = text
    .replace(/\[role:\s*[^\]]+\]\s*/gi, "")
    .replace(/\[[a-z]+:end\]\s*/gi, "")
    .trim();

  // A protected runtime-context block is classified by what surrounds it, not
  // by its mere presence: a block on its own is internal, but genuine user text
  // that merely carries one must still be recalled/retained.
  if (INTERNAL_CONTEXT_MARKER_RE.test(normalized)) {
    normalized = stripInternalRuntimeContext(normalized).trim();
    if (!normalized) return true;
  }

  return (
    OPERATIONAL_TEXT_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    CONTINUATION_RETRY_TEXT_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

/**
 * Whether input provenance marks an OpenClaw inter-session message or an
 * internal subagent coordination/settlement event.
 */
function isInternalProvenance(prov: InputProvenance | undefined): boolean {
  if (!prov) return false;
  return (
    prov.kind === "inter_session" ||
    prov.kind === "internal_system" ||
    prov.sourceChannel === "internal" ||
    prov.sourceRole === "subagent" ||
    prov.sourceTool === "subagent_settle" ||
    prov.sourceTool === "subagent_announce"
  );
}

/**
 * Check whether a hook context represents an OpenClaw inter-session
 * message or internal subagent coordination/settlement wake event.
 */
export function isInterSessionInternalEvent(
  ctx?: PluginHookAgentContext,
): boolean {
  if (ctx?.trigger === "subagent") return true;
  return isInternalProvenance(ctx?.inputProvenance);
}

/**
 * Extract combined text from a message content field (string or block array).
 */
function extractMessageText(content: OpenClawMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const sanitized = sanitizeInternalRuntimeContextFromBlocks(content);
    return sanitized
      .filter(
        (block): block is OpenClawMessageContentBlock & { text: string } =>
          !!block &&
          typeof block === "object" &&
          (block.type === "text" || !block.type) &&
          typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/**
 * Check whether a message is a synthetic OpenClaw mid-turn continuation/retry
 * prompt injected during compaction or incomplete-turn recovery.
 */
export function isContinuationRetryPromptMessage(
  msg: OpenClawMessage | null | undefined,
): boolean {
  if (!msg || typeof msg !== "object" || msg.role !== "user") return false;
  const rawText = extractMessageText(msg.content);
  const cleaned = stripRuntimeEnvelope(
    stripInlineTimestampPrefix(
      stripMetadataEnvelopes(rawText.replace(/^(?:System:.*\n)+\n?/, "")),
    ),
  ).trim();
  if (!cleaned) return false;
  return isContinuationRetryPromptText(cleaned);
}

/**
 * Determine whether a message initiates an actual user turn (as opposed to
 * synthetic messages like tool results or mid-turn continuation prompts
 * normalized into role:"user").
 */
export function isUserTurnInitiator(
  msg: OpenClawMessage | null | undefined,
): boolean {
  if (!msg || msg.role !== "user") return false;
  if (isContinuationRetryPromptMessage(msg)) return false;
  const content = msg.content;
  if (typeof content === "string") return true;
  if (Array.isArray(content)) {
    const hasToolResult = content.some((b) => b?.type === "tool_result");
    const hasText = content.some(
      (b) =>
        !!b &&
        (b.type === "text" || !b.type) &&
        typeof b.text === "string" &&
        b.text.trim().length > 0,
    );
    if (hasToolResult && !hasText) {
      return false;
    }
    return true;
  }
  return true;
}

/**
 * Check whether message content carries protected OpenClaw internal runtime
 * context markers (<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> or <<<END_OPENCLAW_INTERNAL_CONTEXT>>>).
 */
function hasProtectedRuntimeContext(
  content: OpenClawMessage["content"],
): boolean {
  if (typeof content === "string") {
    return (
      content.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") ||
      content.includes("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>")
    );
  }
  if (Array.isArray(content)) {
    return content.some(
      (b: any) =>
        b &&
        typeof b === "object" &&
        typeof b.text === "string" &&
        (b.text.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") ||
          b.text.includes("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>")),
    );
  }
  return false;
}

/**
 * Check whether a message represents an internal, subagent, or operational turn
 * that should not be retained in long-term memory.
 *
 * Provenance markers skip immediately. Text classification runs only after the
 * protected runtime-context block and other envelopes are stripped, so genuine
 * user text that merely carries such a block is kept, while context-only and
 * residual settlement messages are discarded.
 */
export function isInternalOrOperationalTurnMessage(
  msg: OpenClawMessage | null | undefined,
): boolean {
  if (!msg || typeof msg !== "object") return false;

  if (msg.trigger === "subagent") return true;
  if (isInternalProvenance(msg.inputProvenance ?? msg.provenance)) return true;

  const hadProtectedContext = hasProtectedRuntimeContext(msg.content);

  const rawText = extractMessageText(msg.content);
  const cleaned = stripRuntimeEnvelope(
    stripInlineTimestampPrefix(
      stripMetadataEnvelopes(rawText.replace(/^(?:System:.*\n)+\n?/, "")),
    ),
  ).trim();

  if (!cleaned) {
    // Nothing user-authored survives. Only a protected runtime-context block
    // makes that internal; a metadata-only message keeps its prior handling.
    return hadProtectedContext;
  }

  return isEphemeralOperationalText(cleaned);
}

/**
 * Filter internal, subagent, or operational turns at the message/turn boundary.
 * For any turn whose initiating user message is internal/operational, the entire
 * turn (the user message and any subsequent assistant/tool messages) is omitted,
 * while preserving neighboring genuine user turns.
 */
export function filterInternalAndOperationalTurns<T extends OpenClawMessage>(
  messages: T[],
): T[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const keptMessages: T[] = [];
  let skipTurn = false;
  let hasGenuineUser = false;
  for (const msg of messages) {
    if (isContinuationRetryPromptMessage(msg)) {
      continue;
    }
    if (isUserTurnInitiator(msg)) {
      skipTurn = isInternalOrOperationalTurnMessage(msg);
      if (!skipTurn) hasGenuineUser = true;
    }
    if (!skipTurn) keptMessages.push(msg);
  }
  return hasGenuineUser ? keptMessages : [];
}

function setCappedMapValue<K, V>(map: Map<K, V>, key: K, value: V): void {
  // FIFO cap, not LRU: updating an existing key keeps its original insertion order.
  map.set(key, value);
  if (map.size > MAX_TRACKED_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
}

/**
 * Derive a bank ID from the agent context.
 * Uses configurable dynamicBankGranularity to determine bank segmentation.
 * Falls back to default bank when context is unavailable.
 */
export function deriveBankId(
  ctx: PluginHookAgentContext | undefined,
  pluginConfig: PluginConfig,
): string {
  // An explicit agent -> bank mapping wins over both the static bank and dynamic
  // derivation, so a gateway can give one group of agents a shared bank while the
  // rest keep derived ones (#3890). Resolved only when a map is configured, so the
  // common path is untouched.
  const mappedBankId = mappedBankIdForAgent(ctx, pluginConfig);
  if (mappedBankId) {
    return mappedBankId;
  }

  if (pluginConfig.dynamicBankId === false) {
    return getStaticBankId(pluginConfig);
  }

  // When no context is available, fall back to the static default bank.
  if (!ctx) {
    return getDefaultBankId(pluginConfig);
  }

  const resolvedCtx = resolveSessionIdentity(ctx);
  const fields = pluginConfig.dynamicBankGranularity?.length
    ? pluginConfig.dynamicBankGranularity
    : DEFAULT_DYNAMIC_BANK_GRANULARITY;

  // Validate field names at runtime — typos silently produce 'unknown' segments
  const validFields = new Set(["agent", "channel", "user", "provider"]);
  for (const f of fields) {
    if (!validFields.has(f)) {
      log.warn(
        `unknown dynamicBankGranularity field "${f}" — will resolve to "unknown". Valid: agent, channel, user, provider`,
      );
    }
  }

  // Parse sessionKey as fallback when direct context fields are missing
  const sessionParsed = resolvedCtx?.sessionKey
    ? parseSessionKey(resolvedCtx.sessionKey)
    : {};

  // Warn when 'user' is in active fields but senderId is missing — bank ID will contain "anonymous"
  if (fields.includes("user") && resolvedCtx && !resolvedCtx.senderId) {
    debug(
      '[Hindsight] senderId not available in context — bank ID will use "anonymous". Ensure your OpenClaw provider passes senderId.',
    );
  }

  const fieldMap: Record<string, string> = {
    agent: resolvedCtx?.agentId || sessionParsed.agentId || "default",
    channel:
      sanitizeChannelId(
        resolvedCtx?.channelId,
        resolvedCtx?.messageProvider || sessionParsed.provider,
      ) ||
      sessionParsed.channel ||
      "unknown",
    user: resolvedCtx?.senderId || "anonymous",
    provider:
      resolvedCtx?.messageProvider || sessionParsed.provider || "unknown",
  };

  const baseBankId = fields
    .map((f) => encodeURIComponent(fieldMap[f] || "unknown"))
    .join("::");

  return pluginConfig.bankIdPrefix
    ? `${pluginConfig.bankIdPrefix}-${baseBankId}`
    : baseBankId;
}

function usesUserScopedBanking(pluginConfig: PluginConfig): boolean {
  if (usesStaticBank(pluginConfig)) {
    return false;
  }
  const granularity = pluginConfig.dynamicBankGranularity?.length
    ? pluginConfig.dynamicBankGranularity
    : DEFAULT_DYNAMIC_BANK_GRANULARITY;
  return granularity.includes("user");
}

export interface KnowledgeToolBankResolution {
  bankId: string;
  resolvedCtx: PluginHookAgentContext | undefined;
  identityError?: string;
}

/**
 * Resolve the Hindsight bank for knowledge tools using the same identity path as
 * auto-recall/retain. When user-scoped dynamic banking is enabled, unresolved
 * identity must not silently route to the shared default or anonymous bank.
 */
export function resolveBankIdForKnowledgeTools(
  toolCtx: OpenClawPluginToolContext,
  pluginConfig: PluginConfig,
): KnowledgeToolBankResolution {
  const hookCtx: PluginHookAgentContext = {
    agentId: toolCtx.agentId,
    sessionKey: toolCtx.sessionKey,
    workspaceDir: toolCtx.workspaceDir,
    senderId: toolCtx.requesterSenderId,
    messageProvider: toolCtx.messageChannel ?? toolCtx.deliveryContext?.channel,
    channelId: toolCtx.nativeChannelId ?? toolCtx.deliveryContext?.to,
  };

  // An explicitly mapped agent needs no identity resolution: its bank does not
  // depend on the sender, so the user-scoped guards below must not reject it. (#3890)
  const mappedBankId = mappedBankIdForAgent(hookCtx, pluginConfig);
  if (mappedBankId) {
    return { bankId: mappedBankId, resolvedCtx: undefined };
  }

  if (usesStaticBank(pluginConfig)) {
    return { bankId: getStaticBankId(pluginConfig), resolvedCtx: undefined };
  }

  const { resolvedCtx, skipReason } = resolveAndCacheIdentity({
    sessionKey: toolCtx.sessionKey,
    ctx: hookCtx,
    pluginConfig,
  });
  const { reason: identityReason } = getIdentitySkipReason(
    resolvedCtx,
    pluginConfig,
  );
  const effectiveSkip = skipReason ?? identityReason;
  const bankId = deriveBankId(resolvedCtx, pluginConfig);

  if (usesUserScopedBanking(pluginConfig)) {
    const userSegment = resolvedCtx?.senderId || "anonymous";
    if (effectiveSkip) {
      return {
        bankId,
        resolvedCtx,
        identityError:
          `Hindsight knowledge tools skipped: ${formatIdentitySkipReason(effectiveSkip)}. ` +
          "Knowledge tools use the same per-user memory bank as auto-recall/retain.",
      };
    }
    if (userSegment === "anonymous") {
      return {
        bankId,
        resolvedCtx,
        identityError:
          "Hindsight knowledge tools skipped: missing stable sender identity. " +
          "Knowledge tools use the same per-user memory bank as auto-recall/retain.",
      };
    }
    if (bankId === getDefaultBankId(pluginConfig)) {
      return {
        bankId,
        resolvedCtx,
        identityError:
          "Hindsight knowledge tools skipped: could not resolve per-user memory bank. " +
          "Knowledge tools use the same per-user memory bank as auto-recall/retain.",
      };
    }
  }

  return { bankId, resolvedCtx };
}

/**
 * Render the event window a memory carries. `mentioned_at` says when the fact
 * was stated; `occurred_start`/`occurred_end` say when the event itself
 * happened, which is what the agent needs to order past events against each
 * other. Either bound can be absent, so each case gets its own wording rather
 * than an open-ended range the model has to guess at.
 */
function formatOccurredWindow(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (start && end) {
    return start === end
      ? ` [occurred: ${start}]`
      : ` [occurred: ${start} → ${end}]`;
  }
  if (start) return ` [occurred from: ${start}]`;
  if (end) return ` [occurred until: ${end}]`;
  return "";
}

export function formatMemories(results: MemoryResult[]): string {
  if (!results || results.length === 0) return "";
  return results
    .map((r) => {
      const type = r.type ? ` [${r.type}]` : "";
      const date = r.mentioned_at ? ` (${r.mentioned_at})` : "";
      const occurred = formatOccurredWindow(r.occurred_start, r.occurred_end);
      const doc = r.document_id ? ` [doc:${r.document_id}]` : "";
      return `- ${r.text}${type}${date}${occurred}${doc}`;
    })
    .join("\n\n");
}

// Providers that authenticate via OAuth or run locally — no API key needed.
const NO_KEY_REQUIRED_PROVIDERS = new Set([
  "ollama",
  "openai-codex",
  "claude-code",
  "github-copilot",
]);

export function detectLLMConfig(pluginConfig?: PluginConfig): {
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  source: string;
} {
  // External API mode: the daemon handles LLM credentials, plugin doesn't need them.
  const externalApiCheck = detectExternalApi(pluginConfig);
  if (externalApiCheck.apiUrl) {
    return {
      provider: undefined,
      apiKey: undefined,
      model: undefined,
      baseUrl: undefined,
      source: "external-api-mode-no-llm",
    };
  }

  const provider = pluginConfig?.llmProvider;
  if (!provider) {
    throw new Error(
      `No LLM provider configured for the Hindsight memory plugin.\n\n` +
        `Set the provider via 'openclaw config set':\n` +
        `  openclaw config set plugins.entries.hindsight-memory.config.llmProvider openai\n\n` +
        `For providers that need an API key, configure it as a SecretRef so the value\n` +
        `is read from an env var (or file/exec source) at runtime instead of stored in plain text:\n` +
        `  openclaw config set plugins.entries.hindsight-memory.config.llmApiKey \\\n` +
        `      --ref-source env --ref-provider default --ref-id OPENAI_API_KEY\n\n` +
        `Providers that don't need an API key: ${[...NO_KEY_REQUIRED_PROVIDERS].join(", ")}.\n` +
        `Or point the plugin at an external Hindsight API by setting hindsightApiUrl instead.`,
    );
  }

  const apiKey = pluginConfig?.llmApiKey ?? "";
  if (!apiKey && !NO_KEY_REQUIRED_PROVIDERS.has(provider)) {
    throw new Error(
      `llmProvider is set to "${provider}" but llmApiKey is empty.\n\n` +
        `Configure it via 'openclaw config set' as a SecretRef:\n` +
        `  openclaw config set plugins.entries.hindsight-memory.config.llmApiKey \\\n` +
        `      --ref-source env --ref-provider default --ref-id OPENAI_API_KEY`,
    );
  }

  return {
    provider,
    apiKey,
    model: pluginConfig?.llmModel,
    baseUrl: pluginConfig?.llmBaseUrl,
    source: "plugin config",
  };
}

/**
 * Detect external Hindsight API configuration from plugin config.
 */
export function detectExternalApi(pluginConfig?: PluginConfig): {
  apiUrl: string | null;
  apiToken: string | null;
} {
  return {
    apiUrl: pluginConfig?.hindsightApiUrl ?? null,
    apiToken: pluginConfig?.hindsightApiToken ?? null,
  };
}

/**
 * The Hindsight API this plugin is currently talking to, whichever mode it is
 * in: the configured external API, or the local daemon we spawned ourselves.
 *
 * Capability probing must not care which one it is — the embedded daemon serves
 * the same `/version` endpoint as any other Hindsight API. Treating local-daemon
 * mode as a special case is precisely what left `supportsUpdateModeAppend` stuck
 * at `false` there, silently downgrading every retain to a per-turn document id.
 * (#3686)
 */
function getActiveApiEndpoint(): {
  apiUrl: string | null;
  apiToken: string | null;
} {
  const externalApi = detectExternalApi(currentPluginConfig ?? undefined);
  if (externalApi.apiUrl) return externalApi;
  return { apiUrl: hindsightServer?.getBaseUrl() ?? null, apiToken: null };
}

/**
 * Build HindsightClientOptions for the generated hindsight-client. In
 * external-API mode we use the configured URL/token; in local daemon mode
 * the caller overrides with the daemon's base URL after start().
 */
export function buildClientOptions(externalApi: {
  apiUrl: string | null;
  apiToken: string | null;
}): HindsightClientOptions {
  return {
    baseUrl: externalApi.apiUrl ?? "",
    apiKey: externalApi.apiToken ?? undefined,
  };
}

/**
 * Health check for external Hindsight API.
 * Retries up to 3 times with 2s delay — container DNS may not be ready on first boot.
 */
/**
 * Compare two semver-shaped strings ("0.5.0", "0.4.22"). Returns true when
 * `actual >= minimum`. Tolerates pre-release suffixes (treats them as the
 * same major.minor.patch as the bare version — good enough for capability
 * gating).
 */
export function meetsMinimumVersion(actual: string, minimum: string): boolean {
  const parse = (v: string): number[] =>
    v
      .split("-")[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const a = parse(actual);
  const m = parse(minimum);
  for (let i = 0; i < Math.max(a.length, m.length); i++) {
    const av = a[i] ?? 0;
    const mv = m[i] ?? 0;
    if (av > mv) return true;
    if (av < mv) return false;
  }
  return true;
}

export interface HindsightApiCapabilities {
  version: string;
  storeDocumentText: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseHindsightApiCapabilities(
  payload: unknown,
): HindsightApiCapabilities | null {
  if (!isRecord(payload) || typeof payload.api_version !== "string") {
    return null;
  }

  let storeDocumentText = true;
  if ("features" in payload) {
    const features = payload.features;
    storeDocumentText =
      isRecord(features) && features.store_document_text === true;
  }

  return {
    version: payload.api_version,
    storeDocumentText,
  };
}

export function supportsAppendFromCapabilities(
  capabilities: HindsightApiCapabilities | null,
): boolean {
  return (
    capabilities !== null &&
    capabilities.storeDocumentText &&
    meetsMinimumVersion(
      capabilities.version,
      MIN_VERSION_FOR_UPDATE_MODE_APPEND,
    )
  );
}

export function supportsAsyncRetainOperationIdFromCapabilities(
  capabilities: HindsightApiCapabilities | null,
): boolean {
  return (
    asyncRetainOperationIdCapabilityFromCapabilities(capabilities) ===
    "supported"
  );
}

export function asyncRetainOperationIdCapabilityFromCapabilities(
  capabilities: HindsightApiCapabilities | null,
): AsyncRetainOperationIdCapability {
  if (capabilities === null) {
    return "unknown";
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(
    capabilities.version,
  );
  // JavaScript's `$` can match before a final line terminator, so require the
  // matched text to consume the complete payload as well as canonical digits.
  if (!match || match[0] !== capabilities.version) {
    return "unknown";
  }
  return meetsMinimumVersion(
    capabilities.version,
    MIN_VERSION_FOR_ASYNC_RETAIN_OPERATION_ID,
  )
    ? "supported"
    : "unsupported";
}

/**
 * Allocate the identity before the first asynchronous request so a failed
 * acknowledgement and every durable-queue replay refer to the same server operation.
 */
export function createAsyncRetainOperationId(): string {
  return randomUUID();
}

/**
 * Probe `<apiUrl>/version` once at service.start to learn the running
 * Hindsight API capabilities. Returns `null` (treated as "no append support")
 * if the endpoint is unreachable or returns malformed payload — conservative
 * fallback path is the right call when we can't be sure.
 */
async function fetchHindsightApiCapabilities(
  apiUrl: string,
  apiToken?: string | null,
  serviceSignal?: globalThis.AbortSignal,
): Promise<HindsightApiCapabilities | null> {
  const versionUrl = `${apiUrl.replace(/\/$/, "")}/version`;
  try {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (apiToken) headers["Authorization"] = `Bearer ${apiToken}`;
    const timeoutSignal = AbortSignal.timeout(5000);
    const response = await fetch(versionUrl, {
      signal: serviceSignal
        ? AbortSignal.any([serviceSignal, timeoutSignal])
        : timeoutSignal,
      headers,
    });
    if (!response.ok) {
      debug(
        `[Hindsight] /version returned HTTP ${response.status}; assuming legacy`,
      );
      return null;
    }
    const data = await response.json();
    const capabilities = parseHindsightApiCapabilities(data);
    if (!capabilities) {
      debug(
        `[Hindsight] /version payload missing api_version; assuming legacy`,
      );
    }
    return capabilities;
  } catch (error) {
    debug(
      `[Hindsight] /version probe failed: ${String(error)}; assuming legacy`,
    );
    return null;
  }
}

export async function refreshAsyncRetainOperationIdCapability(
  apiUrl: string,
  apiToken?: string | null,
  expectedGeneration = serviceGeneration,
  signal: globalThis.AbortSignal | undefined = serviceAbortController?.signal,
): Promise<AsyncRetainOperationIdCapability> {
  const capabilities = await fetchHindsightApiCapabilities(
    apiUrl,
    apiToken,
    signal,
  );
  const capability =
    asyncRetainOperationIdCapabilityFromCapabilities(capabilities);
  if (expectedGeneration !== serviceGeneration || signal?.aborted)
    return "unknown";
  asyncRetainOperationIdCapability = capability;
  return capability;
}

async function refreshQueueOperationIdCapability(
  expectedGeneration = serviceGeneration,
  signal: globalThis.AbortSignal | undefined = serviceAbortController?.signal,
): Promise<AsyncRetainOperationIdCapability> {
  if (expectedGeneration !== serviceGeneration || signal?.aborted)
    return "unknown";
  if (!currentPluginConfig) {
    asyncRetainOperationIdCapability = "unknown";
    return "unknown";
  }
  const endpoint = getActiveApiEndpoint();
  if (!endpoint.apiUrl) {
    asyncRetainOperationIdCapability = "unknown";
    return "unknown";
  }
  return refreshAsyncRetainOperationIdCapability(
    endpoint.apiUrl,
    endpoint.apiToken,
    expectedGeneration,
    signal,
  );
}

/**
 * Probe `/version` and update the module-level append and async-operation-id
 * capability flags. Logs a one-time WARN block when the append API is
 * older than 0.5.0 or cannot store document text — without
 * `update_mode: 'append'`, every retain on the same session id silently
 * overwrites prior turns server-side, and append itself requires stored
 * document text.
 *
 * Called wherever the plugin (re)connects to an API — external *and* local
 * daemon. It used to hang off the `checkExternalApiHealth` call sites only,
 * which is why local-daemon mode never probed at all and silently retained
 * with per-turn document ids. (#3686)
 */
async function detectAppendCapability(
  apiUrl: string,
  apiToken?: string | null,
  expectedGeneration = serviceGeneration,
  signal: globalThis.AbortSignal | undefined = serviceAbortController?.signal,
): Promise<void> {
  const capabilities = await fetchHindsightApiCapabilities(
    apiUrl,
    apiToken,
    signal,
  );
  if (expectedGeneration !== serviceGeneration || signal?.aborted) return;
  const supported = supportsAppendFromCapabilities(capabilities);
  asyncRetainOperationIdCapability =
    asyncRetainOperationIdCapabilityFromCapabilities(capabilities);
  const transitionedToUnsupported = supportsUpdateModeAppend && !supported;
  const firstProbe = !appendCapabilityProbed;
  appendCapabilityProbed = true;
  supportsUpdateModeAppend = supported;
  if (supported && capabilities) {
    debug(
      `[Hindsight] API version ${capabilities.version} supports update_mode=append with stored document text`,
    );
    return;
  }
  // Warn on the first probe when unsupported, and on any transition from
  // supported -> unsupported. Stay silent on subsequent re-probes that
  // confirm the same unsupported state.
  if (!firstProbe && !transitionedToUnsupported) return;
  const version = capabilities?.version ?? null;
  const reason =
    capabilities !== null &&
    meetsMinimumVersion(
      capabilities.version,
      MIN_VERSION_FOR_UPDATE_MODE_APPEND,
    ) &&
    !capabilities.storeDocumentText
      ? `reports version "${capabilities.version}" but has features.store_document_text disabled`
      : `reports version "${version ?? "unknown"}", which is older than ${MIN_VERSION_FOR_UPDATE_MODE_APPEND}`;
  log.warn(
    `[Hindsight] ⚠️  API at ${apiUrl} ${reason}. ` +
      `Falling back to per-turn document ids — each retain becomes its own document instead of accumulating into one per-session document. ` +
      `Enable document text storage on Hindsight ${MIN_VERSION_FOR_UPDATE_MODE_APPEND} or newer to use session-scoped retention with update_mode=append.`,
  );
}

async function checkExternalApiHealth(
  apiUrl: string,
  apiToken?: string | null,
): Promise<void> {
  const healthUrl = `${apiUrl.replace(/\/$/, "")}/health`;
  const maxRetries = 3;
  const retryDelay = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      debug(
        `[Hindsight] Checking external API health at ${healthUrl}... (attempt ${attempt}/${maxRetries})`,
      );
      const headers: Record<string, string> = { "User-Agent": USER_AGENT };
      if (apiToken) {
        headers["Authorization"] = `Bearer ${apiToken}`;
      }
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(10000),
        headers,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = (await response.json()) as { status?: string };
      debug(`[Hindsight] External API health: ${JSON.stringify(data)}`);
      return;
    } catch (error) {
      if (attempt < maxRetries) {
        debug(
          `[Hindsight] Health check attempt ${attempt} failed, retrying in ${retryDelay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      } else {
        throw new Error(
          `Cannot connect to external Hindsight API at ${apiUrl}: ${error}`,
          {
            cause: error,
          },
        );
      }
    }
  }
}

export function normalizeRetainTags(value: unknown): string[] {
  if (value == null) return [];

  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of rawItems) {
    if (typeof item !== "string") continue;
    const tag = item.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }
  return normalized;
}

export function getPluginConfig(
  api: Pick<OpenClawPluginApi, "pluginConfig">,
): PluginConfig {
  const config = (api.pluginConfig ?? {}) as PluginConfig;

  const senderPrefixPattern =
    typeof config.senderPrefixPattern === "string" &&
    config.senderPrefixPattern.trim().length > 0
      ? config.senderPrefixPattern.trim()
      : undefined;
  // Arm the shared stripper used by every recall/retain text path (#3070).
  configureSenderPrefixStripping(senderPrefixPattern);

  // No default fallback for missions: if the user doesn't set one, the plugin
  // does not stamp anything. This lets per-bank missions written via the API
  // (PATCH /banks/{id}) survive gateway restarts. (#1270)
  return {
    bankMission:
      typeof config.bankMission === "string" && config.bankMission.length > 0
        ? config.bankMission
        : undefined,
    retainMission:
      typeof config.retainMission === "string" &&
      config.retainMission.length > 0
        ? config.retainMission
        : undefined,
    observationsMission:
      typeof config.observationsMission === "string" &&
      config.observationsMission.length > 0
        ? config.observationsMission
        : undefined,
    retainExtractionMode: normalizeRetainExtractionMode(
      config.retainExtractionMode,
    ),
    enableObservations:
      typeof config.enableObservations === "boolean"
        ? config.enableObservations
        : undefined,
    enableAutoConsolidation:
      typeof config.enableAutoConsolidation === "boolean"
        ? config.enableAutoConsolidation
        : undefined,
    dispositionSkepticism: normalizeDispositionTrait(
      config.dispositionSkepticism,
    ),
    dispositionLiteralism: normalizeDispositionTrait(
      config.dispositionLiteralism,
    ),
    dispositionEmpathy: normalizeDispositionTrait(config.dispositionEmpathy),
    entityLabels: normalizeEntityLabels(config.entityLabels),
    embedPort: config.embedPort || 0,
    daemonIdleTimeout:
      config.daemonIdleTimeout !== undefined ? config.daemonIdleTimeout : 0,
    embedVersion: config.embedVersion || "latest",
    embedPackagePath: config.embedPackagePath,
    llmProvider: config.llmProvider,
    llmModel: config.llmModel,
    llmApiKey: config.llmApiKey,
    llmBaseUrl: config.llmBaseUrl,
    hindsightApiUrl: config.hindsightApiUrl,
    hindsightApiToken: config.hindsightApiToken,
    apiPort: config.apiPort || 9077,
    // Dynamic bank ID options (default: enabled)
    dynamicBankId: config.dynamicBankId !== false,
    bankId:
      typeof config.bankId === "string" && config.bankId.trim().length > 0
        ? config.bankId.trim()
        : undefined,
    bankIdPrefix: config.bankIdPrefix,
    agentBankMap: normalizeAgentBankMap(config.agentBankMap),
    retainTags: normalizeRetainTags(config.retainTags),
    retainSource:
      typeof config.retainSource === "string" &&
      config.retainSource.trim().length > 0
        ? config.retainSource.trim()
        : undefined,
    retainContext:
      typeof config.retainContext === "string" &&
      config.retainContext.trim().length > 0
        ? config.retainContext.trim()
        : DEFAULT_RETAIN_CONTEXT,
    excludeProviders: Array.isArray(config.excludeProviders)
      ? Array.from(
          new Set([
            "heartbeat",
            ...config.excludeProviders.filter(
              (provider): provider is string => typeof provider === "string",
            ),
          ]),
        )
      : ["heartbeat"],
    autoRecall: config.autoRecall !== false, // Default: true (on) — backward compatible
    dynamicBankGranularity: Array.isArray(config.dynamicBankGranularity)
      ? config.dynamicBankGranularity
      : DEFAULT_DYNAMIC_BANK_GRANULARITY,
    autoRetain: config.autoRetain !== false, // Default: true
    retainRoles: Array.isArray(config.retainRoles)
      ? config.retainRoles
      : undefined,
    retainFormat: config.retainFormat === "text" ? "text" : "json",
    retainToolCalls: config.retainToolCalls !== false,
    recallBudget: config.recallBudget || "mid",
    recallMaxTokens: config.recallMaxTokens || 1024,
    recallTypes: Array.isArray(config.recallTypes)
      ? config.recallTypes
      : ["observation"],
    preferObservations: config.preferObservations === true, // Default: false — backward compatible
    recallMinScores: config.recallMinScores,
    recallRoles: Array.isArray(config.recallRoles)
      ? config.recallRoles
      : ["user", "assistant"],
    retainEveryNTurns:
      typeof config.retainEveryNTurns === "number" &&
      config.retainEveryNTurns >= 1
        ? config.retainEveryNTurns
        : 1,
    retainOverlapTurns:
      typeof config.retainOverlapTurns === "number" &&
      config.retainOverlapTurns >= 0
        ? config.retainOverlapTurns
        : 0,
    recallTopK:
      typeof config.recallTopK === "number" ? config.recallTopK : undefined,
    recallContextTurns:
      typeof config.recallContextTurns === "number" &&
      config.recallContextTurns >= 1
        ? config.recallContextTurns
        : 1,
    recallMaxQueryChars:
      typeof config.recallMaxQueryChars === "number" &&
      config.recallMaxQueryChars >= 1
        ? config.recallMaxQueryChars
        : 800,
    recallPromptPreamble:
      typeof config.recallPromptPreamble === "string" &&
      config.recallPromptPreamble.trim().length > 0
        ? config.recallPromptPreamble
        : DEFAULT_RECALL_PROMPT_PREAMBLE,
    recallInjectionPosition:
      typeof config.recallInjectionPosition === "string" &&
      ["prepend", "append", "user"].includes(config.recallInjectionPosition)
        ? (config.recallInjectionPosition as PluginConfig["recallInjectionPosition"])
        : "user",
    recallTimeoutMs:
      typeof config.recallTimeoutMs === "number" &&
      config.recallTimeoutMs >= 1000
        ? config.recallTimeoutMs
        : undefined,
    ignoreSessionPatterns: Array.isArray(config.ignoreSessionPatterns)
      ? config.ignoreSessionPatterns
      : [],
    statelessSessionPatterns: Array.isArray(config.statelessSessionPatterns)
      ? config.statelessSessionPatterns
      : [],
    skipStatelessSessions: config.skipStatelessSessions !== false,
    debug: config.debug ?? false,
    debugPerfTiming: config.debugPerfTiming === true,
    // Retain queue: kept off the strict whitelist before — user values were
    // silently dropped before queue init read them. (#1443)
    retainQueuePath:
      typeof config.retainQueuePath === "string" &&
      config.retainQueuePath.trim().length > 0
        ? config.retainQueuePath
        : undefined,
    retainQueueMaxAgeMs:
      typeof config.retainQueueMaxAgeMs === "number"
        ? config.retainQueueMaxAgeMs
        : undefined,
    retainQueueFlushIntervalMs:
      typeof config.retainQueueFlushIntervalMs === "number" &&
      config.retainQueueFlushIntervalMs > 0
        ? config.retainQueueFlushIntervalMs
        : undefined,
    enableTools:
      config.enableTools === false ||
      (config as Record<string, unknown>).enableKnowledgeTools === false
        ? false
        : true,
    senderPrefixPattern,
  };
}

// Registration guard: WeakSet keyed by api instance to prevent double-registration
// on the same api object while allowing fresh registration on new api objects.
// Does not reintroduce issue #1029 because WeakSet.has() checks object identity,
// not a module-level boolean.
const _registeredApis = new WeakSet<OpenClawPluginApi>();

function registerPlugin(api: OpenClawPluginApi) {
  if (_registeredApis.has(api)) {
    debug(
      "[Hindsight] Plugin entry skipped (this api instance already registered)",
    );
    return;
  }
  _registeredApis.add(api);
  try {
    log.info("plugin entry invoked");
    debug("[Hindsight] Plugin loading...");

    // Get plugin config first (needed for debug flag and service registration)
    const pluginConfig = getPluginConfig(api);
    // If logLevel is 'debug', also enable legacy debug flag
    debugEnabled = pluginConfig.debug ?? pluginConfig.logLevel === "debug";

    // Configure structured logger — route through OpenClaw's api.logger for consistent formatting
    if (api.logger) setApiLogger(api.logger);
    configureLogger({
      logLevel:
        pluginConfig.logLevel ?? (pluginConfig.debug ? "debug" : "info"),
      logSummaryIntervalMs: pluginConfig.logSummaryIntervalMs,
    });

    // Store config globally for bank ID derivation in hooks
    currentPluginConfig = pluginConfig;

    debug(
      "[Hindsight] Plugin loaded successfully (deferred heavy init to gateway start)",
    );

    // Register background service for cleanup
    // IMPORTANT: Heavy initialization (LLM detection, daemon start, API health checks)
    // happens in service.start() which is ONLY called on gateway start,
    // not on every CLI command.
    debug("[Hindsight] Registering service...");
    log.info("registering plugin service");
    api.registerService({
      id: "hindsight-memory",
      async start() {
        preServiceHookController.abort();
        serviceAbortController?.abort();
        inflightRecalls.clear();
        recallResultByRunId.clear();
        const serviceController = new AbortController();
        serviceAbortController = serviceController;
        const startGeneration = ++serviceGeneration;
        log.info("service.start invoked");
        debug(
          "[Hindsight] Service start called - beginning heavy initialization...",
        );

        // Detect LLM configuration (env vars > plugin config > auto-detect)
        debug("[Hindsight] Detecting LLM config...");
        const llmConfig = detectLLMConfig(pluginConfig);

        const baseUrlInfo = llmConfig.baseUrl
          ? `, base URL: ${llmConfig.baseUrl}`
          : "";
        const modelInfo = llmConfig.model || "default";

        if (llmConfig.provider === "ollama") {
          debug(
            `[Hindsight] ✓ Using provider: ${llmConfig.provider}, model: ${modelInfo} (${llmConfig.source})`,
          );
        } else {
          debug(
            `[Hindsight] ✓ Using provider: ${llmConfig.provider}, model: ${modelInfo} (${llmConfig.source}${baseUrlInfo})`,
          );
        }
        if (pluginConfig.bankMission) {
          debug(
            `[Hindsight] Custom bank mission configured: "${pluginConfig.bankMission.substring(0, 50)}..."`,
          );
        }

        // Log bank ID mode
        if (pluginConfig.dynamicBankId) {
          const prefixInfo = pluginConfig.bankIdPrefix
            ? ` (prefix: ${pluginConfig.bankIdPrefix})`
            : "";
          debug(
            `[Hindsight] ✓ Dynamic bank IDs enabled${prefixInfo} - each channel gets isolated memory`,
          );
        } else {
          const sourceInfo = getConfiguredBankId(pluginConfig)
            ? "configured"
            : "default";
          debug(
            `[Hindsight] Dynamic bank IDs disabled - using ${sourceInfo} static bank: ${getStaticBankId(pluginConfig)}`,
          );
        }

        // Detect external API mode
        const externalApi = detectExternalApi(pluginConfig);
        usingExternalApi = Boolean(externalApi.apiUrl);

        // Get API port from config (default: 9077)
        const apiPort = pluginConfig.apiPort || 9077;

        // Both modes get the queue: a local daemon is unreachable while it is
        // still booting or after it has crashed, and a retain that fails then is
        // just as lost as one that fails against a remote API. (#3686)
        initRetainQueue(
          pluginConfig,
          startGeneration,
          serviceController.signal,
        );

        if (externalApi.apiUrl) {
          // External API mode - skip local daemon
          usingExternalApi = true;
          debug(`[Hindsight] ✓ Using external API: ${externalApi.apiUrl}`);

          if (externalApi.apiToken) {
            debug("[Hindsight] API token configured");
          }
        } else {
          debug(`[Hindsight] API Port: ${apiPort}`);
        }

        // Initialize (runs synchronously in service.start())
        debug("[Hindsight] Starting initialization...");
        initPromise = (async () => {
          try {
            const wasInitialized = isInitialized;
            const defaultBankId = await initializeConnection(
              pluginConfig,
              llmConfig,
            );
            const mode = usingExternalApi ? "external API" : "local daemon";
            if (!wasInitialized) {
              log.info(
                `initialized (mode: ${mode}, bank: ${defaultBankId}, autoRecall: ${pluginConfig.autoRecall !== false}, autoRetain: ${pluginConfig.autoRetain !== false})`,
              );
            }
            debug(`[Hindsight] ✓ Ready (${mode})`);
          } catch (error) {
            log.error("initialization error", error);
            throw error;
          }
        })();

        // Wait for initialization to complete
        try {
          await initPromise;
        } catch (error) {
          log.error("initial initialization failed", error);
          // Continue to health check below
        }

        // External API mode: check external API health
        if (usingExternalApi) {
          const externalApi = detectExternalApi(pluginConfig);
          if (externalApi.apiUrl && isInitialized) {
            try {
              await checkExternalApiHealth(
                externalApi.apiUrl,
                externalApi.apiToken,
              );
              await detectAppendCapability(
                externalApi.apiUrl,
                externalApi.apiToken,
              );
              debug("[Hindsight] External API is healthy");
              return;
            } catch (error) {
              log.error("external API health check failed", error);
              // Reset state for reinitialization attempt
              client = null;
              clientOptions = null;
              banksWithDefaultsApplied.clear();
              isInitialized = false;
            }
          }
        } else {
          // Local daemon mode: check daemon health (handles SIGUSR1 restart case)
          if (hindsightServer && isInitialized) {
            const healthy = await hindsightServer.checkHealth();
            if (healthy) {
              // Same re-probe the external branch does after its health check:
              // the daemon may have been restarted (SIGUSR1) onto a different
              // embed version since we last looked. (#3686)
              await detectAppendCapability(hindsightServer.getBaseUrl());
              debug("[Hindsight] Daemon is healthy");
              return;
            }

            debug("[Hindsight] Daemon is not responding - reinitializing...");
            // Reset state for reinitialization
            hindsightServer = null;
            client = null;
            clientOptions = null;
            banksWithDefaultsApplied.clear();
            isInitialized = false;
          }
        }

        // Reinitialize if needed (fresh start or recovery)
        if (!isInitialized) {
          debug("[Hindsight] Reinitializing...");
          const reinitPluginConfig = getPluginConfig(api);
          currentPluginConfig = reinitPluginConfig;
          await initializeConnection(reinitPluginConfig);
          debug("[Hindsight] Reinitialization complete");
        }
      },

      async stop() {
        try {
          serviceGeneration++;
          preServiceHookController.abort();
          serviceAbortController?.abort();
          serviceAbortController = null;
          inflightRecalls.clear();
          recallResultByRunId.clear();
          debug("[Hindsight] Service stopping...");

          // Only stop daemon if in local mode
          if (!usingExternalApi && hindsightServer) {
            await hindsightServer.stop();
            hindsightServer = null;
          }

          // Close retain queue
          if (retainQueueFlushTimer) {
            clearInterval(retainQueueFlushTimer);
            retainQueueFlushTimer = null;
          }
          if (retainQueue) {
            const pending = retainQueue.size();
            if (pending > 0) {
              debug(
                `[Hindsight] Service stopping with ${pending} queued retains (will resume on next start)`,
              );
            }
            retainQueue = null;
          }

          client = null;
          clientOptions = null;
          asyncRetainOperationIdCapability = "unknown";
          usingExternalApi = false;
          banksWithDefaultsApplied.clear();
          isInitialized = false;

          stopLogger();
          debug("[Hindsight] Service stopped");
        } catch (error) {
          log.error("service stop error", error);
          throw error;
        }
      },
    });

    debug("[Hindsight] Plugin loaded successfully");

    // Register agent hooks for auto-recall and auto-retention.
    //
    // Why no module-level "already registered" guard: each plugin entry invocation
    // hands us a fresh `api` tied to a specific plugin registry. OpenClaw may call
    // the plugin entry multiple times per process (CLI vs gateway vs lazy reloads),
    // and the registry that's active when an agent actually runs is not guaranteed
    // to be the first one we saw. A process-global flag would let the first call
    // "win" and leave subsequent registries with zero hindsight hooks — which is
    // exactly how auto-recall/auto-retain silently stopped firing in 0.6.x.
    debug("[Hindsight] Registering agent hooks...");
    log.info("registering agent hooks");

    api.on("before_dispatch", async (event, ctx) => {
      try {
        if (isInterSessionInternalEvent(ctx)) {
          debug(
            "[Hindsight] before_dispatch skipping inter-session / internal subagent event",
          );
          return;
        }

        const sessionKey =
          ctx?.sessionKey ??
          (typeof event?.sessionKey === "string"
            ? event.sessionKey
            : undefined);
        if (!sessionKey) {
          return;
        }

        const parsedProvider = parseSessionKey(sessionKey).provider;
        const dispatchChannel =
          (typeof event?.channel === "string" ? event.channel : undefined) ||
          (parsedProvider === "main" ? undefined : parsedProvider);
        // Without a known provider, let the prompt hook complete the identity.
        if (!dispatchChannel) return;
        const { resolvedCtx, skipReason } = resolveAndCacheIdentity({
          sessionKey,
          // Dispatch channelId names the provider, unlike the agent context's
          // conversation id. Keep conversation routing in the existing parser
          // and cache so bank ids retain their current format.
          ctx: {
            sessionKey,
            messageProvider: dispatchChannel,
            senderId:
              (typeof event?.senderId === "string"
                ? event.senderId
                : undefined) || ctx?.senderId,
          },
          dispatchChannel,
          pluginConfig,
        });

        if (skipReason) {
          debug(
            `[Hindsight] before_dispatch marked session ${sessionKey} to skip this turn: ${formatIdentitySkipReason(skipReason)}`,
          );
          logSkipOnce("dispatch", sessionKey, skipReason);
          return;
        }
        if (
          !resolvedCtx?.senderId ||
          typeof resolvedCtx.senderId !== "string"
        ) {
          return;
        }

        debug(
          `[Hindsight] before_dispatch cached identity for ${sessionKey}: ${resolvedCtx.messageProvider}/${resolvedCtx.channelId} sender=${resolvedCtx.senderId}`,
        );
      } catch (error) {
        log.warn(`before_dispatch identity cache error: ${error}`);
      }
    });

    // No `before_agent_start` registration: the callback used to call
    // `resolveAndCacheIdentity()` and emit a debug log, but `before_dispatch`
    // already populates the identity cache earlier in the inbound path,
    // `before_prompt_build` re-resolves before recall (and can infer
    // `senderId` from prompt content when ctx is missing it), and `agent_end`
    // re-resolves before retain. Subscribing here was duplicate work on the
    // hot path. (#1354)

    // Auto-recall: Inject relevant memories before agent processes the message
    // The SDK supplies prepared messages and the current request separately.
    api.on("before_prompt_build", async (event, ctx) => {
      const recallGeneration = serviceGeneration;
      const recallController =
        serviceAbortController ??
        (recallGeneration === 0 ? preServiceHookController : null);
      const isCurrentRecall = () =>
        recallController !== null &&
        (serviceAbortController ?? preServiceHookController) ===
          recallController &&
        recallGeneration === serviceGeneration &&
        !recallController.signal.aborted;
      if (!isCurrentRecall()) return;
      // Optional perf instrumentation (#1406). Captured here at hook entry so
      // the early-return paths below don't influence the measurement of slow
      // recall calls — perf lines are only emitted on the recall path.
      const perfHookStart = pluginConfig.debugPerfTiming ? Date.now() : 0;
      let finishHindsightMemoryRecall: (terminal: {
        state: "completed" | "failed" | "cancelled" | "skipped";
        resultCount?: number;
        reason?: "timeout" | "error" | "service_stopped" | "client_unavailable";
      }) => void = () => {};
      const cancelHindsightMemoryRecall = () =>
        finishHindsightMemoryRecall({
          state: "cancelled",
          reason: "service_stopped",
        });
      try {
        // Check if this is an inter-session / subagent completion internal event
        if (isInterSessionInternalEvent(ctx)) {
          debug(
            `[Hindsight] Skipping recall: inter-session / internal subagent event (${ctx?.inputProvenance?.sourceTool ?? ctx?.inputProvenance?.kind ?? ctx?.trigger})`,
          );
          return;
        }

        // Check if this provider is excluded
        if (
          ctx?.messageProvider &&
          pluginConfig.excludeProviders?.includes(ctx.messageProvider)
        ) {
          debug(
            `[Hindsight] Skipping recall for excluded provider: ${ctx.messageProvider}`,
          );
          return;
        }

        // Session pattern filtering
        const sessionKey = ctx?.sessionKey;
        if (sessionKey) {
          const ignorePatterns = compileSessionPatterns(
            pluginConfig.ignoreSessionPatterns ?? [],
          );
          if (
            ignorePatterns.length > 0 &&
            matchesSessionPattern(sessionKey, ignorePatterns)
          ) {
            debug(
              `[Hindsight] Skipping recall: session '${sessionKey}' matches ignoreSessionPatterns`,
            );
            return;
          }
          const skipStateless = pluginConfig.skipStatelessSessions !== false;
          if (skipStateless) {
            const statelessPatterns = compileSessionPatterns(
              pluginConfig.statelessSessionPatterns ?? [],
            );
            if (
              statelessPatterns.length > 0 &&
              matchesSessionPattern(sessionKey, statelessPatterns)
            ) {
              debug(
                `[Hindsight] Skipping recall: session '${sessionKey}' matches statelessSessionPatterns (skipStatelessSessions=true)`,
              );
              return;
            }
          }
        }

        // Skip auto-recall when disabled (agent has its own recall tool)
        if (!pluginConfig.autoRecall) {
          debug("[Hindsight] Auto-recall disabled via config, skipping");
          return;
        }

        const sessionKeyForCache = ctx.sessionKey;
        const skipTurnReason = sessionKeyForCache
          ? skipHindsightTurnBySession.get(sessionKeyForCache)
          : undefined;
        if (skipTurnReason && !isRetryableIdentitySkipReason(skipTurnReason)) {
          debug(
            `[Hindsight] Skipping recall for session ${sessionKeyForCache}: ${formatIdentitySkipReason(skipTurnReason)}`,
          );
          logSkipOnce("recall", sessionKeyForCache, skipTurnReason);
          return;
        }

        const senderIdFromPrompt = !ctx?.senderId
          ? extractSenderIdFromText(event.prompt)
          : undefined;
        const {
          resolvedCtx: resolvedCtxForRecall,
          skipReason: identitySkipReason,
        } = resolveAndCacheIdentity({
          sessionKey: sessionKeyForCache,
          ctx,
          senderIdHint: senderIdFromPrompt,
          pluginConfig,
        });
        if (identitySkipReason) {
          debug(
            `[Hindsight] Skipping recall for session ${sessionKeyForCache}: ${formatIdentitySkipReason(identitySkipReason)}`,
          );
          logSkipOnce("recall", sessionKeyForCache, identitySkipReason);
          return;
        }

        const bankId = deriveBankId(resolvedCtxForRecall, pluginConfig);
        debug(
          `[Hindsight] before_prompt_build - bank: ${bankId}, channel: ${resolvedCtxForRecall?.messageProvider}/${resolvedCtxForRecall?.channelId}`,
        );
        debug(`[Hindsight] event keys: ${Object.keys(event).join(", ")}`);
        // A present empty request means image-only input or continuation. Never
        // reconstruct it from history or runtime context in the prepared prompt.
        const currentRequest = event.currentUserMessage;
        if (currentRequest !== undefined && !currentRequest.trim()) return;
        const extracted = extractRecallQuery(
          currentRequest,
          currentRequest === undefined ? event.prompt : undefined,
        );
        if (!extracted) {
          debug(
            "[Hindsight] extractRecallQuery returned null, skipping recall",
          );
          return;
        }
        if (isEphemeralOperationalText(extracted)) {
          debug(
            "[Hindsight] Recall query is operational/ephemeral noise, skipping recall",
          );
          return;
        }
        const runRecallCacheKey =
          typeof ctx?.runId === "string" && ctx.runId.trim().length > 0
            ? `${ctx.runId.trim()}::${bankId}`
            : undefined;
        if (runRecallCacheKey && recallResultByRunId.has(runRecallCacheKey)) {
          const cachedRunResult = recallResultByRunId.get(runRecallCacheKey);
          debug(
            `[Hindsight] Reusing cached recall result for runId ${ctx?.runId} (bank: ${bankId})`,
          );
          return cachedRunResult ?? undefined;
        }
        debug(
          `[Hindsight] extractRecallQuery result length: ${extracted.length}`,
        );
        const recallContextTurns = pluginConfig.recallContextTurns ?? 1;
        const recallMaxQueryChars = pluginConfig.recallMaxQueryChars ?? 800;
        const sessionMessages = event.messages;
        const messageCount = sessionMessages.length;
        debug(
          `[Hindsight] event.messages count: ${messageCount}, roles: ${sessionMessages.map((m: any) => m.role).join(",")}`,
        );
        if (recallContextTurns > 1 && messageCount === 0) {
          debug(
            "[Hindsight] recallContextTurns > 1 but event.messages is empty — prior context unavailable at before_agent_start for this provider",
          );
        }
        const recallRoles = pluginConfig.recallRoles ?? ["user", "assistant"];
        const composedPrompt = composeRecallQuery(
          extracted,
          sessionMessages,
          recallContextTurns,
          recallRoles,
        );
        let prompt = truncateRecallQuery(
          composedPrompt,
          extracted,
          recallMaxQueryChars,
        );

        // Final defensive cap
        if (prompt.length > recallMaxQueryChars) {
          prompt = prompt.substring(0, recallMaxQueryChars);
        }

        // Progress is best-effort telemetry, never a dependency of memory recall.
        const hindsightMemoryRecallId = randomUUID();
        const hindsightMemoryProgressStart = Date.now();
        let hindsightMemoryProgressFinished = false;
        const emitHindsightMemoryProgress = (
          details: Record<string, unknown>,
        ) => {
          try {
            if (!ctx?.runId) return;
            ctx.hookInvocation?.assertActive();
            const emitted = emitAgentEvent({
              runId: ctx.runId,
              stream: "plugin:hindsight-memory",
              sessionKey: sessionKeyForCache,
              data: {
                kind: "hindsight-memory.recall",
                pluginId: "hindsight-memory",
                recallId: hindsightMemoryRecallId,
                ...(sessionKeyForCache === undefined
                  ? {}
                  : { sessionKey: sessionKeyForCache }),
                ...details,
              },
            });
            void Promise.resolve(emitted).catch(() => {});
          } catch {
            // Failed subscribers must not interrupt recall.
          }
        };
        finishHindsightMemoryRecall = (terminal) => {
          if (hindsightMemoryProgressFinished) return;
          hindsightMemoryProgressFinished = true;
          emitHindsightMemoryProgress({
            ...terminal,
            durationMs: Math.max(0, Date.now() - hindsightMemoryProgressStart),
          });
        };
        emitHindsightMemoryProgress({ state: "started" });
        recallController?.signal.addEventListener(
          "abort",
          cancelHindsightMemoryRecall,
          {
            once: true,
          },
        );
        if (!isCurrentRecall()) {
          cancelHindsightMemoryRecall();
          return;
        }

        // Wait for client to be ready
        const clientGlobal = (global as any).__hindsightClient;
        if (!clientGlobal) {
          finishHindsightMemoryRecall({
            state: "skipped",
            reason: "client_unavailable",
          });
          debug(
            "[Hindsight] Client global not available, skipping auto-recall",
          );
          return;
        }

        await clientGlobal.waitForReady();
        if (!isCurrentRecall()) {
          cancelHindsightMemoryRecall();
          return;
        }

        // Get client configured for this context's bank (async to handle mission setup)
        const client =
          await clientGlobal.getClientForContext(resolvedCtxForRecall);
        if (!isCurrentRecall()) {
          cancelHindsightMemoryRecall();
          return;
        }
        if (!client) {
          finishHindsightMemoryRecall({
            state: "skipped",
            reason: "client_unavailable",
          });
          debug("[Hindsight] Client not initialized, skipping auto-recall");
          return;
        }

        debug(
          `[Hindsight] Auto-recall for bank ${bankId}, full query:\n---\n${prompt}\n---`,
        );

        // Recall with deduplication: reuse in-flight request for same bank
        const normalizedPrompt = prompt
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " ");
        const queryHash = createHash("sha256")
          .update(normalizedPrompt)
          .digest("hex")
          .slice(0, 16);
        const recallKey = `${bankId}::${queryHash}`;
        const existing = inflightRecalls.get(recallKey);
        let recallPromise: Promise<RecallResponse>;
        if (existing) {
          debug(`[Hindsight] Reusing in-flight recall for bank ${bankId}`);
          recallPromise = existing;
        } else {
          const recallTimeoutMs =
            pluginConfig.recallTimeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS;
          recallPromise = client.recall(
            {
              query: prompt,
              maxTokens: pluginConfig.recallMaxTokens || 1024,
              budget: pluginConfig.recallBudget,
              types: pluginConfig.recallTypes,
              preferObservations: pluginConfig.preferObservations,
              minScores: pluginConfig.recallMinScores,
            },
            recallTimeoutMs,
            recallController?.signal,
          );
          inflightRecalls.set(recallKey, recallPromise);
          void recallPromise
            .catch(() => {})
            .finally(() => {
              // An old generation can settle after start() installed a successor.
              if (inflightRecalls.get(recallKey) === recallPromise)
                inflightRecalls.delete(recallKey);
            });
        }

        const recallStart = pluginConfig.debugPerfTiming ? Date.now() : 0;
        const response = await recallPromise;
        if (!isCurrentRecall()) {
          cancelHindsightMemoryRecall();
          return;
        }
        const recallElapsedMs = pluginConfig.debugPerfTiming
          ? Date.now() - recallStart
          : 0;

        if (!response.results || response.results.length === 0) {
          if (runRecallCacheKey) {
            setCappedMapValue(recallResultByRunId, runRecallCacheKey, null);
          }
          finishHindsightMemoryRecall({ state: "completed", resultCount: 0 });
          if (pluginConfig.debugPerfTiming) {
            log.info(
              formatHookPerf(
                "before_prompt_build",
                Date.now() - perfHookStart,
                {
                  recall_main: `${recallElapsedMs}ms`,
                  source: existing ? "reused" : "fresh",
                  results: 0,
                },
              ),
            );
          }
          debug("[Hindsight] No memories found for auto-recall");
          return;
        }

        debug(
          `[Hindsight] Raw recall response (${response.results.length} results before topK):\n${response.results.map((r: any, i: number) => `  [${i}] score=${r.score?.toFixed(3) ?? "n/a"} type=${r.type ?? "n/a"}: ${JSON.stringify(r.content ?? r.text ?? r).substring(0, 200)}`).join("\n")}`,
        );

        const results = pluginConfig.recallTopK
          ? response.results.slice(0, pluginConfig.recallTopK)
          : response.results;

        debug(
          `[Hindsight] After topK (${pluginConfig.recallTopK ?? "unlimited"}): ${results.length} results injected`,
        );

        // Format memories as a bullet list (text + type + date + occurred window +
        // [doc:<document_id>], each part present only when the memory carries it)
        const memoriesFormatted = formatMemories(results);

        const contextMessage = `<hindsight_memory_plugin>
${pluginConfig.recallPromptPreamble || DEFAULT_RECALL_PROMPT_PREAMBLE}
Current time - ${formatCurrentTimeForRecall()}

${memoriesFormatted}
</hindsight_memory_plugin>`;

        debug(
          `[Hindsight] Auto-recall: Injecting ${results.length} memories from bank ${bankId}`,
        );
        log.info(
          `injecting ${results.length} memories into context (bank: ${bankId})`,
        );
        log.trackRecall(bankId, results.length);

        if (pluginConfig.debugPerfTiming) {
          log.info(
            formatHookPerf("before_prompt_build", Date.now() - perfHookStart, {
              recall_main: `${recallElapsedMs}ms`,
              source: existing ? "reused" : "fresh",
              results: results.length,
            }),
          );
        }

        // Keep recalled memories outside the system prompt by default so the
        // provider can reuse its stable prompt prefix across turns. Users who
        // need system-level memory context can still opt into prepend or append.
        finishHindsightMemoryRecall({
          state: "completed",
          resultCount: results.length,
        });
        const position = pluginConfig.recallInjectionPosition ?? "user";
        const injectionResult: Exclude<CachedRecallPromptResult, null> =
          position === "append"
            ? { appendSystemContext: contextMessage }
            : position === "user"
              ? { prependContext: contextMessage }
              : { prependSystemContext: contextMessage };
        if (runRecallCacheKey) {
          setCappedMapValue(
            recallResultByRunId,
            runRecallCacheKey,
            injectionResult,
          );
        }
        return injectionResult;
      } catch (error) {
        if (!isCurrentRecall()) {
          cancelHindsightMemoryRecall();
        } else {
          finishHindsightMemoryRecall({
            state: "failed",
            reason:
              error instanceof DOMException && error.name === "TimeoutError"
                ? "timeout"
                : "error",
          });
        }
        if (error instanceof DOMException && error.name === "TimeoutError") {
          log.warn(
            `[Hindsight] Auto-recall timed out after ${pluginConfig.recallTimeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS}ms, skipping memory injection`,
          );
        } else if (error instanceof Error && error.name === "AbortError") {
          // An AbortError now has two sources. The deadline is handled above as a
          // TimeoutError; this branch is reached when the service was stopped or
          // restarted mid-recall, which is not a timeout — quoting recallTimeoutMs
          // there reports a deadline that never elapsed, with a number unrelated
          // to the time actually spent. (#4450)
          if (recallController?.signal.aborted) {
            debug(
              "[Hindsight] Auto-recall cancelled: service stopped, skipping memory injection",
            );
          } else {
            log.warn(
              `[Hindsight] Auto-recall aborted after ${pluginConfig.recallTimeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS}ms, skipping memory injection`,
            );
          }
        } else {
          log.error("auto-recall error", error);
        }
        return;
      } finally {
        recallController?.signal.removeEventListener(
          "abort",
          cancelHindsightMemoryRecall,
        );
      }
    });

    // Shared retain path for `agent_end` (per-turn cadence) and `session_end`
    // (force-flush at session close, bypassing the cadence so short sessions
    // and the un-retained tail of long sessions still land on disk). See #1726.
    const runRetain = async (
      event: PluginHookEvent<"agent_end"> | PluginHookEvent<"session_end">,
      ctx: PluginHookAgentContext | undefined,
      retainOptions: {
        force?: boolean;
        hookName: "agent_end" | "session_end";
        endedTranscript?: PluginHookSessionContext["endedTranscript"];
      } = {
        hookName: "agent_end",
      },
    ): Promise<void> => {
      const force = retainOptions.force === true;
      const hookName = retainOptions.hookName;
      const retainGeneration = serviceGeneration;
      const retainController =
        serviceAbortController ??
        (retainGeneration === 0 ? preServiceHookController : null);
      const retainSignal = retainController?.signal;
      const retainLifecycleIsCurrent = () =>
        retainController !== null &&
        (serviceAbortController ?? preServiceHookController) ===
          retainController &&
        retainGeneration === serviceGeneration &&
        !retainSignal?.aborted;
      if (!retainLifecycleIsCurrent()) return;
      // Optional perf instrumentation (#1406). Only emitted when an actual
      // retain RPC fires; the many early-return skip paths are not measured.
      const perfHookStart = pluginConfig.debugPerfTiming ? Date.now() : 0;
      try {
        // Avoid cross-session contamination: only use context carried by this event.
        const eventSessionKey =
          "sessionKey" in event ? event.sessionKey : undefined;
        const effectiveCtx =
          ctx ||
          (eventSessionKey
            ? ({ sessionKey: eventSessionKey } as PluginHookAgentContext)
            : undefined);

        // Check if this provider is excluded
        if (
          effectiveCtx?.messageProvider &&
          pluginConfig.excludeProviders?.includes(effectiveCtx.messageProvider)
        ) {
          debug(
            `[Hindsight] Skipping retain for excluded provider: ${effectiveCtx.messageProvider}`,
          );
          return;
        }

        // Check if this is an inter-session / subagent completion internal event
        if (isInterSessionInternalEvent(effectiveCtx)) {
          debug(
            `[Hindsight Hook] Skipping retain: inter-session / internal subagent event (${effectiveCtx?.inputProvenance?.sourceTool ?? effectiveCtx?.inputProvenance?.kind ?? effectiveCtx?.trigger})`,
          );
          return;
        }

        // Session pattern filtering
        const agentEndSessionKey = effectiveCtx?.sessionKey;
        if (agentEndSessionKey) {
          const ignorePatterns = compileSessionPatterns(
            pluginConfig.ignoreSessionPatterns ?? [],
          );
          if (
            ignorePatterns.length > 0 &&
            matchesSessionPattern(agentEndSessionKey, ignorePatterns)
          ) {
            debug(
              `[Hindsight] Skipping retain: session '${agentEndSessionKey}' matches ignoreSessionPatterns`,
            );
            return;
          }
          const statelessPatterns = compileSessionPatterns(
            pluginConfig.statelessSessionPatterns ?? [],
          );
          if (
            statelessPatterns.length > 0 &&
            matchesSessionPattern(agentEndSessionKey, statelessPatterns)
          ) {
            debug(
              `[Hindsight] Skipping retain: session '${agentEndSessionKey}' matches statelessSessionPatterns`,
            );
            return;
          }
        }

        const sessionKeyForLookup = effectiveCtx?.sessionKey;
        const skipTurnReason = sessionKeyForLookup
          ? skipHindsightTurnBySession.get(sessionKeyForLookup)
          : undefined;
        if (skipTurnReason && !isRetryableIdentitySkipReason(skipTurnReason)) {
          debug(
            `[Hindsight Hook] Skipping retain for session ${sessionKeyForLookup}: ${formatIdentitySkipReason(skipTurnReason)}`,
          );
          logSkipOnce("retain", sessionKeyForLookup, skipTurnReason);
          if (sessionKeyForLookup) {
            skipHindsightTurnBySession.delete(sessionKeyForLookup);
          }
          return;
        }

        const {
          effectiveCtx: effectiveCtxForRetain,
          resolvedCtx: resolvedCtxForRetain,
          skipReason: identitySkipReason,
        } = resolveAndCacheIdentity({
          sessionKey: sessionKeyForLookup,
          ctx: effectiveCtx,
          pluginConfig,
        });

        if (identitySkipReason) {
          debug(
            `[Hindsight Hook] Skipping retain for session ${sessionKeyForLookup}: ${formatIdentitySkipReason(identitySkipReason)}`,
          );
          logSkipOnce("retain", sessionKeyForLookup, identitySkipReason);
          if (sessionKeyForLookup) {
            skipHindsightTurnBySession.delete(sessionKeyForLookup);
          }
          return;
        }
        if (sessionKeyForLookup) {
          skipHindsightTurnBySession.delete(sessionKeyForLookup);
        }

        const bankId = deriveBankId(resolvedCtxForRetain, pluginConfig);
        debug(`[Hindsight Hook] ${hookName} triggered - bank: ${bankId}`);

        // `event.success === false` is a per-agent-end signal; session_end
        // doesn't carry it and a failed last turn shouldn't block the final
        // flush of preceding successful turns. (#1726)
        if (!force && "success" in event && event.success === false) {
          debug("[Hindsight Hook] Agent run failed, skipping retention");
          return;
        }

        if (pluginConfig.autoRetain === false) return;

        const retainEveryN = pluginConfig.retainEveryNTurns ?? 1;
        const sessionKey = effectiveCtx?.sessionKey ?? "session";
        const sessionId =
          effectiveCtx?.sessionId ??
          ("sessionId" in event ? event.sessionId : undefined);
        const fallbackTrackingKey = JSON.stringify([bankId, sessionKey]);
        const incarnationTrackingKey = sessionId
          ? JSON.stringify([bankId, sessionKey, sessionId])
          : fallbackTrackingKey;
        // Some emitters omit sessionId on agent_end. Capture that fallback at
        // the end boundary, before a successor reuses the same session key.
        const sessionTrackingKey =
          force && !turnCountBySession.has(incarnationTrackingKey)
            ? fallbackTrackingKey
            : incarnationTrackingKey;
        const endedTurnCount = force
          ? (turnCountBySession.get(sessionTrackingKey) ?? 0)
          : 0;
        let eventMessages = "messages" in event ? event.messages : undefined;
        if (force) {
          // Finalize the boundary even with no pending tail or reader. Otherwise
          // a duplicate old end could claim a successor's no-sessionId counter.
          turnCountBySession.delete(sessionTrackingKey);
          setCappedMapValue(turnCountBySession, incarnationTrackingKey, 0);
          const pendingTurns = endedTurnCount;
          if (retainEveryN <= 1 || pendingTurns % retainEveryN === 0) return;

          // Only the host can provide a stable ended-session boundary. Missing or
          // unavailable readers are explicit non-results; do not scan sessionFile
          // or use an ad-hoc messages payload to bypass the host's decision.
          const reader = retainOptions.endedTranscript;
          if (!reader?.available) {
            debug(
              `[Hindsight] session_end transcript unavailable: ${reader?.reason ?? "unsupported-host"}`,
            );
            return;
          }
          const tail = await reader.readTail({
            maxMessages: 1000,
            maxBytes: 2 * 1024 * 1024,
          });
          if (!retainLifecycleIsCurrent()) return;
          eventMessages = [...tail.messages];
          if (tail.truncated)
            log.warn("session_end transcript tail truncated by host limits");
        }

        if (!Array.isArray(eventMessages) || eventMessages.length === 0) {
          debug("[Hindsight Hook] No messages in event, skipping retention");
          return;
        }
        const messages = eventMessages as OpenClawMessage[];

        if (!force) {
          const lastUserMsg = [...messages].reverse().find(isUserTurnInitiator);
          if (lastUserMsg && isInternalOrOperationalTurnMessage(lastUserMsg)) {
            debug(
              "[Hindsight Hook] Skipping retain: current turn is an internal / operational message",
            );
            return;
          }
        }

        // Chunked retention: skip non-Nth turns and use a sliding window when firing
        const allMessages = messages;
        let messagesToRetain = allMessages;
        let retainFullWindow = false;

        if (retainEveryN > 1) {
          // session_end uses its captured count; successors own separate cadence.
          const turnCount = force
            ? endedTurnCount
            : (turnCountBySession.get(sessionTrackingKey) || 0) + 1;
          if (!force) {
            setCappedMapValue(
              turnCountBySession,
              sessionTrackingKey,
              turnCount,
            );
          }

          const cadenceBoundary =
            turnCount > 0 && turnCount % retainEveryN === 0;
          const unretainedTurns = turnCount % retainEveryN;

          if (force) {
            // session_end: only flush if there are un-retained turns since the
            // last cadence boundary. The most recent agent_end either already
            // retained (cadenceBoundary) or accumulated `unretainedTurns` turns
            // that would otherwise be lost when the session closes. (#1726)
            if (turnCount === 0 || cadenceBoundary) {
              debug(
                `[Hindsight Hook] session_end: nothing un-retained (turnCount=${turnCount}, retainEveryN=${retainEveryN}), skipping flush`,
              );
              return;
            }
            const overlapTurns = pluginConfig.retainOverlapTurns ?? 0;
            const windowTurns = unretainedTurns + overlapTurns;
            messagesToRetain = sliceLastTurnsByUserBoundary(
              allMessages,
              windowTurns,
            );
            retainFullWindow = true;
            debug(
              `[Hindsight Hook] session_end: forced flush of ${unretainedTurns} un-retained turns (window: ${windowTurns} turns, ${messagesToRetain.length} messages)`,
            );
          } else {
            if (!cadenceBoundary) {
              const nextRetainAt =
                Math.ceil(turnCount / retainEveryN) * retainEveryN;
              debug(
                `[Hindsight Hook] Turn ${turnCount}/${retainEveryN}, skipping retain (next at turn ${nextRetainAt})`,
              );
              return;
            }

            // Sliding window in turns: N turns + configured overlap turns.
            // We slice by actual turn boundaries (user-role messages), so this
            // remains stable even when system/tool messages are present.
            const overlapTurns = pluginConfig.retainOverlapTurns ?? 0;
            const windowTurns = retainEveryN + overlapTurns;
            messagesToRetain = sliceLastTurnsByUserBoundary(
              allMessages,
              windowTurns,
            );
            retainFullWindow = true;
            debug(
              `[Hindsight Hook] Turn ${turnCount}: chunked retain firing (window: ${windowTurns} turns, ${messagesToRetain.length} messages)`,
            );
          }
        }

        const inlineRetainTags = normalizeRetainTags(
          messagesToRetain.flatMap((msg: any) => {
            if (msg?.role !== "user") {
              return [];
            }

            const content =
              typeof msg?.content === "string"
                ? msg.content
                : Array.isArray(msg?.content)
                  ? msg.content
                      .filter(
                        (block: any) =>
                          block?.type === "text" &&
                          typeof block?.text === "string",
                      )
                      .map((block: any) => block.text)
                      .join("\n")
                  : "";

            return extractInlineRetainTags(content);
          }),
        );

        const retention = prepareRetentionTranscript(
          messagesToRetain,
          pluginConfig,
          retainFullWindow,
        );
        if (!retention) {
          debug(
            "[Hindsight Hook] No messages to retain (filtered/short/no-user)",
          );
          return;
        }
        const { transcript, messageCount } = retention;

        if (isEphemeralOperationalText(transcript)) {
          debug(
            "[Hindsight Hook] Transcript is operational/ephemeral noise, skipping retention",
          );
          return;
        }

        // Persist before any client initialization or network await. Agent-scoped
        // registries never start services; they are producers, not retry workers.
        const retainRequest = buildRetainRequest(
          transcript,
          messageCount,
          effectiveCtxForRetain,
          pluginConfig,
          Date.now(),
          {
            retentionScope: retainFullWindow ? "window" : "turn",
            windowTurns: retainFullWindow
              ? (pluginConfig.retainEveryNTurns ?? 1) +
                (pluginConfig.retainOverlapTurns ?? 0)
              : undefined,
            tags: inlineRetainTags,
            appendSupported: supportsUpdateModeAppend,
            operationId: createAsyncRetainOperationId(),
          },
        );
        ctx?.hookInvocation?.assertActive();
        retainQueue ??= openRetainQueue(pluginConfig);
        retainQueue.enqueue(bankId, retainRequest, retainRequest.metadata);
        debug(
          `[Hindsight] Queued ${messageCount} messages for bank ${bankId}, document: ${retainRequest.documentId}`,
        );

        // Only the service owner sends. Scoped producers leave delivery to the
        // Gateway timer, including when health checks or initialization fail.
        if (!force && serviceAbortController === retainController) {
          await flushRetainQueue(
            undefined,
            undefined,
            asyncRetainOperationIdCapability === "unknown"
              ? undefined
              : asyncRetainOperationIdCapability,
            retainGeneration,
            retainSignal,
          );
        }
        if (pluginConfig.debugPerfTiming) {
          log.info(
            formatHookPerf(hookName, Date.now() - perfHookStart, {
              outcome: "persisted",
              bank: bankId,
              messages: messageCount,
            }),
          );
        }
      } catch (error) {
        log.error("error retaining messages", error);
      }
    };

    // Hook signature: (event, ctx) where event has {messages, success, error?, durationMs?}
    api.on("agent_end", async (event, ctx) => {
      await runRetain(event, ctx, { hookName: "agent_end" });
    });

    // session_end fires once per OpenClaw session close. We force-flush so
    // short conversations (fewer turns than `retainEveryNTurns`) and the
    // un-retained tail of long conversations are not silently dropped. (#1726)
    api.on("session_end", async (event, ctx) => {
      await runRetain(event, ctx, {
        hookName: "session_end",
        force: true,
        endedTranscript: ctx.endedTranscript,
      });
    });
    debug("[Hindsight] Hooks registered");
    log.info("agent hooks registered");

    // Register knowledge tools (enabled by default via enableTools config flag)
    if (pluginConfig.enableTools && typeof api.registerTool === "function") {
      try {
        const apiUrl = (() => {
          const ext = detectExternalApi(pluginConfig);
          return (
            ext?.apiUrl || `http://localhost:${pluginConfig.apiPort || 9077}`
          );
        })();
        const apiToken = pluginConfig.hindsightApiToken || undefined;

        // Factory: called per session with agent context, returns tools scoped to that bank.
        // Use host-supplied tool identity and the shared hook identity cache so
        // explicit tools and automatic recall resolve the same per-user bank.
        const factory = (ctx: OpenClawPluginToolContext) => {
          const resolution = resolveBankIdForKnowledgeTools(ctx, pluginConfig);
          const rawTools = createKnowledgeTools({
            apiUrl,
            apiToken,
            bankId: resolution.bankId,
          });
          const rawToolsByName = new Map(rawTools.map((t) => [t.name, t]));

          const pageTool: AnyAgentTool = {
            name: KNOWLEDGE_PAGE_TOOL_DEFINITION.name,
            label: KNOWLEDGE_PAGE_TOOL_DEFINITION.label,
            description: KNOWLEDGE_PAGE_TOOL_DEFINITION.description,
            parameters: KNOWLEDGE_PAGE_TOOL_DEFINITION.parameters,
            async execute(_id: string, params: Record<string, unknown>) {
              if (resolution.identityError) {
                return {
                  content: [{ type: "text", text: resolution.identityError }],
                  details: { error: resolution.identityError },
                };
              }
              const config = currentPluginConfig || pluginConfig;
              await ensureBankDefaultsApplied(resolution.bankId, config);
              const result = await executeKnowledgePageAction(
                rawToolsByName,
                params,
              );
              return { ...result, details: knowledgeToolDetails(result) };
            },
          };

          const memoryTools = rawTools
            .filter((t) => KNOWLEDGE_TOOL_RENAMES[t.name])
            .map((t): AnyAgentTool => {
              const override = KNOWLEDGE_TOOL_RENAMES[t.name]!;
              return {
                name: override.name,
                label: override.label ?? t.label,
                description: override.description ?? t.description,
                parameters: t.parameters,
                async execute(_id: string, params: Record<string, unknown>) {
                  if (resolution.identityError) {
                    return {
                      content: [
                        { type: "text", text: resolution.identityError },
                      ],
                      details: { error: resolution.identityError },
                    };
                  }
                  const config = currentPluginConfig || pluginConfig;
                  await ensureBankDefaultsApplied(resolution.bankId, config);
                  const result = await t.execute(params);
                  return { ...result, details: knowledgeToolDetails(result) };
                },
              };
            });

          return [...memoryTools, pageTool];
        };

        api.registerTool(factory, {
          names: [...REGISTERED_KNOWLEDGE_TOOL_NAMES],
          optional: false,
        });
        log.info("knowledge tools registered");
      } catch (err) {
        log.warn(`knowledge tools registration failed: ${err}`);
      }
    }
  } catch (error) {
    log.error("plugin loading error", error);
    if (error instanceof Error) {
      log.error("error stack", error.stack);
    }
    throw error;
  }
}

export default definePluginEntry({
  id: "hindsight-memory",
  name: "Hindsight Memory",
  description:
    "Biomimetic long-term memory with automatic recall and retention",
  register: registerPlugin,
});

// Export client getter for tools

function sanitizeDocumentIdPart(
  value: string | undefined,
  fallback: string,
): string {
  const normalized = (value || "").trim();
  if (!normalized) return fallback;
  return (
    normalized
      .replace(/[^a-zA-Z0-9:_-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || fallback
  );
}

function getSessionDocumentBase(
  effectiveCtx: PluginHookAgentContext | undefined,
): string {
  const sessionKeyPart = sanitizeDocumentIdPart(
    effectiveCtx?.sessionKey,
    "session",
  );
  return `openclaw:${sessionKeyPart}`;
}

function nextDocumentSequence(
  effectiveCtx: PluginHookAgentContext | undefined,
): number {
  const sequenceKey = effectiveCtx?.sessionKey || "session";
  const next = (documentSequenceBySession.get(sequenceKey) || 0) + 1;
  setCappedMapValue(documentSequenceBySession, sequenceKey, next);
  return next;
}

function extractThreadId(channelId: string | undefined): string | undefined {
  if (!channelId) return undefined;
  const match = channelId.match(/(?:^|:)topic:([^:]+)$/);
  return match?.[1];
}

export function buildRetainRequest(
  transcript: string,
  messageCount: number,
  effectiveCtx: PluginHookAgentContext | undefined,
  pluginConfig: PluginConfig,
  now = Date.now(),
  options?: {
    retentionScope?: "turn" | "window" | "manual";
    windowTurns?: number;
    turnIndex?: number;
    tags?: string[];
    /**
     * Whether the live Hindsight API supports `update_mode: 'append'`. When
     * true, the request gets a stable per-session document id and
     * `updateMode: 'append'` so each retain concatenates to the existing
     * document. When false, falls back to a unique per-turn document id so
     * prior turns aren't overwritten. Defaults to false (conservative).
     */
    appendSupported?: boolean;
    /** Stable UUID allocated before the initial asynchronous retain request. */
    operationId?: string;
  },
): RetainRequest {
  const resolvedCtx = resolveSessionIdentity(effectiveCtx);
  const parsedSession = resolvedCtx?.sessionKey
    ? parseSessionKey(resolvedCtx.sessionKey)
    : {};
  const turnIndex = options?.turnIndex ?? nextDocumentSequence(resolvedCtx);
  const retentionScope = options?.retentionScope || "turn";
  const documentBase = getSessionDocumentBase(resolvedCtx);
  const documentKind = retentionScope === "window" ? "window" : "turn";
  // Retains are session-scoped: all turns accumulate under one document id when
  // the API can append. On legacy APIs without append support, every retain on
  // the same id would silently overwrite prior turns (behavior pre-#932), so
  // fall back to per-turn ids there.
  const useSessionScopedDoc = options?.appendSupported === true;
  // The fallback id carries a per-process boot token because `turnIndex` comes
  // from an in-memory counter: without it, a host restart replays
  // `…:turn:000001` onto the previous cycle's document and `update_mode:
  // 'replace'` deletes what was there. (#3686)
  const documentId = useSessionScopedDoc
    ? documentBase
    : `${documentBase}:${documentKind}:${getDocumentIdBootToken()}:${String(turnIndex).padStart(6, "0")}`;
  const provider = effectiveCtx?.messageProvider || parsedSession.provider;
  const channelId =
    sanitizeChannelId(effectiveCtx?.channelId, provider) ||
    parsedSession.channel;
  const channelType = effectiveCtx?.messageProvider;
  const threadId = extractThreadId(channelId);
  const mergedTags = normalizeRetainTags([
    ...(pluginConfig.retainTags ?? []),
    ...(options?.tags ?? []),
  ]);

  return {
    content: transcript,
    documentId: documentId,
    context:
      typeof pluginConfig.retainContext === "string" &&
      pluginConfig.retainContext.trim().length > 0
        ? pluginConfig.retainContext.trim()
        : DEFAULT_RETAIN_CONTEXT,
    metadata: {
      retained_at: new Date(now).toISOString(),
      message_count: String(messageCount),
      source: pluginConfig.retainSource || "openclaw",
      retention_scope: retentionScope,
      turn_index: String(turnIndex),
      session_key: resolvedCtx?.sessionKey,
      agent_id: resolvedCtx?.agentId || parsedSession.agentId,
      provider,
      channel_type: channelType,
      channel_id: channelId,
      thread_id: threadId,
      sender_id: resolvedCtx?.senderId,
      ...(options?.windowTurns !== undefined
        ? { window_turns: String(options.windowTurns) }
        : {}),
    },
    tags: mergedTags.length > 0 ? mergedTags : undefined,
    ...(options?.operationId ? { operationId: options.operationId } : {}),
    updateMode: useSessionScopedDoc ? "append" : undefined,
  };
}

export function prepareRetentionTranscript(
  messages: any[],
  pluginConfig: PluginConfig,
  retainFullWindow = false,
): { transcript: string; messageCount: number } | null {
  if (!messages || messages.length === 0) {
    return null;
  }

  let targetMessages: any[];
  if (retainFullWindow) {
    // Chunked retention: retain the full sliding window (omitting internal turns)
    targetMessages = filterInternalAndOperationalTurns(messages);
  } else {
    // Default: retain only the last turn (user message + assistant responses)
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user" && isUserTurnInitiator(messages[i])) {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) {
      return null; // No user message found in turn
    }
    const lastTurnMessages = messages.slice(lastUserIdx);
    const filteredLastTurn =
      filterInternalAndOperationalTurns(lastTurnMessages);
    if (filteredLastTurn.length === 0) {
      return null;
    }
    targetMessages = filteredLastTurn;
  }

  if (!targetMessages || targetMessages.length === 0) {
    return null;
  }

  const format = pluginConfig.retainFormat ?? "json";
  const includeToolCalls =
    format === "json" && pluginConfig.retainToolCalls !== false;

  if (includeToolCalls) {
    const structured = buildAnthropicStructuredMessages(
      targetMessages,
      pluginConfig,
    );
    if (structured.length === 0) return null;
    const transcript = JSON.stringify(structured);
    if (!transcript.trim() || transcript.length < 10) return null;
    return { transcript, messageCount: structured.length };
  }

  // Role filtering (text-only path)
  const allowedRoles = new Set(
    pluginConfig.retainRoles || ["user", "assistant"],
  );
  const filteredMessages = targetMessages.filter((m: any) =>
    allowedRoles.has(m.role),
  );

  if (filteredMessages.length === 0) {
    return null; // No messages to retain
  }

  const normalized: Array<{
    role: string;
    content: string;
    timestamp?: string;
  }> = [];
  for (const msg of filteredMessages) {
    const role = msg.role || "unknown";
    let content = "";

    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      const sanitized = sanitizeInternalRuntimeContextFromBlocks(msg.content);
      content = sanitized
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("\n");
    }

    content = stripMemoryTags(content);
    content = stripInlineRetainTags(content);
    content = stripMetadataEnvelopes(content);
    content = stripInlineTimestampPrefix(content);
    content = stripRuntimeEnvelope(content).trim();

    if (content.trim()) {
      const timestamp = normalizeMessageTimestamp(msg);
      normalized.push(
        timestamp ? { role, content, timestamp } : { role, content },
      );
    }
  }

  if (normalized.length === 0) return null;

  let transcript: string;
  let messageCount: number;
  if (format === "text") {
    transcript = normalized
      .map(({ role, content }) => `[role: ${role}]\n${content}\n[${role}:end]`)
      .join("\n\n");
    messageCount = normalized.length;
  } else {
    transcript = JSON.stringify(normalized);
    messageCount = normalized.length;
  }

  if (!transcript.trim() || transcript.length < 10) return null;

  return { transcript, messageCount };
}

// MCP tool name suffixes that are operational (recall/retain/search/CRUD) and
// shouldn't be retained — preserves agent reasoning without creating feedback
// loops on Hindsight's own MCP surface. Mirrors the claude-code integration.
const OPERATIONAL_TOOL_PATTERN =
  /(?:recall|retain|reflect|search|extract|create_|delete_|update_|get_|list_)/i;
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Build an Anthropic-shaped message array from OpenClaw's session messages.
 *
 * OpenClaw stores assistant content as a block array that may contain
 * `text`, `thinking`, and `toolCall` entries, and emits tool results as
 * separate messages with `role: "toolResult"`. The Anthropic wire format
 * expected by Hindsight's Claude Code integration (and downstream consumers)
 * is: assistant messages carry `text` and `tool_use` blocks, and tool
 * results live in a following `user` message as `tool_result` blocks.
 * We translate to that shape here so stored documents are consistent
 * across integrations.
 */
function buildAnthropicStructuredMessages(
  messages: any[],
  pluginConfig: PluginConfig,
): Array<{ role: string; content: any[]; timestamp?: string }> {
  const allowedRoles = new Set(
    pluginConfig.retainRoles || ["user", "assistant"],
  );
  const out: Array<{ role: string; content: any[]; timestamp?: string }> = [];

  for (const msg of messages) {
    const rawRole = msg?.role;
    if (rawRole === "toolResult") {
      const toolResultBlock = buildToolResultBlock(msg);
      if (!toolResultBlock) continue;
      // Fold tool_result into a synthetic user message (Anthropic convention),
      // merging with an immediately-preceding synthetic user if one exists so
      // consecutive tool results stay together.
      const last = out[out.length - 1];
      if (
        last &&
        last.role === "user" &&
        last.content.every((b: any) => b.type === "tool_result")
      ) {
        last.content.push(toolResultBlock);
      } else {
        out.push({ role: "user", content: [toolResultBlock] });
      }
      continue;
    }

    if (!allowedRoles.has(rawRole)) continue;

    const blocks = extractStructuredBlocks(msg.content, rawRole);
    if (blocks.length > 0) {
      const timestamp = normalizeMessageTimestamp(msg);
      out.push(
        timestamp
          ? { role: rawRole, content: blocks, timestamp }
          : { role: rawRole, content: blocks },
      );
    }
  }

  return out;
}

function normalizeMessageTimestamp(msg: any): string | undefined {
  const raw = msg?.timestamp;
  if (raw === undefined || raw === null) return undefined;
  const date =
    typeof raw === "number"
      ? new Date(raw)
      : typeof raw === "string"
        ? new Date(raw)
        : undefined;
  if (!date || Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function extractStructuredBlocks(content: any, role: string): any[] {
  if (typeof content === "string") {
    const cleaned = stripRuntimeEnvelope(
      stripInlineTimestampPrefix(
        stripMetadataEnvelopes(stripInlineRetainTags(stripMemoryTags(content))),
      ),
    ).trim();
    return cleaned ? [{ type: "text", text: cleaned }] : [];
  }
  if (!Array.isArray(content)) return [];

  const sanitizedContent = sanitizeInternalRuntimeContextFromBlocks(content);
  const blocks: any[] = [];
  for (const block of sanitizedContent) {
    if (!block || typeof block !== "object") continue;
    const blockType = block.type;

    if (blockType === "text") {
      const cleaned = stripRuntimeEnvelope(
        stripInlineTimestampPrefix(
          stripMetadataEnvelopes(
            stripInlineRetainTags(stripMemoryTags(block.text ?? "")),
          ),
        ),
      ).trim();
      if (cleaned) blocks.push({ type: "text", text: cleaned });
    } else if (blockType === "toolCall" && role === "assistant") {
      const name = typeof block.name === "string" ? block.name : "unknown";
      // Skip Hindsight's own MCP operational tools to avoid feedback loops.
      if (
        name.startsWith("mcp__") &&
        OPERATIONAL_TOOL_PATTERN.test(name.split("__").pop() ?? "")
      )
        continue;
      const input =
        block.arguments && typeof block.arguments === "object"
          ? block.arguments
          : {};
      const id = typeof block.id === "string" ? block.id : undefined;
      const toolUse: any = { type: "tool_use", name, input };
      if (id) toolUse.id = id;
      blocks.push(toolUse);
    }
    // thinking / unknown types are dropped
  }
  return blocks;
}

function buildToolResultBlock(msg: any): any | null {
  const toolUseId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
  const raw = msg.content;
  let text = "";
  if (typeof raw === "string") {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  text = text.trim();
  if (!text) return null;
  if (text.length > TOOL_RESULT_MAX_CHARS) {
    text = text.slice(0, TOOL_RESULT_MAX_CHARS) + "... (truncated)";
  }
  const block: any = { type: "tool_result", content: text };
  if (toolUseId) block.tool_use_id = toolUseId;
  return block;
}

export function sliceLastTurnsByUserBoundary(
  messages: any[],
  turns: number,
): any[] {
  if (!Array.isArray(messages) || messages.length === 0 || turns <= 0) {
    return [];
  }

  // Count only user messages that contain actual text content.
  // OpenClaw normalizes tool_result blocks into role:"user" messages with a
  // tool_result content block. Without this filter those synthetic messages
  // would be counted as real user turns, causing the window to exclude actual
  // user input from the retained transcript.
  function hasRealTextContent(msg: any): boolean {
    if (msg?.role !== "user") return false;
    const content = msg.content;
    if (typeof content === "string") return content.trim().length > 0;
    if (Array.isArray(content)) {
      return content.some(
        (b: any) =>
          b?.type === "text" &&
          typeof b?.text === "string" &&
          b.text.trim().length > 0,
      );
    }
    return false;
  }

  let userTurnsSeen = 0;
  let startIndex = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (
      messages[i]?.role === "user" &&
      hasRealTextContent(messages[i]) &&
      !isInternalOrOperationalTurnMessage(messages[i])
    ) {
      userTurnsSeen += 1;
      if (userTurnsSeen >= turns) {
        startIndex = i;
        break;
      }
    }
  }

  if (startIndex === -1) {
    return messages;
  }

  return messages.slice(startIndex);
}

export function getClient() {
  return client;
}

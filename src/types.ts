import type { MinScores } from "@vectorize-io/hindsight-client";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";

export type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginToolContext,
};

// Infer hook contracts from the public registration API: the SDK does not
// export the individual hook types through a public subpath.
declare const on: OpenClawPluginApi["on"];
export type PluginHookName = Parameters<typeof on>[0];
export type PluginHookHandler<K extends PluginHookName> = Parameters<
  typeof on<K>
>[1];
export type PluginHookEvent<K extends PluginHookName> = Parameters<
  PluginHookHandler<K>
>[0];
export type PluginHookAgentContext = Parameters<
  PluginHookHandler<"before_prompt_build">
>[1];
export type PluginHookSessionContext = Parameters<
  PluginHookHandler<"session_end">
>[1];

// Persisted transcripts can contain legacy provenance fields. Live hook
// contexts above always retain the host SDK's current contract.
export type InputProvenance = Partial<
  NonNullable<PluginHookAgentContext["inputProvenance"]>
> & {
  sourceRole?: string;
};

/** A single content block of an OpenClaw session message. */
export interface OpenClawMessageContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Minimal shape of an OpenClaw session message as seen by the plugin. Only the
 * fields used for turn classification are typed; anything else the host adds
 * (timestamps, tool ids, …) passes through untouched.
 */
export interface OpenClawMessage {
  role?: string;
  content?: string | Array<OpenClawMessageContentBlock | null | undefined>;
  trigger?: string;
  inputProvenance?: InputProvenance;
  provenance?: InputProvenance;
  [key: string]: unknown;
}

/** Session-key exclusions for automatic memory only; explicit tools are unaffected. */
export interface MemoryScope {
  /** Skip automatic recall for matching session keys. Default: []; ["**"] disables it globally. */
  skipRecallSessions?: string[];
  /** Skip automatic retention for matching session keys. Default: []; ["**"] disables it globally. */
  skipRetainSessions?: string[];
}

export interface PluginConfig {
  /** Automatic recall/retain are enabled unless excluded by these session-key globs. */
  scope?: MemoryScope;
  /**
   * Mission for the Reflect operation. Stamped onto the bank's `reflect_mission`
   * field via createBank() on first use. Has no effect on retain or recall.
   * Leave unset (or empty) to manage missions out-of-band via the API.
   */
  bankMission?: string;
  /**
   * Mission for the Retain operation. Steers what gets extracted as facts.
   * Stamped onto the bank's `retain_mission` field on first use.
   */
  retainMission?: string;
  /**
   * Mission for observation consolidation. Stamped onto the bank's
   * `observations_mission` field on first use.
   */
  observationsMission?: string;
  /**
   * Fact extraction mode stamped onto dynamic/static banks on first use.
   * Leave unset to keep the Hindsight server default for new banks.
   */
  retainExtractionMode?:
    "concise" | "verbose" | "custom" | "verbatim" | "chunks";
  /** Toggle observation consolidation for new banks. */
  enableObservations?: boolean;
  /** Toggle automatic consolidation scheduling for new banks. */
  enableAutoConsolidation?: boolean;
  /** Reflect disposition traits (1–5) stamped on first bank use. */
  dispositionSkepticism?: number;
  dispositionLiteralism?: number;
  dispositionEmpathy?: number;
  /**
   * Controlled vocabulary for entity labels. Either a list of attribute defs or
   * a `{ attributes: [...] }` object — passed through to PATCH /banks/{id}/config
   * as `entity_labels`. Other shapes are ignored (the server only accepts these two).
   */
  entityLabels?: unknown;
  embedPort?: number;
  daemonIdleTimeout?: number; // Seconds before daemon shuts down (0 = never)
  embedVersion?: string; // hindsight-embed version (default: "latest")
  embedPackagePath?: string; // Local path to hindsight package (e.g. '/path/to/hindsight')
  llmProvider?: string; // LLM provider (e.g. 'openai', 'anthropic', 'gemini', 'groq', 'ollama', 'openai-codex', 'claude-code')
  llmModel?: string; // LLM model (e.g. 'gpt-4o-mini', 'claude-3-5-haiku-20241022')
  llmApiKey?: string; // LLM provider API key. Configure via SecretRef: openclaw config set ... --ref-source env --ref-id OPENAI_API_KEY
  llmBaseUrl?: string; // Optional base URL override for OpenAI-compatible providers (e.g. OpenRouter)
  apiPort?: number; // Port for openclaw profile daemon (default: 9077)
  hindsightApiUrl?: string; // External Hindsight API URL (skips local daemon when set)
  hindsightApiToken?: string; // API token for external Hindsight API. Configure via SecretRef.
  dynamicBankId?: boolean; // Enable per-channel memory banks (default: true)
  bankId?: string; // Static bank ID used when dynamicBankId is false.
  bankIdPrefix?: string; // Prefix for bank IDs (e.g. 'prod' -> 'prod-slack-C123')
  agentBankMap?: Record<string, string>; // Explicit agentId -> bankId routing, checked before static/dynamic derivation. Lets a group of agents share one named bank while others keep derived banks. Mapped names are used exactly as given (bankIdPrefix is not applied).
  retainTags?: string[]; // Tags applied to all retained documents after trimming and deduplication; auto-retain merges these with inline per-message retain-tag directives (e.g. ['source_system:openclaw', 'agent:agentname'])
  retainSource?: string; // Source written into retained document metadata (default: 'openclaw')
  retainContext?: string; // Interpretation guidance sent via the retain API context field. Defaults to built-in OpenClaw transcript/routing metadata guidance.
  dynamicBankGranularity?: Array<"agent" | "provider" | "channel" | "user">; // Fields for bank ID derivation. Default: ['agent', 'channel', 'user']
  retainRoles?: Array<"user" | "assistant" | "system" | "tool">; // Roles to include in retained transcript. Default: ['user', 'assistant']
  retainFormat?: "json" | "text"; // Serialization format for retained conversation content. Default: 'json' (structured array of {role, content}); 'text' emits legacy '[role: x] ... [x:end]' markers.
  retainToolCalls?: boolean; // When true (default) and retainFormat='json', each message's content is an Anthropic-shaped array of typed blocks (text, tool_use, tool_result) including the agent's tool calls and their results. When false, content is a flat string with only text.
  recallBudget?: "low" | "mid" | "high"; // Recall effort. Default: 'mid'
  recallMaxTokens?: number; // Max tokens for recall response. Default: 1024
  recallTypes?: Array<"world" | "experience" | "observation">; // Memory types to recall. Default: ['observation'] — surfaces only the consolidated, deduplicated view (raw world/experience facts can drive the same answer multiple times when many memories say the same thing).
  preferObservations?: boolean; // When true, recall drops raw facts already consolidated into an observation while keeping unconsolidated ones. Pair with recallTypes including raw types to catch just-retained facts without duplicating consolidated content. Default: false.
  recallMinScores?: MinScores; // Optional per-stage score floors. Missing fields impose no floor; missing/null result scores pass.
  recallRoles?: Array<"user" | "assistant" | "system" | "tool">; // Roles to include when composing contextual recall query. Default: ['user', 'assistant']
  retainEveryNTurns?: number; // Retain every Nth turn (1 = every turn, default: 1). Values > 1 enable chunked retention.
  retainOverlapTurns?: number; // Extra prior turns included when chunked retention fires (default: 0). Window = retainEveryNTurns + retainOverlapTurns.
  recallTopK?: number; // Max number of memories to inject. Default: unlimited
  recallContextTurns?: number; // Number of user turns to include in recall query context. Default: 1 (latest only)
  recallTimeoutMs?: number; // Timeout for auto-recall in milliseconds. Default: 10000
  recallMaxQueryChars?: number; // Max chars for composed recall query. Default: 800
  recallPromptPreamble?: string; // Prompt preamble placed above recalled memories. Default: built-in guidance text.
  recallInjectionPosition?: "prepend" | "append" | "user"; // Where to inject recalled memories. 'user' = before user message (default, preserves system prompt cache), 'prepend' = start of system prompt, 'append' = end of system prompt.
  debug?: boolean; // Enable debug logging (default: false)
  logLevel?: "off" | "error" | "warning" | "info" | "debug"; // Console log verbosity (default: 'info').
  logSummaryIntervalMs?: number; // Batch retain/recall log summaries over this interval in ms. 0 = log every event. Default: 300000 (5 min).
  retainQueuePath?: string; // Queue base path; durable entries are stored in the adjacent .d directory. Existing JSONL is migrated and archived. Default: ~/.openclaw/plugins/hindsight/retain-queue.jsonl
  retainQueueMaxAgeMs?: number; // Max age in ms for queued items. -1 = keep forever (default: -1)
  retainQueueFlushIntervalMs?: number; // How often to attempt flushing the queue in ms. Default: 60000 (1 min)
  /**
   * Regex source matching a human display-name prefix that some channels
   * prepend to user text ("Alice: today weather?"). Supply the name part only
   * (e.g. `Alice|Bob` or `[A-Za-z ]{1,20}`) — the `:` separator and anchoring
   * are added by the plugin. When set, the prefix is removed from both recall
   * queries and retained transcripts. Unset (default) strips nothing; an
   * invalid regex is ignored. (#3070)
   */
  senderPrefixPattern?: string;
  /**
   * Emit per-hook latency lines (`before_prompt_build` recall RPC time,
   * `agent_end` retain RPC time, total hook time) at info level so users can
   * diagnose latency without patching the dist. Default: false.
   */
  debugPerfTiming?: boolean;
}

// -----------------------------------------------------------------------------
// Hindsight API types
// -----------------------------------------------------------------------------

// MemoryResult / RecallResponse / ReflectResponse come from the generated
// hindsight-client SDK. We alias MemoryResult → RecallResult so existing code
// paths (formatMemories, etc.) keep the old name.
export type {
  RecallResult as MemoryResult,
  RecallResponse,
  ReflectResponse,
} from "@vectorize-io/hindsight-client";

/**
 * Internal retain payload shape built by `buildRetainRequest`. Not a
 * re-export from the generated client — the generated client's retain()
 * takes bankId + content + options as positional args, whereas we build up a
 * single object inside the plugin and translate it at the call site. Keeping
 * this type local means tests can assert the shape without pulling in
 * generated types.
 */
export interface RetainRequest {
  content: string;
  documentId?: string;
  context?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  /** Stable identity reused when an asynchronous retain is retried. */
  operationId?: string;
  /**
   * `'append'` concatenates this content to the existing document text
   * (Hindsight ≥ 0.5 only — older versions silently ignore the field and
   * overwrite). The plugin only sets this when capability detection at
   * service.start() confirmed support; otherwise it falls back to a
   * per-turn document id and leaves this unset.
   */
  updateMode?: "replace" | "append";
}

/**
 * Stats returned by `GET /v1/default/banks/{bank_id}/stats`. The generated
 * high-level client does not expose this endpoint yet; backfill calls it
 * directly via `fetch`.
 */
export interface BankStats {
  bank_id: string;
  total_nodes: number;
  total_links: number;
  total_documents: number;
  pending_operations: number;
  failed_operations: number;
  pending_consolidation: number;
  last_consolidated_at: string | null;
  total_observations: number;
  nodes_by_fact_type?: Record<string, number>;
  links_by_link_type?: Record<string, number>;
  links_by_fact_type?: Record<string, number>;
  links_breakdown?: Record<string, unknown>;
}

import {
  createClient,
  type HindsightClient,
} from "@vectorize-io/hindsight-client";
import type { PluginConfig } from "./types.js";

export type RetainExtractionMode =
  "concise" | "verbose" | "custom" | "verbatim" | "chunks";

const RETAIN_EXTRACTION_MODES = new Set<RetainExtractionMode>([
  "concise",
  "verbose",
  "custom",
  "verbatim",
  "chunks",
]);

export interface CreateBankDefaults {
  reflectMission?: string;
  retainMission?: string;
  observationsMission?: string;
  retainExtractionMode?: RetainExtractionMode;
  enableObservations?: boolean;
  dispositionSkepticism?: number;
  dispositionLiteralism?: number;
  dispositionEmpathy?: number;
}

export interface BankConfigApiUpdates {
  entity_labels?: unknown;
  enable_auto_consolidation?: boolean;
}

export function normalizeDispositionTrait(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < 1 || value > 5) return undefined;
  return value;
}

export function normalizeRetainExtractionMode(
  value: unknown,
): RetainExtractionMode | undefined {
  if (typeof value !== "string") return undefined;
  const mode = value.trim().toLowerCase();
  return RETAIN_EXTRACTION_MODES.has(mode as RetainExtractionMode)
    ? (mode as RetainExtractionMode)
    : undefined;
}

export function normalizeEntityLabels(value: unknown): unknown | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    return value.length > 0 ? value : undefined;
  }
  // The server accepts either a bare list or a `{ attributes: [...] }` object
  // (see parse_entity_labels). A plain keyed object is silently ignored
  // server-side, so only pass through the documented wrapper shape — otherwise
  // drop it and preserve the bank's existing entity_labels.
  if (typeof value === "object") {
    const attributes = (value as { attributes?: unknown }).attributes;
    return Array.isArray(attributes) && attributes.length > 0
      ? value
      : undefined;
  }
  return undefined;
}

function missionFromConfig(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Build createBank() payload from plugin config. Only includes explicitly set
 * fields so unset options preserve server/bank defaults (backwards compatible).
 */
export function buildCreateBankDefaults(
  config: PluginConfig,
): CreateBankDefaults {
  const out: CreateBankDefaults = {};

  const reflectMission = missionFromConfig(config.bankMission);
  if (reflectMission) out.reflectMission = reflectMission;

  const retainMission = missionFromConfig(config.retainMission);
  if (retainMission) out.retainMission = retainMission;

  const observationsMission = missionFromConfig(config.observationsMission);
  if (observationsMission) out.observationsMission = observationsMission;

  if (config.retainExtractionMode) {
    out.retainExtractionMode = config.retainExtractionMode;
  }
  if (typeof config.enableObservations === "boolean") {
    out.enableObservations = config.enableObservations;
  }

  if (config.dispositionSkepticism !== undefined) {
    out.dispositionSkepticism = config.dispositionSkepticism;
  }
  if (config.dispositionLiteralism !== undefined) {
    out.dispositionLiteralism = config.dispositionLiteralism;
  }
  if (config.dispositionEmpathy !== undefined) {
    out.dispositionEmpathy = config.dispositionEmpathy;
  }

  return out;
}

/**
 * Fields applied through updateBankConfig rather than createBank.
 */
export function buildBankConfigApiUpdates(
  config: PluginConfig,
): BankConfigApiUpdates {
  const out: BankConfigApiUpdates = {};

  if (config.entityLabels !== undefined) {
    out.entity_labels = config.entityLabels;
  }
  if (typeof config.enableAutoConsolidation === "boolean") {
    out.enable_auto_consolidation = config.enableAutoConsolidation;
  }

  return out;
}

export function hasConfiguredBankDefaults(config: PluginConfig): boolean {
  const createPayload = buildCreateBankDefaults(config);
  const configUpdates = buildBankConfigApiUpdates(config);
  return (
    Object.keys(createPayload).length > 0 ||
    Object.keys(configUpdates).length > 0
  );
}

type InternalHeyApiClient = ReturnType<typeof createClient>;

export interface AuthorityGuardHandle {
  assertAuthority: () => void;
  rethrowAuthorityError: () => void;
  guardedFetch: typeof fetch;
}

/**
 * Build an invocation-scoped authority guard whose `guardedFetch` re-validates
 * live invocation and memory-audience authority synchronously immediately
 * before dispatching `fetch`, closing the async gap inside SDK request
 * preparation (`await beforeRequest(...)`) and across capacity retries.
 */
export function createAuthorityGuardHandle(
  assertAuthorityCurrent: () => void,
  baseFetch?: typeof fetch,
): AuthorityGuardHandle {
  let authorityError: unknown;
  const assertAuthority = (): void => {
    try {
      assertAuthorityCurrent();
    } catch (err) {
      authorityError ??= err;
      throw err;
    }
  };
  const rethrowAuthorityError = (): void => {
    if (authorityError !== undefined) {
      throw authorityError;
    }
  };
  const guardedFetch: typeof fetch = (input, init) => {
    assertAuthority();
    const dispatch = baseFetch ?? globalThis.fetch;
    return dispatch(input, init).then((response) => {
      assertAuthority();
      return response;
    });
  };
  return { assertAuthority, rethrowAuthorityError, guardedFetch };
}

/**
 * Derive an invocation-scoped `HindsightClient` view backed by a transport
 * that enforces `guard.assertAuthority()` synchronously before every `fetch`
 * without mutating the source client.
 */
export function withAuthorityGuardedClient(
  client: HindsightClient,
  guard: AuthorityGuardHandle,
): HindsightClient {
  const innerClient = (client as unknown as { client?: InternalHeyApiClient })
    .client;
  if (typeof innerClient?.getConfig !== "function") {
    throw new Error(
      "HindsightClient internal transport is unavailable for authority guard injection",
    );
  }
  const existingConfig = innerClient.getConfig();
  const existingFetch = existingConfig.fetch as typeof fetch | undefined;
  const transportFetch: typeof fetch =
    existingFetch && existingFetch !== guard.guardedFetch
      ? (input, init) => {
          guard.assertAuthority();
          return existingFetch(input, init).then((response) => {
            guard.assertAuthority();
            return response;
          });
        }
      : guard.guardedFetch;
  const guardedInnerClient = createClient({
    ...existingConfig,
    fetch: transportFetch,
  });
  return Object.assign(
    Object.create(Object.getPrototypeOf(client)) as object,
    client,
    { client: guardedInnerClient },
  ) as HindsightClient;
}

/**
 * Stamp configured missions and bank defaults onto a bank exactly once per
 * process lifetime (caller tracks the set). No-op when no defaults are configured.
 */
export async function applyConfiguredBankDefaults(
  client: HindsightClient,
  bankId: string,
  config: PluginConfig,
  assertAuthorityCurrent?: () => void,
): Promise<void> {
  const createPayload = buildCreateBankDefaults(config);
  const configUpdates = buildBankConfigApiUpdates(config);

  if (
    Object.keys(createPayload).length === 0 &&
    Object.keys(configUpdates).length === 0
  ) {
    return;
  }

  const guard = assertAuthorityCurrent
    ? createAuthorityGuardHandle(assertAuthorityCurrent)
    : undefined;
  const effectiveClient = guard
    ? withAuthorityGuardedClient(client, guard)
    : client;

  try {
    if (Object.keys(createPayload).length > 0) {
      guard?.assertAuthority();
      await effectiveClient.createBank(bankId, createPayload);
    }

    if (Object.keys(configUpdates).length > 0) {
      guard?.assertAuthority();
      await effectiveClient.updateBankConfig(bankId, {
        // Older servers also accept an attributes wrapper. The SDK's narrower
        // type must not change the payload accepted by existing plugin configs.
        entityLabels: configUpdates.entity_labels as Parameters<
          HindsightClient["updateBankConfig"]
        >[1]["entityLabels"],
        enableAutoConsolidation: configUpdates.enable_auto_consolidation,
      });
    }

    guard?.rethrowAuthorityError();
    guard?.assertAuthority();
  } catch (err) {
    guard?.rethrowAuthorityError();
    throw err;
  }
}

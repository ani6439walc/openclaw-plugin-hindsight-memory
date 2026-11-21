import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type BackfillSecretField = "hindsightApiToken" | "llmApiKey";

export const BACKFILL_SECRET_FIELDS: readonly BackfillSecretField[] = [
  "hindsightApiToken",
  "llmApiKey",
];

const MAX_DOTENV_FILE_BYTES = 1024 * 1024;
const VALID_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_REF_SOURCES = new Set(["env", "file", "exec", "store"]);

export interface ParsedSecretRef {
  source: "env" | "file" | "exec" | "store";
  provider?: string;
  id: string;
}

export interface OpenClawSecretProviderConfig {
  source?: string;
  allowlist?: unknown;
  [key: string]: unknown;
}

export interface OpenClawSecretsConfig {
  defaults?: {
    env?: string;
    file?: string;
    exec?: string;
    store?: string;
  };
  providers?: Record<string, OpenClawSecretProviderConfig>;
}

export type OfflineSecretResolution =
  | { status: "absent" }
  | { status: "resolved"; value: string | undefined }
  | { status: "invalid"; reason: string }
  | { status: "unsupported-offline"; ref: ParsedSecretRef; reason: string }
  | { status: "unresolved"; ref: ParsedSecretRef; reason: string };

export function isBackfillSecretField(
  value: unknown,
): value is BackfillSecretField {
  return value === "hindsightApiToken" || value === "llmApiKey";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseSecretRef(value: unknown): ParsedSecretRef | null {
  if (!isPlainRecord(value)) return null;
  const source = value.source;
  const id = value.id;
  const provider = value.provider;
  if (typeof source !== "string" || !SECRET_REF_SOURCES.has(source)) {
    return null;
  }
  if (typeof id !== "string" || id.trim().length === 0) {
    return null;
  }
  if (
    provider !== undefined &&
    (typeof provider !== "string" || provider.trim().length === 0)
  ) {
    return null;
  }
  return {
    source: source as ParsedSecretRef["source"],
    ...(provider !== undefined ? { provider: provider.trim() } : {}),
    id: id.trim(),
  };
}

function unescapeDoubleQuoted(raw: string): string {
  let result = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== "\\" || i + 1 >= raw.length) {
      result += ch;
      continue;
    }
    const next = raw[i + 1];
    switch (next) {
      case "n":
        result += "\n";
        i += 1;
        break;
      case "r":
        result += "\r";
        i += 1;
        break;
      case "t":
        result += "\t";
        i += 1;
        break;
      case '"':
      case "\\":
        result += next;
        i += 1;
        break;
      default:
        result += ch;
        break;
    }
  }
  return result;
}

function parseQuotedDotEnvValue(
  raw: string,
  quote: '"' | "'" | "`",
): string | null {
  let i = 1;
  while (i < raw.length) {
    if (quote === '"' && raw[i] === "\\" && i + 1 < raw.length) {
      i += 2;
      continue;
    }
    if (raw[i] === quote) {
      const rest = raw.slice(i + 1).trim();
      if (rest.length > 0 && !rest.startsWith("#")) {
        return null;
      }
      const inner = raw.slice(1, i);
      return quote === '"' ? unescapeDoubleQuoted(inner) : inner;
    }
    i += 1;
  }
  return null;
}

export function parseDotEnvContent(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trimStart()
      : trimmed;
    const eqIndex = withoutExport.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = withoutExport.slice(0, eqIndex).trim();
    if (!VALID_ENV_KEY_RE.test(key)) continue;
    const rawValue = withoutExport.slice(eqIndex + 1).trimStart();
    if (rawValue.length === 0) {
      parsed[key] = "";
      continue;
    }
    const first = rawValue[0];
    if (first === '"' || first === "'" || first === "`") {
      const quoted = parseQuotedDotEnvValue(rawValue, first);
      if (quoted !== null) {
        parsed[key] = quoted;
        continue;
      }
    }
    const commentMatch = /\s+#/.exec(rawValue);
    const unquoted =
      commentMatch !== null ? rawValue.slice(0, commentMatch.index) : rawValue;
    parsed[key] = unquoted.trim();
  }
  return parsed;
}

export function readOpenClawRootDotEnv(
  openclawRoot: string | undefined,
): Record<string, string> {
  if (!openclawRoot || !openclawRoot.trim()) return {};
  const dotEnvPath = join(openclawRoot, ".env");
  try {
    const info = statSync(dotEnvPath);
    if (!info.isFile() || info.size > MAX_DOTENV_FILE_BYTES) {
      return {};
    }
    return parseDotEnvContent(readFileSync(dotEnvPath, "utf8"));
  } catch {
    return {};
  }
}

export function mergeOpenClawRootDotEnv(
  openclawRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  allowedKeys?: Iterable<string>,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  const allowSet = allowedKeys ? new Set(allowedKeys) : null;
  if (allowSet && allowSet.size === 0) {
    return merged;
  }
  const dotEnv = readOpenClawRootDotEnv(openclawRoot);
  for (const [key, value] of Object.entries(dotEnv)) {
    if (allowSet && !allowSet.has(key)) continue;
    if (merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

export function loadSecretsConfigFromOpenClawRoot(
  openclawRoot: string | undefined,
): OpenClawSecretsConfig | undefined {
  if (!openclawRoot || !openclawRoot.trim()) return undefined;
  const configPath = join(openclawRoot, "openclaw.json");
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const raw = JSON.parse(content) as { secrets?: unknown };
  return isPlainRecord(raw?.secrets)
    ? (raw.secrets as OpenClawSecretsConfig)
    : undefined;
}

export function resolveEnvSecretRefFromConfig(
  value: unknown,
  secretsConfig?: OpenClawSecretsConfig,
  env: NodeJS.ProcessEnv = process.env,
): OfflineSecretResolution {
  if (value === undefined || value === null) {
    return { status: "absent" };
  }
  if (typeof value === "string") {
    return { status: "resolved", value: value || undefined };
  }
  const ref = parseSecretRef(value);
  if (!ref) {
    return { status: "invalid", reason: "expected string or SecretRef" };
  }
  const providerName =
    ref.provider ??
    (ref.source === "env" ? secretsConfig?.defaults?.env : undefined) ??
    "default";
  if (ref.source !== "env") {
    return {
      status: "unsupported-offline",
      ref,
      reason: `SecretRef (${ref.source}:${providerName}:${ref.id}) requires OpenClaw host secret resolution`,
    };
  }
  const providerConfig = secretsConfig?.providers?.[providerName];
  if (providerConfig) {
    if (providerConfig.source !== "env") {
      return {
        status: "unresolved",
        ref,
        reason: `Secret provider "${providerName}" has source "${String(providerConfig.source)}" instead of "env"`,
      };
    }
    if (
      Array.isArray(providerConfig.allowlist) &&
      !providerConfig.allowlist.includes(ref.id)
    ) {
      return {
        status: "unresolved",
        ref,
        reason: `Environment variable "${ref.id}" is not allowlisted in secrets.providers.${providerName}.allowlist`,
      };
    }
  } else if (providerName !== "default") {
    return {
      status: "unresolved",
      ref,
      reason: `Secret provider "${providerName}" is not configured`,
    };
  }
  const resolved = env[ref.id];
  if (typeof resolved === "string" && resolved.trim().length > 0) {
    return { status: "resolved", value: resolved.trim() };
  }
  return {
    status: "unresolved",
    ref,
    reason: `Environment variable "${ref.id}" is missing or empty`,
  };
}

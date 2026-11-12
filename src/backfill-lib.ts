import { homedir } from "os";
import { dirname, join, resolve } from "path";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
} from "fs";
import { deriveBankId, prepareRetentionTranscript } from "./index.js";
import type { PluginConfig, PluginHookAgentContext } from "./types.js";
import { parseSessionFile } from "./session-file.js";
import {
  parseSessionRecords,
  readSessionFileIdentity,
} from "./session-file.js";
import type {
  ParsedSessionFile,
  ParsedSessionTranscript,
  SessionMessage,
} from "./session-file.js";
import { createBackfillSourceReader } from "./backfill-source.js";
import type {
  BackfillSourceReader,
  SqliteBackfillSource,
} from "./backfill-source.js";

// Re-exported: these used to live here and callers import them from this module.
export { parseSessionFile };
export type { ParsedSessionFile, SessionMessage };

export interface BackfillCliOptions {
  openclawRoot: string;
  includeArchive: boolean;
  includeRetainedSqlite?: boolean;
  selectedAgents?: Set<string>;
  limit?: number;
  bankStrategy: "mirror-config" | "agent" | "fixed";
  fixedBank?: string;
}

export type BackfillTranscriptSource =
  { kind: "jsonl"; filePath: string } | SqliteBackfillSource;

export interface BackfillPlanEntry {
  filePath?: string;
  source: BackfillTranscriptSource;
  agentId: string;
  sessionId: string;
  startedAt?: string;
  bankId: string;
  documentId: string;
  transcript: string;
  messageCount: number;
}

export interface BackfillCheckpointEntry {
  status: "enqueued" | "completed" | "failed";
  bankId: string;
  filePath?: string;
  source?: BackfillTranscriptSource;
  sessionId: string;
  updatedAt: string;
  error?: string;
}

export interface BackfillCheckpoint {
  version: 1;
  entries: Record<string, BackfillCheckpointEntry>;
}

interface RawBackfillCheckpointEntry extends Omit<
  BackfillCheckpointEntry,
  "status"
> {
  status: BackfillCheckpointEntry["status"] | "queued";
}

interface RawBackfillCheckpoint {
  version: 1;
  entries: Record<string, RawBackfillCheckpointEntry>;
}

interface SessionDirectory {
  agentId: string;
  path: string;
}

const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  dynamicBankId: true,
  retainRoles: ["user", "assistant"],
};

export function withBackfillConfigDefaults(config: PluginConfig): PluginConfig {
  return { ...DEFAULT_PLUGIN_CONFIG, ...config };
}

export function defaultOpenClawRoot(): string {
  return resolve(join(homedir(), ".openclaw"));
}

export function defaultCheckpointPath(openclawRoot: string): string {
  return join(openclawRoot, "data", "hindsight-backfill-checkpoint.json");
}

export function loadPluginConfigFromOpenClawRoot(
  openclawRoot: string,
): PluginConfig {
  const configPath = join(openclawRoot, "openclaw.json");
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
    plugins?: { entries?: Record<string, { config?: PluginConfig }> };
  };
  return withBackfillConfigDefaults(
    raw.plugins?.entries?.["hindsight-memory"]?.config || {},
  );
}

function sessionDirectories(
  openclawRoot: string,
  includeArchive: boolean,
): SessionDirectory[] {
  const agentsRoot = join(openclawRoot, "agents");
  if (!existsSync(agentsRoot)) {
    return [];
  }
  const result: SessionDirectory[] = [];
  for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentId = entry.name;
    const sessionsDir = join(agentsRoot, agentId, "sessions");
    if (existsSync(sessionsDir)) {
      result.push({ agentId, path: sessionsDir });
    }
    if (includeArchive) {
      const archiveDir = join(
        agentsRoot,
        agentId,
        "sessions-archive-from-migration_backup",
      );
      if (existsSync(archiveDir)) {
        result.push({ agentId, path: archiveDir });
      }
    }
  }
  return result.sort(
    (a, b) =>
      a.agentId.localeCompare(b.agentId) || a.path.localeCompare(b.path),
  );
}

export function discoverSessionFiles(
  openclawRoot: string,
  includeArchive: boolean,
): Array<{ agentId: string; filePath: string }> {
  const sessions: Array<{ agentId: string; filePath: string }> = [];
  for (const dir of sessionDirectories(openclawRoot, includeArchive)) {
    for (const entry of readdirSync(dir.path, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      sessions.push({
        agentId: dir.agentId,
        filePath: join(dir.path, entry.name),
      });
    }
  }
  return sessions.sort(
    (a, b) =>
      a.agentId.localeCompare(b.agentId) ||
      a.filePath.localeCompare(b.filePath),
  );
}

function backfillContextForSession(
  session: Pick<ParsedSessionTranscript, "agentId" | "sessionKey">,
): PluginHookAgentContext {
  return {
    agentId: session.agentId,
    sessionKey: session.sessionKey,
  };
}

function deriveTargetBank(
  session: ParsedSessionTranscript,
  pluginConfig: PluginConfig,
  bankStrategy: BackfillCliOptions["bankStrategy"],
  fixedBank?: string,
): string {
  if (bankStrategy === "agent") {
    return session.agentId;
  }
  if (bankStrategy === "fixed") {
    if (!fixedBank) {
      throw new Error("fixed bank strategy requires --fixed-bank");
    }
    return fixedBank;
  }
  return deriveBankId(backfillContextForSession(session), pluginConfig);
}

export function stableDocumentId(
  session: Pick<ParsedSessionTranscript, "agentId" | "sessionId">,
  bankId: string,
): string {
  return `backfill::${bankId}::${session.agentId}::${session.sessionId}`;
}

export interface BackfillSourceIssue {
  agentId: string;
  sessionId?: string;
  reason: string;
}

export class BackfillPlanError extends Error {
  constructor(readonly issues: BackfillSourceIssue[]) {
    super(
      `Backfill plan is incomplete: ${issues.map((issue) => `${issue.agentId}${issue.sessionId ? `/${issue.sessionId}` : ""}: ${issue.reason}`).join("; ")}`,
    );
    this.name = "BackfillPlanError";
  }
}

export interface BackfillPlan {
  entries: BackfillPlanEntry[];
  discoveredSessions: number;
  skippedEmpty: number;
  duplicateSources: number;
  missingStores: number;
}

export async function buildBackfillPlan(
  pluginConfig: PluginConfig,
  opts: BackfillCliOptions,
  sourceReader?: BackfillSourceReader,
): Promise<BackfillPlan> {
  const reader = sourceReader ?? createBackfillSourceReader(opts.openclawRoot);
  try {
    return await buildPlanWithReader(pluginConfig, opts, reader);
  } finally {
    if (!sourceReader) await reader.close();
  }
}

async function buildPlanWithReader(
  pluginConfig: PluginConfig,
  opts: BackfillCliOptions,
  reader: BackfillSourceReader,
): Promise<BackfillPlan> {
  const entries: BackfillPlanEntry[] = [];
  const issues: BackfillSourceIssue[] = [];
  let discoveredSessions = 0;
  let skippedEmpty = 0;
  let duplicateSources = 0;
  let missingStores = 0;
  const prepared = await reader.prepare();
  const files = discoverSessionFiles(
    opts.openclawRoot,
    opts.includeArchive,
  ).filter(
    (candidate) =>
      !opts.selectedAgents || opts.selectedAgents.has(candidate.agentId),
  );
  const agentsRoot = join(opts.openclawRoot, "agents");
  const directoryAgents = existsSync(agentsRoot)
    ? readdirSync(agentsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  const agentIds = [
    ...(opts.selectedAgents ??
      new Set([
        ...prepared.agentIds,
        ...directoryAgents,
        ...files.map((file) => file.agentId),
      ])),
  ].sort();
  type Candidate =
    | SqliteBackfillSource
    | { kind: "jsonl"; agentId: string; sessionId: string; filePath: string };
  const candidates: Candidate[] = [];
  for (const file of files) {
    try {
      candidates.push({
        kind: "jsonl",
        ...file,
        ...(await readSessionFileIdentity(file.filePath, file.agentId)),
      });
    } catch (error) {
      issues.push({
        agentId: file.agentId,
        reason:
          error instanceof SyntaxError ? "invalid-jsonl" : "source-read-failed",
      });
    }
  }

  for (const agentId of agentIds) {
    const result = await reader.discover(
      agentId,
      opts.includeRetainedSqlite === true,
    );
    if (result.status === "unavailable") {
      if (result.reason === "missing-store") missingStores += 1;
      else issues.push({ agentId, reason: result.reason });
      continue;
    }
    for (const source of result.sources) {
      if (source.agentId !== agentId) {
        issues.push({ agentId, reason: "host source agent mismatch" });
      } else if (
        source.artifactKind === "active-session" ||
        opts.includeRetainedSqlite === true
      ) {
        candidates.push(source);
      }
    }
  }
  if (issues.length) throw new BackfillPlanError(issues);

  // SQLite is the canonical copy. Stable ordering also prevents filesystem
  // enumeration order from changing which unique sessions consume --limit.
  candidates.sort(
    (a, b) =>
      a.agentId.localeCompare(b.agentId) ||
      a.sessionId.localeCompare(b.sessionId) ||
      (a.kind === b.kind ? 0 : a.kind === "sqlite" ? -1 : 1) ||
      (a.kind === "jsonl" && b.kind === "jsonl"
        ? a.filePath.localeCompare(b.filePath)
        : 0),
  );
  const seen = new Map<
    string,
    { transcript: string | null; sessionKey?: string }
  >();

  for (const candidate of candidates) {
    const candidateKey = JSON.stringify([
      candidate.agentId,
      candidate.sessionId,
    ]);
    // Verify every copy of the final selected identity before applying --limit.
    if (opts.limit && entries.length >= opts.limit && !seen.has(candidateKey))
      break;
    discoveredSessions += 1;
    let parsed: ParsedSessionTranscript;
    try {
      if (candidate.kind === "jsonl") {
        parsed = parseSessionFile(candidate.filePath, candidate.agentId);
      } else {
        const result = await reader.read(candidate);
        if (result.status === "unavailable") {
          issues.push({
            agentId: candidate.agentId,
            sessionId: candidate.sessionId,
            reason: result.reason,
          });
          continue;
        }
        parsed = parseSessionRecords(result.events, candidate);
      }
      if (parsed.sessionId !== candidate.sessionId) {
        issues.push({
          agentId: candidate.agentId,
          sessionId: candidate.sessionId,
          reason: "source identity changed during planning",
        });
        continue;
      }
    } catch (error) {
      // Parser errors can quote transcript bytes; keep source diagnostics free
      // of conversation content at the CLI boundary.
      issues.push({
        agentId: candidate.agentId,
        reason:
          error instanceof SyntaxError ? "invalid-jsonl" : "source-read-failed",
      });
      continue;
    }
    let retention: ReturnType<typeof prepareRetentionTranscript>;
    try {
      retention = prepareRetentionTranscript(
        parsed.messages,
        pluginConfig,
        true,
      );
    } catch {
      issues.push({
        agentId: parsed.agentId,
        sessionId: parsed.sessionId,
        reason: "invalid-message-content",
      });
      continue;
    }
    const key = JSON.stringify([parsed.agentId, parsed.sessionId]);
    const previous = seen.get(key);
    if (previous) {
      if (
        previous.transcript !== (retention?.transcript ?? null) ||
        (previous.sessionKey &&
          parsed.sessionKey &&
          previous.sessionKey !== parsed.sessionKey)
      ) {
        issues.push({
          agentId: parsed.agentId,
          sessionId: parsed.sessionId,
          reason: "conflicting transcript sources",
        });
      } else duplicateSources += 1;
      continue;
    }
    seen.set(key, {
      transcript: retention?.transcript ?? null,
      sessionKey: parsed.sessionKey,
    });
    if (!retention) {
      skippedEmpty += 1;
      continue;
    }
    const bankId = deriveTargetBank(
      parsed,
      pluginConfig,
      opts.bankStrategy,
      opts.fixedBank,
    );
    const source: BackfillTranscriptSource =
      candidate.kind === "sqlite"
        ? candidate
        : { kind: "jsonl", filePath: candidate.filePath };
    entries.push({
      ...(candidate.kind === "jsonl" ? { filePath: candidate.filePath } : {}),
      source,
      agentId: parsed.agentId,
      sessionId: parsed.sessionId,
      startedAt: parsed.startedAt,
      bankId,
      documentId: stableDocumentId(parsed, bankId),
      transcript: retention.transcript,
      messageCount: retention.messageCount,
    });
  }
  if (issues.length) throw new BackfillPlanError(issues);
  return {
    entries,
    discoveredSessions,
    skippedEmpty,
    duplicateSources,
    missingStores,
  };
}

export function loadCheckpoint(checkpointPath: string): BackfillCheckpoint {
  if (!existsSync(checkpointPath)) {
    return { version: 1, entries: {} };
  }
  const raw = JSON.parse(
    readFileSync(checkpointPath, "utf8"),
  ) as RawBackfillCheckpoint;
  if (raw.version !== 1 || !raw.entries || typeof raw.entries !== "object") {
    return { version: 1, entries: {} };
  }
  return {
    version: 1,
    entries: Object.fromEntries(
      Object.entries(raw.entries).map(([key, entry]) => [
        key,
        {
          ...entry,
          status: entry.status === "queued" ? "enqueued" : entry.status,
        },
      ]),
    ) as Record<string, BackfillCheckpointEntry>,
  };
}

export function saveCheckpoint(
  checkpointPath: string,
  checkpoint: BackfillCheckpoint,
): void {
  mkdirSync(dirname(checkpointPath), { recursive: true });
  writeFileSync(
    checkpointPath,
    JSON.stringify(checkpoint, null, 2) + "\n",
    "utf8",
  );
}

export function checkpointKey(
  entry: Pick<BackfillPlanEntry, "bankId" | "documentId">,
): string {
  return `${entry.bankId}::${entry.documentId}`;
}

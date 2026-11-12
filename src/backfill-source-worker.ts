import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BackfillSourceReader,
  BackfillUnavailable,
  SqliteBackfillSource,
} from "./backfill-source.js";
import type { PluginConfig } from "./types.js";

type ModuleLoader = (specifier: string) => Promise<unknown>;
type Config = Record<string, unknown>;
type HostSessions = {
  listSessionTranscriptCorpusEntriesReadOnlyForAgent(
    agentId: string,
    options: {
      config: Config;
      includeRetainedSqlite: boolean;
      includeContentRevision: false;
    },
  ): Promise<unknown>;
  readSessionTranscriptSnapshotReadOnly(options: {
    agentId: string;
    sessionId: string;
    sessionKey?: string;
    storePath: string;
    env: NodeJS.ProcessEnv;
  }): Promise<unknown>;
};

class BackfillHostError extends Error {}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function unavailable(
  response: Record<string, unknown>,
  reasons: string[],
): BackfillUnavailable | undefined {
  if (response.status !== "unavailable") return;
  if (
    typeof response.reason !== "string" ||
    !reasons.includes(response.reason)
  ) {
    throw new BackfillHostError("Invalid OpenClaw read-only host response");
  }
  return {
    status: "unavailable",
    reason: response.reason,
    ...(typeof response.detail === "string" ? { detail: response.detail } : {}),
  };
}

function sqliteSource(value: unknown, agentId: string): SqliteBackfillSource {
  if (
    !object(value) ||
    value.agentId !== agentId ||
    !identity(value.agentId) ||
    !identity(value.sessionId) ||
    !identity(value.storePath) ||
    (value.sessionKey !== undefined && !identity(value.sessionKey)) ||
    (value.artifactKind !== "active-session" &&
      value.artifactKind !== "retained-session")
  ) {
    throw new BackfillHostError("Invalid OpenClaw SQLite corpus identity");
  }
  return {
    kind: "sqlite",
    agentId: value.agentId,
    sessionId: value.sessionId,
    storePath: value.storePath,
    artifactKind: value.artifactKind,
    ...(value.sessionKey !== undefined ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.updatedAtMs === "number" &&
    Number.isFinite(value.updatedAtMs)
      ? { updatedAtMs: value.updatedAtMs }
      : {}),
  };
}

/** In-process service boundary for synthetic tests; production runs only in the child. */
export function createBackfillWorkerService(
  loadModule: ModuleLoader,
  environment: NodeJS.ProcessEnv,
): BackfillSourceReader {
  const env = { ...environment };
  let closed = false;
  let prepared:
    | Promise<{
        config: Config;
        host: HostSessions;
        pluginConfig: PluginConfig;
        agentIds: string[];
      }>
    | undefined;

  async function publicModule(
    specifier: string,
  ): Promise<Record<string, unknown>> {
    let module: unknown;
    try {
      module = await loadModule(specifier);
    } catch {
      throw new BackfillHostError(
        `Unsupported OpenClaw host: missing public module ${specifier}`,
      );
    }
    if (!object(module)) {
      throw new BackfillHostError(
        `Unsupported OpenClaw host: invalid public module ${specifier}`,
      );
    }
    return module;
  }

  function prepare() {
    if (closed)
      return Promise.reject(
        new BackfillHostError("Backfill source reader is closed"),
      );
    prepared ??= (async () => {
      const hostModule = await publicModule(
        "openclaw/plugin-sdk/session-transcript-readonly",
      );
      for (const name of [
        "listSessionTranscriptCorpusEntriesReadOnlyForAgent",
        "readSessionTranscriptSnapshotReadOnly",
      ]) {
        if (typeof hostModule[name] !== "function") {
          throw new BackfillHostError(
            `Unsupported OpenClaw host: missing ${name}; read-only transcript capability is required`,
          );
        }
      }
      const host = hostModule as HostSessions;
      const health = await publicModule("openclaw/plugin-sdk/health");
      const agentScope = await publicModule(
        "openclaw/plugin-sdk/agent-scope-runtime",
      );
      if (
        typeof health.readConfigFileSnapshot !== "function" ||
        typeof agentScope.listAgentIds !== "function"
      ) {
        throw new BackfillHostError(
          "Unsupported OpenClaw host: missing public config or agent-scope helper",
        );
      }
      let snapshot: unknown;
      try {
        snapshot = await health.readConfigFileSnapshot({
          observe: false,
          isolateEnv: true,
          pluginValidation: "core-only",
          recoverSuspicious: false,
        });
      } catch {
        throw new BackfillHostError("Unable to read selected OpenClaw config");
      }
      if (
        !object(snapshot) ||
        snapshot.exists !== true ||
        snapshot.valid !== true ||
        !object(snapshot.config)
      ) {
        throw new BackfillHostError(
          "Selected OpenClaw config is missing or invalid",
        );
      }
      const config = snapshot.config;
      const agentIds: unknown = agentScope.listAgentIds(config);
      if (!Array.isArray(agentIds) || !agentIds.every(identity)) {
        throw new BackfillHostError("Invalid OpenClaw agent roster response");
      }
      const plugins = object(config.plugins) ? config.plugins : {};
      const entries = object(plugins.entries) ? plugins.entries : {};
      const plugin = object(entries["hindsight-memory"])
        ? entries["hindsight-memory"]
        : {};
      if (plugin.config !== undefined && !object(plugin.config)) {
        throw new BackfillHostError(
          "Selected Hindsight plugin config is invalid",
        );
      }
      return {
        config,
        host,
        pluginConfig: (plugin.config ?? {}) as PluginConfig,
        agentIds,
      };
    })();
    return prepared;
  }

  return {
    async prepare() {
      const { pluginConfig, agentIds } = await prepare();
      return { pluginConfig, agentIds };
    },
    async discover(agentId, includeRetained) {
      if (!identity(agentId))
        throw new BackfillHostError("Invalid backfill agent identity");
      const { config, host } = await prepare();
      let response: unknown;
      try {
        response =
          await host.listSessionTranscriptCorpusEntriesReadOnlyForAgent(
            agentId,
            {
              config,
              includeRetainedSqlite: includeRetained,
              includeContentRevision: false,
            },
          );
      } catch {
        throw new BackfillHostError(
          "OpenClaw read-only corpus discovery failed",
        );
      }
      if (!object(response))
        throw new BackfillHostError(
          "Invalid OpenClaw read-only corpus response",
        );
      const failure = unavailable(response, [
        "missing-store",
        "schema-unavailable",
        "refused",
        "unavailable",
      ]);
      if (failure) return failure;
      if (response.status !== "available" || !Array.isArray(response.entries))
        throw new BackfillHostError(
          "Invalid OpenClaw read-only corpus response",
        );
      const sources: SqliteBackfillSource[] = [];
      for (const row of response.entries) {
        if (!object(row))
          throw new BackfillHostError("Invalid OpenClaw corpus row");
        if (
          row.artifactKind === "archive-artifact" ||
          row.transcriptSource !== "sqlite"
        )
          continue;
        const source = sqliteSource(row, agentId);
        if (!includeRetained && source.artifactKind === "retained-session")
          continue;
        sources.push(source);
      }
      return { status: "available", sources };
    },
    async read(source) {
      if (
        !object(source) ||
        source.kind !== "sqlite" ||
        !identity(source.agentId)
      )
        throw new BackfillHostError("Invalid backfill SQLite source");
      sqliteSource(source, source.agentId);
      const { host } = await prepare();
      let response: unknown;
      try {
        response = await host.readSessionTranscriptSnapshotReadOnly({
          agentId: source.agentId,
          sessionId: source.sessionId,
          ...(source.sessionKey !== undefined
            ? { sessionKey: source.sessionKey }
            : {}),
          storePath: source.storePath,
          env,
        });
      } catch {
        throw new BackfillHostError(
          "OpenClaw read-only transcript read failed",
        );
      }
      if (!object(response))
        throw new BackfillHostError(
          "Invalid OpenClaw read-only transcript response",
        );
      const failure = unavailable(response, [
        "missing-store",
        "missing-transcript",
        "schema-unavailable",
        "cold",
        "refused",
        "unavailable",
      ]);
      if (failure) return failure;
      if (response.status !== "available" || !Array.isArray(response.events))
        throw new BackfillHostError(
          "Invalid OpenClaw read-only transcript response",
        );
      return { status: "available", events: response.events };
    },
    async close() {
      closed = true;
    },
  };
}

function startWorker(): void {
  const service = createBackfillWorkerService(
    (specifier) => import(specifier),
    process.env,
  );
  let queue = Promise.resolve();
  process.on("disconnect", () => process.exit(0));
  process.on("message", (request: unknown) => {
    queue = queue.then(async () => {
      if (!object(request) || !Number.isSafeInteger(request.id)) return;
      const id = request.id;
      try {
        let value: unknown;
        switch (request.operation) {
          case "prepare":
            value = await service.prepare();
            break;
          case "discover":
            if (
              typeof request.agentId !== "string" ||
              typeof request.includeRetained !== "boolean"
            )
              throw new BackfillHostError("Invalid backfill discovery request");
            value = await service.discover(
              request.agentId,
              request.includeRetained,
            );
            break;
          case "read":
            value = await service.read(request.source as SqliteBackfillSource);
            break;
          case "close":
            await service.close();
            break;
          default:
            throw new BackfillHostError("Invalid backfill source operation");
        }
        if (request.operation === "close") {
          process.send?.({ id, ok: true, value }, () => process.exit(0));
        } else process.send?.({ id, ok: true, value });
      } catch (error) {
        process.send?.({
          id,
          ok: false,
          error:
            error instanceof BackfillHostError
              ? error.message
              : "OpenClaw backfill source worker failed",
        });
      }
    });
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  startWorker();
}

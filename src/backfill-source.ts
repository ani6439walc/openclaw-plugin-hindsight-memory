import { fork, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import type { PluginConfig } from "./types.js";

export interface SqliteBackfillSource {
  kind: "sqlite";
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  storePath: string;
  artifactKind: "active-session" | "retained-session";
  updatedAtMs?: number;
}

export type BackfillUnavailable = {
  status: "unavailable";
  reason: string;
  detail?: string;
};

export interface BackfillSourceReader {
  prepare(): Promise<{ pluginConfig: PluginConfig; agentIds: string[] }>;
  discover(
    agentId: string,
    includeRetained: boolean,
  ): Promise<
    | { status: "available"; sources: SqliteBackfillSource[] }
    | BackfillUnavailable
  >;
  read(
    source: SqliteBackfillSource,
  ): Promise<{ status: "available"; events: unknown[] } | BackfillUnavailable>;
  close(): Promise<void>;
}

type BackfillWorkerOperation =
  | { operation: "prepare" }
  | { operation: "discover"; agentId: string; includeRetained: boolean }
  | { operation: "read"; source: SqliteBackfillSource }
  | { operation: "close" };

export type BackfillWorkerRequest = { id: number } & BackfillWorkerOperation;

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT_MS = 90_000;
const CLOSE_TIMEOUT_MS = 5_000;

/** CLI-only transport: host modules never load in the caller's process. */
export function createBackfillSourceReader(
  openclawRoot: string,
): BackfillSourceReader {
  const root = resolve(openclawRoot);
  let child: ChildProcess | undefined;
  let nextId = 0;
  let closed = false;
  let failed: Error | undefined;
  let closePromise: Promise<void> | undefined;
  let exited = false;
  let notifyExit: (() => void) | undefined;
  const exitPromise = new Promise<void>((resolveExit) => {
    notifyExit = resolveExit;
  });
  const pending = new Map<number, PendingRequest>();

  function fail(error: Error): void {
    failed ??= error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(failed);
    }
    pending.clear();
  }

  function start(): ChildProcess {
    if (child) return child;
    child = fork(new URL("./backfill-source-worker.js", import.meta.url), [], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: join(root, "openclaw.json"),
      },
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
    });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const reply = message as Record<string, unknown>;
      if (typeof reply.id !== "number") return;
      const request = pending.get(reply.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(reply.id);
      if (reply.ok === true) request.resolve(reply.value);
      else if (reply.ok === false && typeof reply.error === "string") {
        request.reject(new Error(reply.error));
      } else {
        request.reject(new Error("Invalid OpenClaw backfill worker response"));
      }
    });
    child.on("error", () => {
      fail(new Error("Unable to run OpenClaw backfill source worker"));
      child?.kill();
    });
    child.on("exit", () => {
      exited = true;
      notifyExit?.();
      fail(new Error("OpenClaw backfill source worker exited"));
    });
    child.on("disconnect", () => {
      fail(new Error("OpenClaw backfill source worker disconnected"));
    });
    return child;
  }

  function request<T>(
    operation: BackfillWorkerOperation,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (failed) return Promise.reject(failed);
    const worker = start();
    const id = ++nextId;
    return new Promise<T>((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        fail(new Error("OpenClaw backfill source worker request timed out"));
        worker.kill();
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject,
        timer,
      });
      worker.send({ id, ...operation }, (error: Error | null) => {
        if (error) {
          fail(new Error("Unable to send OpenClaw backfill source request"));
          worker.kill();
        }
      });
    });
  }

  function call<T>(operation: BackfillWorkerOperation): Promise<T> {
    if (closed)
      return Promise.reject(new Error("Backfill source reader is closed"));
    return request<T>(operation);
  }

  return {
    prepare: () => call({ operation: "prepare" }),
    discover: (agentId, includeRetained) =>
      call({ operation: "discover", agentId, includeRetained }),
    read: (source) => call({ operation: "read", source }),
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        if (!child || exited) return;
        if (!failed) {
          try {
            await request({ operation: "close" }, CLOSE_TIMEOUT_MS);
          } catch {
            // Close must still reap an unhealthy worker.
          }
        }
        if (exited) return;
        child.kill();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exitPromise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                child?.kill("SIGKILL");
                reject(
                  new Error("OpenClaw backfill source worker did not exit"),
                );
              }, CLOSE_TIMEOUT_MS);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      })();
      return closePromise;
    },
  };
}

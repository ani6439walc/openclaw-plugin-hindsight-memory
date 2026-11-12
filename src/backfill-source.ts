import { fork, type ChildProcess } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

export interface BackfillSnapshotReader extends BackfillSourceReader {
  selectStore(
    agentId: string,
    expectedPhysical: string,
  ): Promise<{ storePath: string }>;
}

type BackfillWorkerOperation =
  | { operation: "prepare" }
  | { operation: "select-store"; agentId: string; expectedPhysical: string }
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

export function createBackfillSnapshotReader(
  root: string,
  containerRoot: string,
): BackfillSnapshotReader {
  return createReader(root, true, containerRoot);
}

function privateScratchRoot(selectedRoot: string): string {
  let sourceRoot = selectedRoot;
  try {
    sourceRoot = realpathSync(selectedRoot);
  } catch {}
  for (const candidate of new Set([tmpdir(), "/tmp", "/var/tmp"])) {
    let base: string;
    try {
      base = realpathSync(candidate);
    } catch {
      continue;
    }
    const distance = relative(sourceRoot, base);
    if (!distance || (!distance.startsWith("..") && !isAbsolute(distance)))
      continue;
    try {
      return mkdtempSync(join(base, "hindsight-backfill-"));
    } catch {}
  }
  throw new Error(
    "Unable to create private backfill scratch outside selected state",
  );
}

/** CLI-only transport: host modules never load in the caller's process. */
export function createBackfillSourceReader(
  openclawRoot: string,
): BackfillSourceReader {
  return createReader(openclawRoot, false);
}

function createReader(
  openclawRoot: string,
  snapshotMode: boolean,
  containerRoot?: string,
): BackfillSnapshotReader {
  const root = resolve(openclawRoot);
  let child: ChildProcess | undefined;
  let scratchRoot: string | undefined;
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

  function killWorker(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!child) return;
    if (!snapshotMode && process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    } else child.kill(signal);
  }

  async function cleanup(): Promise<void> {
    if (!scratchRoot) return;
    // The detached group contains the outer reader, snapshot readers and host workers.
    // Reap the whole group before removing databases they may still be accessing.
    if (child?.pid && process.platform !== "win32") {
      const deadline = Date.now() + CLOSE_TIMEOUT_MS;
      while (true) {
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
          throw new Error("Unable to verify OpenClaw backfill worker cleanup");
        }
        killWorker("SIGKILL");
        if (Date.now() >= deadline)
          throw new Error("OpenClaw backfill descendants did not exit");
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
    }
    rmSync(scratchRoot, { recursive: true, force: true });
    scratchRoot = undefined;
  }

  function start(): ChildProcess {
    if (child) return child;
    if (!snapshotMode) scratchRoot = privateScratchRoot(root);
    const environment: NodeJS.ProcessEnv = snapshotMode
      ? {
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          TZ: process.env.TZ,
          HOME: root,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_DATA_HOME: join(root, "data"),
          TMPDIR: root,
        }
      : { ...process.env };
    child = fork(
      new URL("./backfill-source-worker.js", import.meta.url),
      snapshotMode ? ["--snapshot-reader"] : [],
      {
        env: {
          ...environment,
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_CONFIG_PATH: join(root, "openclaw.json"),
          ...(snapshotMode
            ? { HINDSIGHT_BACKFILL_CONTAINER_ROOT: containerRoot }
            : {}),
          ...(scratchRoot
            ? { HINDSIGHT_BACKFILL_SCRATCH_ROOT: scratchRoot }
            : {}),
        },
        detached: !snapshotMode && process.platform !== "win32",
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
      },
    );
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
      killWorker();
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
        killWorker();
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject,
        timer,
      });
      worker.send({ id, ...operation }, (error: Error | null) => {
        if (error) {
          fail(new Error("Unable to send OpenClaw backfill source request"));
          killWorker();
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
    selectStore: (agentId, expectedPhysical) =>
      call({ operation: "select-store", agentId, expectedPhysical }),
    discover: (agentId, includeRetained) =>
      call({ operation: "discover", agentId, includeRetained }),
    read: (source) => call({ operation: "read", source }),
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        if (!child || exited) {
          await cleanup();
          return;
        }
        if (!failed) {
          try {
            await request({ operation: "close" }, CLOSE_TIMEOUT_MS);
          } catch {
            // Close must still reap an unhealthy worker.
          }
        }
        if (exited) {
          await cleanup();
          return;
        }
        killWorker();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let shutdownError: unknown;
        try {
          await Promise.race([
            exitPromise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                killWorker("SIGKILL");
                reject(
                  new Error("OpenClaw backfill source worker did not exit"),
                );
              }, CLOSE_TIMEOUT_MS);
            }),
          ]);
        } catch (error) {
          shutdownError = error;
          // SIGKILL retirement is asynchronous. Keep ownership of private snapshots
          // until the leader exits and cleanup verifies that the whole group is gone.
          if (!exited) {
            await Promise.race([
              exitPromise,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        "OpenClaw backfill source worker did not exit after SIGKILL",
                      ),
                    ),
                  CLOSE_TIMEOUT_MS,
                );
              }),
            ]);
          }
        } finally {
          clearTimeout(timer);
        }
        await cleanup();
        if (shutdownError) throw shutdownError;
      })();
      return closePromise;
    },
  };
}

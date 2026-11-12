import { copyFile, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { constants } from "node:fs";
import { mirrorBackfillPath } from "./backfill-snapshot-config.js";
import type { BackfillUnavailable } from "./backfill-source.js";

export type BackfillSnapshot = {
  status: "available";
  root: string;
  storePath: string;
};

/** SQLite's backup API captures committed WAL pages without joining core's writable lifecycle. */
export function createBackfillSnapshots(scratchRoot: string) {
  const snapshots = new Map<
    string,
    Promise<BackfillSnapshot | BackfillUnavailable>
  >();
  const roots: string[] = [];
  const materialized = new Map<string, Promise<string>>();
  let closed = false;
  return {
    async get(
      sourcePath: string,
    ): Promise<BackfillSnapshot | BackfillUnavailable> {
      if (closed) throw new Error("Backfill snapshots are closed");
      let physical: string;
      try {
        physical = await realpath(sourcePath);
        if (!(await stat(physical)).isFile())
          return { status: "unavailable", reason: "unavailable" };
      } catch (error) {
        return {
          status: "unavailable",
          reason:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "missing-store"
              : "unavailable",
        };
      }
      let pending = snapshots.get(physical);
      if (!pending) {
        pending = (async () => {
          const root = await mkdtemp(join(scratchRoot, "store-"));
          roots.push(root);
          const storePath = join(root, "snapshot.sqlite");
          let database: DatabaseSync | undefined;
          try {
            database = new DatabaseSync(physical, { readOnly: true });
            await backup(database, storePath);
            return { status: "available" as const, root, storePath };
          } catch {
            await rm(root, { recursive: true, force: true });
            return { status: "unavailable" as const, reason: "unavailable" };
          } finally {
            database?.close();
          }
        })();
        snapshots.set(physical, pending);
      }
      return pending;
    },
    async materialize(
      snapshot: BackfillSnapshot,
      originalPhysicalPath: string,
    ): Promise<string> {
      if (closed) throw new Error("Backfill snapshots are closed");
      const destination = mirrorBackfillPath(
        snapshot.root,
        originalPhysicalPath,
      );
      let pending = materialized.get(destination);
      if (!pending) {
        pending = (async () => {
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          await copyFile(
            snapshot.storePath,
            destination,
            constants.COPYFILE_EXCL,
          );
          return destination;
        })();
        materialized.set(destination, pending);
      }
      return pending;
    },
    async close() {
      closed = true;
      await Promise.allSettled(snapshots.values());
      await Promise.allSettled(materialized.values());
      await Promise.all(
        roots.map((root) => rm(root, { recursive: true, force: true })),
      );
    },
  };
}

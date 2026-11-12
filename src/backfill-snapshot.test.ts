import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createBackfillSnapshots } from "./backfill-snapshot.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "hindsight-snapshot-test-"));
  roots.push(path);
  return path;
}

describe("generic read-only SQLite snapshots", () => {
  it("copies committed WAL data without modifying source logical bytes and shares a physical snapshot", async () => {
    const original = await root();
    const scratch = await root();
    const source = join(original, "custom.db");
    const db = new DatabaseSync(source);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('committed');",
    );
    const before = await Promise.all(
      [source, `${source}-wal`].map((path) => readFile(path)),
    );
    const snapshots = createBackfillSnapshots(scratch);
    const first = await snapshots.get(source);
    const alias = join(original, "alias.db");
    await symlink(source, alias);
    expect(await snapshots.get(alias)).toEqual(first);
    expect(first.status).toBe("available");
    if (first.status !== "available") throw Error("missing snapshot");
    const copied = new DatabaseSync(first.storePath, { readOnly: true });
    expect(copied.prepare("SELECT value FROM fixture").get()).toMatchObject({
      value: "committed",
    });
    copied.close();
    expect(
      await Promise.all(
        [source, `${source}-wal`].map((path) => readFile(path)),
      ),
    ).toEqual(before);
    expect((await stat(first.root)).mode & 0o777).toBe(0o700);
    db.close();
    await snapshots.close();
    expect(await readdir(scratch)).toEqual([]);
  });
  it("materializes distinct lexical aliases from one immutable capture without sharing working writes", async () => {
    const original = await root();
    const scratch = await root();
    const source = join(original, "source.sqlite");
    const alias = join(original, "alias.sqlite");
    const database = new DatabaseSync(source);
    database.exec(
      "CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('captured');",
    );
    database.close();
    await symlink(source, alias);
    const originalBytes = await readFile(source);
    const snapshots = createBackfillSnapshots(scratch);
    const capture = await snapshots.get(source);
    if (capture.status !== "available") throw Error("missing capture");
    expect(await snapshots.get(alias)).toBe(capture);
    const captureBytes = await readFile(capture.storePath);
    const first = await snapshots.materialize(capture, source);
    const writer = new DatabaseSync(first);
    writer.exec("UPDATE fixture SET value = 'working mutation'");
    writer.close();
    const second = await snapshots.materialize(capture, alias);
    expect(second).not.toBe(first);
    const untouched = new DatabaseSync(second, { readOnly: true });
    expect(untouched.prepare("SELECT value FROM fixture").get()).toMatchObject({
      value: "captured",
    });
    untouched.close();
    expect(await snapshots.materialize(capture, source)).toBe(first);
    const changed = new DatabaseSync(first, { readOnly: true });
    expect(changed.prepare("SELECT value FROM fixture").get()).toMatchObject({
      value: "working mutation",
    });
    changed.close();
    expect((await stat(first)).ino).not.toBe(
      (await stat(capture.storePath)).ino,
    );
    expect(await readFile(capture.storePath)).toEqual(captureBytes);
    expect(await readFile(source)).toEqual(originalBytes);
    await snapshots.close();
    expect(await readdir(scratch)).toEqual([]);
  });
  it("does not create a missing source and fails closed on a corrupt input", async () => {
    const original = await root();
    const scratch = await root();
    const snapshots = createBackfillSnapshots(scratch);
    expect(await snapshots.get(join(original, "missing.sqlite"))).toEqual({
      status: "unavailable",
      reason: "missing-store",
    });
    expect(await readdir(original)).toEqual([]);
    const corrupt = join(original, "corrupt.sqlite");
    await writeFile(corrupt, "not a SQLite database");
    expect(await snapshots.get(corrupt)).toEqual({
      status: "unavailable",
      reason: "unavailable",
    });
    expect(await readFile(corrupt, "utf8")).toBe("not a SQLite database");
    await snapshots.close();
  });
});

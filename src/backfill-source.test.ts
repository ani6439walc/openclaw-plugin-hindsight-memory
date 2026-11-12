import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fork } from "node:child_process";
import {
  createBackfillSourceReader,
  createBackfillSnapshotReader,
} from "./backfill-source.js";

vi.mock("node:child_process", () => ({ fork: vi.fn() }));

class SyntheticWorker extends EventEmitter {
  pid?: number;
  connected = true;
  exitCode: number | null = null;
  signalCode: string | null = null;
  operations: string[] = [];
  reply = true;

  send(
    request: { id: number; operation: string },
    callback?: (error: Error | null) => void,
  ) {
    this.operations.push(request.operation);
    callback?.(null);
    if (!this.reply) return true;
    queueMicrotask(() => {
      const value =
        request.operation === "prepare"
          ? { pluginConfig: {}, agentIds: ["main"] }
          : request.operation === "discover"
            ? { status: "available", sources: [] }
            : { status: "available", events: [] };
      this.emit("message", { id: request.id, ok: true, value });
      if (request.operation === "close") {
        this.connected = false;
        this.exitCode = 0;
        this.emit("exit", 0, null);
      }
    });
    return true;
  }

  kill() {
    this.connected = false;
    this.signalCode = "SIGTERM";
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("backfill source reader transport", () => {
  it("launches one child with selected root before imports and leaves parent env unchanged", async () => {
    const child = new SyntheticWorker();
    vi.mocked(fork).mockReturnValue(
      child as unknown as ReturnType<typeof fork>,
    );
    const before = { ...process.env };
    const reader = createBackfillSourceReader("/synthetic/selected-root");
    expect(fork).not.toHaveBeenCalled();

    expect(await reader.prepare()).toEqual({
      pluginConfig: {},
      agentIds: ["main"],
    });
    expect(await reader.discover("main", true)).toEqual({
      status: "available",
      sources: [],
    });
    await reader.close();
    await reader.close();

    expect(fork).toHaveBeenCalledOnce();
    const [modulePath, , options] = vi.mocked(fork).mock.calls[0];
    expect(String(modulePath)).toContain("backfill-source-worker.js");
    expect(options?.env).toMatchObject({
      OPENCLAW_STATE_DIR: "/synthetic/selected-root",
      OPENCLAW_CONFIG_PATH: "/synthetic/selected-root/openclaw.json",
    });
    expect(options?.execArgv).toEqual([]);
    expect(options?.stdio).toEqual(["ignore", "ignore", "ignore", "ipc"]);
    expect(child.operations).toEqual(["prepare", "discover", "close"]);
    expect(process.env).toEqual(before);
    await expect(reader.prepare()).rejects.toThrow(/closed/i);
  });

  it("keeps scratch outside a selected state root even when inherited TMPDIR points inside it", async () => {
    const child = new SyntheticWorker();
    vi.mocked(fork).mockReturnValue(
      child as unknown as ReturnType<typeof fork>,
    );
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = "/tmp";
    const reader = createBackfillSourceReader("/tmp");
    try {
      await reader.prepare();
      const scratch =
        vi.mocked(fork).mock.calls[0][2]?.env?.HINDSIGHT_BACKFILL_SCRATCH_ROOT;
      expect(scratch).toMatch(/^\/var\/tmp\/hindsight-backfill-/);
      await reader.close();
      expect(scratch && existsSync(scratch)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await reader.close();
    }
  });

  it("binds every snapshot selector before imports and excludes inherited source selectors", async () => {
    const child = new SyntheticWorker();
    vi.mocked(fork).mockReturnValue(
      child as unknown as ReturnType<typeof fork>,
    );
    const before = { ...process.env };
    process.env.OPENCLAW_AGENT_DIR = "/private/source-agent";
    process.env.OPENCLAW_PROFILE = "private-profile";
    const reader = createBackfillSnapshotReader("/synthetic/scratch");
    try {
      await reader.prepare();
      await reader.close();
      const [, args, options] = vi.mocked(fork).mock.calls[0];
      expect(args).toEqual(["--snapshot-reader"]);
      expect(options?.env).toMatchObject({
        HOME: "/synthetic/scratch",
        OPENCLAW_STATE_DIR: "/synthetic/scratch",
        OPENCLAW_CONFIG_PATH: "/synthetic/scratch/openclaw.json",
        XDG_CONFIG_HOME: "/synthetic/scratch/config",
        TMPDIR: "/synthetic/scratch",
      });
      expect(options?.env).not.toHaveProperty("OPENCLAW_AGENT_DIR");
      expect(options?.env).not.toHaveProperty("OPENCLAW_PROFILE");
      expect(options?.detached).toBe(false);
    } finally {
      for (const key of Object.keys(process.env))
        if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  it("reaps the outer process group before deleting its private snapshot directory", async () => {
    const child = new SyntheticWorker();
    child.pid = 9876543;
    vi.mocked(fork).mockReturnValue(
      child as unknown as ReturnType<typeof fork>,
    );
    let groupAlive = true;
    let scratch: string | undefined;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(-9876543);
      expect(scratch && existsSync(scratch)).toBe(true);
      if (signal === "SIGKILL") groupAlive = false;
      if (!groupAlive && signal === 0)
        throw Object.assign(Error("gone"), { code: "ESRCH" });
      return true;
    });
    const reader = createBackfillSourceReader("/synthetic/original");
    await reader.prepare();
    scratch =
      vi.mocked(fork).mock.calls[0][2]?.env?.HINDSIGHT_BACKFILL_SCRATCH_ROOT;
    expect(scratch && existsSync(scratch)).toBe(true);
    await reader.close();
    expect(kill).toHaveBeenCalledWith(-9876543, "SIGKILL");
    expect(scratch && existsSync(scratch)).toBe(false);
  });

  it("cleans private snapshots after an ignored SIGTERM and asynchronous SIGKILL exit/group retirement", async () => {
    vi.useFakeTimers();
    const child = new SyntheticWorker();
    child.pid = 9876543;
    vi.mocked(fork).mockReturnValue(
      child as unknown as ReturnType<typeof fork>,
    );
    let scratch: string | undefined;
    let groupAlive = true;
    let killScheduled = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(-9876543);
      if (signal === 0 && !groupAlive)
        throw Object.assign(Error("gone"), { code: "ESRCH" });
      expect(scratch && existsSync(scratch)).toBe(true);
      if (signal === "SIGKILL" && !killScheduled) {
        killScheduled = true;
        setTimeout(() => {
          child.connected = false;
          child.signalCode = "SIGKILL";
          child.emit("exit", null, "SIGKILL");
        }, 50);
        setTimeout(() => {
          groupAlive = false;
        }, 100);
      }
      return true;
    });
    const reader = createBackfillSourceReader("/synthetic/original");
    try {
      await reader.prepare();
      scratch =
        vi.mocked(fork).mock.calls[0][2]?.env?.HINDSIGHT_BACKFILL_SCRATCH_ROOT;
      if (!scratch) throw Error("missing private scratch directory");
      writeFileSync(
        join(scratch, "private-snapshot.sqlite"),
        "private transcript fixture",
      );
      child.send = (request, callback) => {
        callback?.(null);
        queueMicrotask(() =>
          child.emit("message", { id: request.id, ok: true }),
        );
        return true;
      };
      let finished = false;
      const closed = reader.close().then(
        () => undefined,
        (error) => error,
      );
      void closed.then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(5_001);
      expect(kill).toHaveBeenCalledWith(-9876543, "SIGTERM");
      expect(kill).toHaveBeenCalledWith(-9876543, "SIGKILL");
      expect(finished).toBe(false);
      expect(existsSync(scratch)).toBe(true);
      await vi.advanceTimersByTimeAsync(150);
      expect(await closed).toEqual(
        expect.objectContaining({
          message: "OpenClaw backfill source worker did not exit",
        }),
      );
      expect(child.signalCode).toBe("SIGKILL");
      expect(groupAlive).toBe(false);
      expect(existsSync(scratch)).toBe(false);
    } finally {
      // RED must not leave its deliberately stranded synthetic private artifact behind.
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reports a worker exit and never starts a replacement child", async () => {
    const child = new SyntheticWorker();
    child.reply = false;
    vi.mocked(fork).mockReturnValue(
      child as unknown as ReturnType<typeof fork>,
    );
    const reader = createBackfillSourceReader("/synthetic/root");
    const pending = reader.prepare();
    const rejected = expect(pending).rejects.toThrow(/worker.*exit/i);
    child.exitCode = 1;
    child.emit("exit", 1, null);

    await rejected;
    await expect(reader.prepare()).rejects.toThrow(/worker.*exit/i);
    await reader.close();
    expect(fork).toHaveBeenCalledOnce();
  });

  it("bounds requests and stops an unresponsive child", async () => {
    vi.useFakeTimers();
    const child = new SyntheticWorker();
    child.reply = false;
    const kill = vi.spyOn(child, "kill");
    vi.mocked(fork).mockReturnValue(
      child as unknown as ReturnType<typeof fork>,
    );
    const reader = createBackfillSourceReader("/synthetic/root");
    const rejected = expect(reader.prepare()).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(90_001);
    await rejected;
    expect(kill).toHaveBeenCalledOnce();
    await reader.close();
  });

  it("propagates a clear unsupported-host error", async () => {
    const child = new SyntheticWorker();
    child.send = (request) => {
      queueMicrotask(() =>
        child.emit("message", {
          id: request.id,
          ok: false,
          error:
            "Unsupported OpenClaw host: missing readSessionTranscriptSnapshotReadOnly",
        }),
      );
      return true;
    };
    vi.mocked(fork).mockReturnValue(
      child as unknown as ReturnType<typeof fork>,
    );
    const reader = createBackfillSourceReader("/synthetic/root");

    await expect(reader.prepare()).rejects.toThrow(
      /unsupported OpenClaw host.*readSessionTranscriptSnapshotReadOnly/i,
    );
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await reader.close();
  });
});

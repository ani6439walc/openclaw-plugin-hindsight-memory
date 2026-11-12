import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fork } from "node:child_process";
import { createBackfillSourceReader } from "./backfill-source.js";

vi.mock("node:child_process", () => ({ fork: vi.fn() }));

class SyntheticWorker extends EventEmitter {
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

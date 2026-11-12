import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildBackfillSnapshotConfig,
  mirrorBackfillPath,
} from "./backfill-snapshot-config.js";

const environment = {
  OPENCLAW_STATE_DIR: "/original/state",
  HOME: "/original/home",
};
const container = "/private/capture";
const mirror = (path: string) => `${container}/mirror/2f${path}`;
function resolver() {
  return vi.fn(
    (
      store: string | undefined,
      options: { agentId: string; env: NodeJS.ProcessEnv },
    ) => {
      if (!store)
        return `${options.env.OPENCLAW_STATE_DIR}/agents/${options.agentId}/sessions/sessions.json`;
      let expanded = store.replaceAll("{agentId}", options.agentId);
      if (expanded.startsWith("~/"))
        expanded = `${options.env.HOME}/${expanded.slice(2)}`;
      return resolve(options.env.OPENCLAW_STATE_DIR!, expanded);
    },
  );
}

describe("snapshot caller configuration", () => {
  it("mirrors every absolute path suffix without classifying canonical agent directories", () => {
    expect(
      mirrorBackfillPath(
        container,
        "/foreign/root/agents/b/sessions/sessions.json",
      ),
    ).toBe(mirror("/foreign/root/agents/b/sessions/sessions.json"));
    expect(mirrorBackfillPath(container, "/original/state")).toBe(
      mirror("/original/state"),
    );
    expect(() => mirrorBackfillPath(container, "relative/path")).toThrow(
      /absolute/i,
    );
    expect(() =>
      mirrorBackfillPath("relative/container", "/original/state"),
    ).toThrow(/absolute/i);
  });
  it("preserves absent roster and absent authored store instead of fabricating default ownership", () => {
    const resolveStorePath = resolver();
    expect(
      buildBackfillSnapshotConfig({}, environment, container, resolveStorePath),
    ).toEqual({ stateRoot: mirror("/original/state"), config: {} });
    expect(resolveStorePath).not.toHaveBeenCalled();
  });
  it.each([
    { agents: { ownership: "explicit", entries: {} } },
    { agents: { entries: { b: { default: true }, a: {} } } },
    { agents: { list: [{ id: "b", default: true }, { id: "a" }] } },
  ])(
    "retains empty and legacy roster facts without adding members ($agents)",
    (source) => {
      expect(
        buildBackfillSnapshotConfig(source, environment, container, resolver())
          .config,
      ).toEqual(source);
    },
  );
  it("preserves original roster order/default facts and surface owners while excluding private runtime configuration", () => {
    const config = {
      agents: {
        ownership: "explicit",
        entries: {
          b: { workspace: "private-workspace" },
          a: { default: false, token: "private-token" },
        },
        defaults: {
          systemAgent: { agentId: "a", private: "private-system" },
          sessionStore: { agentId: "b", private: "private-store" },
          model: "private-model",
        },
      },
      session: {
        store: "/foreign/agents/b/sessions/sessions.json",
        mainKey: "work",
        scope: "global",
        private: "private-session",
      },
      plugins: { private: "private-plugin" },
    };
    const result = buildBackfillSnapshotConfig(
      config,
      environment,
      container,
      resolver(),
    );
    expect(result.config).toEqual({
      agents: {
        ownership: "explicit",
        entries: { b: {}, a: { default: false } },
        defaults: {
          systemAgent: { agentId: "a" },
          sessionStore: { agentId: "b" },
        },
      },
      session: {
        store: mirror("/foreign/agents/b/sessions/sessions.json"),
        mainKey: "work",
        scope: "global",
      },
    });
    expect(
      Object.keys((result.config.agents as { entries: object }).entries),
    ).toEqual(["b", "a"]);
    expect(JSON.stringify(result.config)).not.toContain("private-");
  });
  it.each([
    "../archives/{agentId}/sessions/sessions.json",
    "~/copies/{agentId}/sessions/sessions.json",
  ])(
    "delegates template and path expansion to the public resolver (%s)",
    (store) => {
      const resolveStorePath = resolver();
      const result = buildBackfillSnapshotConfig(
        { agents: { entries: { b: {} } }, session: { store } },
        environment,
        container,
        resolveStorePath,
      );
      const [specifier, options] = resolveStorePath.mock.calls[0];
      expect(specifier).toBe(store);
      expect(options.env).toBe(environment);
      expect(options.agentId).not.toContain("{agentId}");
      const sourceResolved = resolveStorePath(store, {
        agentId: "b",
        env: environment,
      });
      const rebased = (result.config.session as { store: string }).store;
      expect(rebased).toContain("{agentId}");
      expect(rebased.replaceAll("{agentId}", "b")).toBe(mirror(sourceResolved));
    },
  );
  it("fails closed if the public resolver erases the template identity", () => {
    expect(() =>
      buildBackfillSnapshotConfig(
        { session: { store: "/source/{agentId}/sessions.json" } },
        environment,
        container,
        () => "/source/unrelated/sessions.json",
      ),
    ).toThrow(/template/i);
  });
  it("retains authored empty/whitespace store values without changing their fixed/per-agent classification", () => {
    const resolveStorePath = resolver();
    expect(
      buildBackfillSnapshotConfig(
        { session: { store: " " } },
        environment,
        container,
        resolveStorePath,
      ).config,
    ).toEqual({ session: { store: " " } });
    expect(resolveStorePath).not.toHaveBeenCalled();
  });
});

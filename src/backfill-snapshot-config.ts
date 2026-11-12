import { randomUUID } from "node:crypto";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export type SnapshotConfig = Record<string, unknown>;
export type ResolveBackfillStorePath = (
  store: string | undefined,
  options: { agentId: string; env: NodeJS.ProcessEnv },
) => unknown;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function insideBackfillContainer(
  container: string,
  pathname: string,
): boolean {
  const distance = relative(resolve(container), resolve(pathname));
  return (
    !isAbsolute(distance) &&
    distance !== ".." &&
    !distance.startsWith(`..${sep}`)
  );
}

/** Preserve every lexical suffix; core alone classifies agent-owned and shared stores. */
export function mirrorBackfillPath(
  container: string,
  pathname: string,
): string {
  if (!isAbsolute(container) || !isAbsolute(pathname))
    throw new Error("Backfill mirror requires absolute paths");
  const absolute = resolve(pathname);
  const root = parse(absolute).root;
  const mirrored = join(
    container,
    "mirror",
    Buffer.from(root).toString("hex"),
    relative(root, absolute),
  );
  if (!insideBackfillContainer(container, mirrored))
    throw new Error("Backfill mirror escaped its private container");
  return mirrored;
}

function rosterEntry(
  value: unknown,
  includeId = false,
): Record<string, unknown> {
  if (!object(value)) throw new Error("Invalid backfill source roster entry");
  return {
    ...(includeId && value.id !== undefined ? { id: value.id } : {}),
    ...(value.default !== undefined ? { default: value.default } : {}),
  };
}

/** Copy only ownership facts; authored store shape and path suffix remain host inputs. */
export function buildBackfillSnapshotConfig(
  source: SnapshotConfig,
  environment: NodeJS.ProcessEnv,
  container: string,
  resolveStorePath: ResolveBackfillStorePath,
): { stateRoot: string; config: SnapshotConfig } {
  if (
    !environment.OPENCLAW_STATE_DIR ||
    !isAbsolute(environment.OPENCLAW_STATE_DIR)
  )
    throw new Error("Backfill source state root must be absolute");
  const stateRoot = mirrorBackfillPath(
    container,
    environment.OPENCLAW_STATE_DIR,
  );
  const config: SnapshotConfig = {};
  if (object(source.agents)) {
    const original = source.agents;
    const agents: SnapshotConfig = {};
    if (original.ownership !== undefined) agents.ownership = original.ownership;
    if (object(original.entries))
      agents.entries = Object.fromEntries(
        Object.entries(original.entries).map(([id, entry]) => [
          id,
          rosterEntry(entry),
        ]),
      );
    if (Array.isArray(original.list))
      agents.list = original.list.map((entry) => rosterEntry(entry, true));
    if (object(original.defaults)) {
      const defaults: SnapshotConfig = {};
      for (const key of ["sessionStore", "systemAgent"]) {
        const owner = original.defaults[key];
        if (object(owner) && owner.agentId !== undefined)
          defaults[key] = { agentId: owner.agentId };
      }
      agents.defaults = defaults;
    }
    config.agents = agents;
  }
  if (object(source.session)) {
    const original = source.session;
    const session: SnapshotConfig = {};
    for (const key of ["mainKey", "scope"])
      if (original[key] !== undefined) session[key] = original[key];
    if (original.store !== undefined) {
      if (typeof original.store !== "string")
        throw new Error("Invalid backfill source store setting");
      if (!original.store.trim()) session.store = original.store;
      else {
        const template = original.store.includes("{agentId}");
        let sentinel: string;
        do {
          sentinel = `hindsight-${randomUUID()}`;
        } while (
          JSON.stringify([
            source.session,
            environment.OPENCLAW_STATE_DIR,
            environment.HOME,
            container,
          ]).includes(sentinel)
        );
        const expanded = resolveStorePath(original.store, {
          agentId: sentinel,
          env: environment,
        });
        if (typeof expanded !== "string" || !isAbsolute(expanded))
          throw new Error("Invalid public backfill store path");
        if (template && !expanded.includes(sentinel))
          throw new Error(
            "Public backfill store resolver erased template identity",
          );
        const rebased = mirrorBackfillPath(container, expanded);
        session.store = template
          ? rebased.replaceAll(sentinel, "{agentId}")
          : rebased;
      }
    }
    config.session = session;
  }
  return { stateRoot, config };
}

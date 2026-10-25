import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import type { PluginConfig } from "./types.js";
import {
  applyConfiguredBankDefaults,
  buildBankConfigApiUpdates,
  buildCreateBankDefaults,
  hasConfiguredBankDefaults,
  normalizeDispositionTrait,
  normalizeEntityLabels,
  normalizeRetainExtractionMode,
} from "./bank-defaults.js";

const clientOpts = { baseUrl: "http://localhost:8888", apiKey: "test-token" };

describe("hasConfiguredBankDefaults", () => {
  it("returns false when no bank default options are set", () => {
    expect(hasConfiguredBankDefaults({})).toBe(false);
    expect(hasConfiguredBankDefaults({ scope: {} })).toBe(false);
  });

  it("returns true when any bank default or mission is configured", () => {
    expect(hasConfiguredBankDefaults({ retainMission: "Extract facts." })).toBe(
      true,
    );
    expect(hasConfiguredBankDefaults({ retainExtractionMode: "verbose" })).toBe(
      true,
    );
    expect(hasConfiguredBankDefaults({ enableAutoConsolidation: false })).toBe(
      true,
    );
    expect(
      hasConfiguredBankDefaults({
        entityLabels: [{ name: "person", description: "A human" }],
      }),
    ).toBe(true);
  });
});

describe("buildCreateBankDefaults", () => {
  it("includes only explicitly set fields", () => {
    const config: PluginConfig = {
      retainExtractionMode: "verbose",
      enableObservations: true,
      dispositionSkepticism: 4,
      dispositionLiteralism: 2,
      dispositionEmpathy: 5,
    };
    expect(buildCreateBankDefaults(config)).toEqual({
      retainExtractionMode: "verbose",
      enableObservations: true,
      dispositionSkepticism: 4,
      dispositionLiteralism: 2,
      dispositionEmpathy: 5,
    });
  });

  it("still includes missions when configured", () => {
    const config: PluginConfig = {
      bankMission: "Reflect mission.",
      retainMission: "Retain mission.",
      observationsMission: "Observations mission.",
      retainExtractionMode: "verbose",
    };
    expect(buildCreateBankDefaults(config)).toEqual({
      reflectMission: "Reflect mission.",
      retainMission: "Retain mission.",
      observationsMission: "Observations mission.",
      retainExtractionMode: "verbose",
    });
  });
});

describe("buildBankConfigApiUpdates", () => {
  it("includes entityLabels and enableAutoConsolidation when set", () => {
    const labels = [
      { name: "person", description: "Human user" },
      { name: "project", description: "Software project" },
    ];
    const config: PluginConfig = {
      entityLabels: labels,
      enableAutoConsolidation: true,
    };
    expect(buildBankConfigApiUpdates(config)).toEqual({
      entity_labels: labels,
      enable_auto_consolidation: true,
    });
  });

  it("omits unset config-api fields", () => {
    expect(
      buildBankConfigApiUpdates({ retainExtractionMode: "verbose" }),
    ).toEqual({});
  });
});

describe("normalizers", () => {
  it("validates retain extraction mode", () => {
    expect(normalizeRetainExtractionMode("verbose")).toBe("verbose");
    expect(normalizeRetainExtractionMode("INVALID")).toBeUndefined();
  });

  it("validates disposition traits", () => {
    expect(normalizeDispositionTrait(3)).toBe(3);
    expect(normalizeDispositionTrait(0)).toBeUndefined();
    expect(normalizeDispositionTrait(6)).toBeUndefined();
    expect(normalizeDispositionTrait(2.5)).toBeUndefined();
  });

  it("passes through the server's entity label shapes", () => {
    const list = [{ name: "person", description: "Human" }];
    expect(normalizeEntityLabels(list)).toEqual(list);
    const wrapped = { attributes: list };
    expect(normalizeEntityLabels(wrapped)).toEqual(wrapped);
  });

  it("drops empty or malformed entity label shapes", () => {
    expect(normalizeEntityLabels([])).toBeUndefined();
    expect(normalizeEntityLabels({ attributes: [] })).toBeUndefined();
    // A plain keyed object is not the server's wrapper shape — it would be
    // silently ignored server-side, so it's dropped rather than sent.
    expect(
      normalizeEntityLabels({ person: { description: "Human" } }),
    ).toBeUndefined();
  });
});

describe("applyConfiguredBankDefaults", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is a no-op when no defaults are configured", async () => {
    const client = new HindsightClient(clientOpts);
    const createBank = vi.spyOn(client, "createBank");
    await applyConfiguredBankDefaults(client, "agent-slack-U123", {});
    expect(createBank).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { labels: ["person", "org"] },
    { labels: { attributes: [{ name: "person", description: "Human" }] } },
  ])(
    "preserves the configured labels shape through the SDK: %j",
    async ({ labels }) => {
      const client = new HindsightClient(clientOpts);
      const createBank = vi
        .spyOn(client, "createBank")
        .mockResolvedValue({} as never);
      await applyConfiguredBankDefaults(client, "bank /dynamic", {
        retainExtractionMode: "verbose",
        enableObservations: true,
        enableAutoConsolidation: false,
        entityLabels: labels,
        retainMission: "Keep architectural decisions.",
      });
      expect(createBank).toHaveBeenCalledWith("bank /dynamic", {
        retainMission: "Keep architectural decisions.",
        retainExtractionMode: "verbose",
        enableObservations: true,
      });
      const request = vi.mocked(global.fetch).mock.calls[0][0] as Request;
      expect(request.url).toBe(
        "http://localhost:8888/v1/default/banks/bank%20%2Fdynamic/config",
      );
      expect(request.method).toBe("PATCH");
      expect(request.headers.get("Authorization")).toBe("Bearer test-token");
      expect(await request.json()).toEqual({
        updates: {
          entity_labels: labels,
          enable_auto_consolidation: false,
        },
      });
    },
  );

  it("omits unset fields and credentials", async () => {
    const client = new HindsightClient({ baseUrl: clientOpts.baseUrl });
    await applyConfiguredBankDefaults(client, "bank", {
      enableAutoConsolidation: true,
    });
    const request = vi.mocked(global.fetch).mock.calls[0][0] as Request;
    expect(request.headers.has("Authorization")).toBe(false);
    expect(await request.json()).toEqual({
      updates: { enable_auto_consolidation: true },
    });
  });

  it("applies missions via createBank without config patch when only missions are set", async () => {
    const client = new HindsightClient(clientOpts);
    const createBank = vi
      .spyOn(client, "createBank")
      .mockResolvedValue({} as never);
    await applyConfiguredBankDefaults(client, "openclaw", {
      bankMission: "Reflect.",
      retainMission: "Retain.",
    });
    expect(createBank).toHaveBeenCalledWith("openclaw", {
      reflectMission: "Reflect.",
      retainMission: "Retain.",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("propagates SDK config update failures", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: "invalid labels" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      applyConfiguredBankDefaults(new HindsightClient(clientOpts), "bank", {
        entityLabels: ["x"],
      }),
    ).rejects.toThrow(/updateBankConfig failed/);
  });
});

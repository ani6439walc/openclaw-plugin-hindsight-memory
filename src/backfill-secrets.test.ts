import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSecretsConfigFromOpenClawRoot,
  mergeOpenClawRootDotEnv,
  parseDotEnvContent,
  parseSecretRef,
  resolveEnvSecretRefFromConfig,
} from "./backfill-secrets.js";

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "hindsight-backfill-secrets-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("backfill SecretRef and .env helpers", () => {
  it("parses .env files with comments, export prefixes, and quoted values", () => {
    const parsed = parseDotEnvContent(
      [
        "# full-line comment",
        "",
        "PLAIN_TOKEN=abc123",
        "export EXPORTED_TOKEN=def456 # trailing comment",
        "HASH_INSIDE=tok#789",
        'DOUBLE_QUOTED="hello \\"world\\"\\nline2" # ignored',
        "SINGLE_QUOTED='literal # value \\n'",
        "BACKTICK_QUOTED=`bt # value`",
        "EMPTY_VAL=",
        "123INVALID=ignored",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      PLAIN_TOKEN: "abc123",
      EXPORTED_TOKEN: "def456",
      HASH_INSIDE: "tok#789",
      DOUBLE_QUOTED: 'hello "world"\nline2',
      SINGLE_QUOTED: "literal # value \\n",
      BACKTICK_QUOTED: "bt # value",
      EMPTY_VAL: "",
    });
  });

  it("merges <openclawRoot>/.env without overriding caller env or mutating input", () => {
    const root = makeTempRoot();
    writeFileSync(
      join(root, ".env"),
      "HINDSIGHT_API_TOKEN=from-dotenv\nOVERRIDE_ME=from-dotenv\n",
      "utf8",
    );
    const inputEnv: NodeJS.ProcessEnv = { OVERRIDE_ME: "from-process-env" };

    const merged = mergeOpenClawRootDotEnv(root, inputEnv);
    expect(merged.HINDSIGHT_API_TOKEN).toBe("from-dotenv");
    expect(merged.OVERRIDE_ME).toBe("from-process-env");
    expect(inputEnv).toEqual({ OVERRIDE_ME: "from-process-env" });
  });

  it("parses valid SecretRefs and rejects malformed shapes", () => {
    expect(
      parseSecretRef({
        source: "env",
        provider: "default",
        id: "HINDSIGHT_API_TOKEN",
      }),
    ).toEqual({
      source: "env",
      provider: "default",
      id: "HINDSIGHT_API_TOKEN",
    });
    expect(parseSecretRef({ source: "env", id: "LEGACY_TOKEN" })).toEqual({
      source: "env",
      id: "LEGACY_TOKEN",
    });
    expect(parseSecretRef({ source: "env" })).toBeNull();
    expect(parseSecretRef({ source: "unknown", id: "FOO" })).toBeNull();
    expect(parseSecretRef("plaintext")).toBeNull();
  });

  it("resolves env SecretRefs and respects provider defaults and allowlists", () => {
    const ref = {
      source: "env",
      provider: "default",
      id: "HINDSIGHT_API_TOKEN",
    };

    expect(
      resolveEnvSecretRefFromConfig(ref, undefined, {
        HINDSIGHT_API_TOKEN: "  secret-tok  ",
      }),
    ).toEqual({ status: "resolved", value: "secret-tok" });

    expect(resolveEnvSecretRefFromConfig(ref, undefined, {})).toMatchObject({
      status: "unresolved",
      reason: expect.stringContaining("HINDSIGHT_API_TOKEN"),
    });

    const secretsConfig = {
      defaults: { env: "restricted" },
      providers: {
        restricted: { source: "env", allowlist: ["ALLOWED_TOKEN"] },
      },
    };
    expect(
      resolveEnvSecretRefFromConfig(
        { source: "env", id: "ALLOWED_TOKEN" },
        secretsConfig,
        { ALLOWED_TOKEN: "ok-tok" },
      ),
    ).toEqual({ status: "resolved", value: "ok-tok" });

    expect(
      resolveEnvSecretRefFromConfig(
        { source: "env", id: "BLOCKED_TOKEN" },
        secretsConfig,
        { BLOCKED_TOKEN: "nope" },
      ),
    ).toMatchObject({
      status: "unresolved",
      reason: expect.stringContaining("not allowlisted"),
    });

    expect(
      resolveEnvSecretRefFromConfig(
        { source: "file", provider: "local", id: "/hindsight/token" },
        undefined,
        {},
      ),
    ).toMatchObject({
      status: "unsupported-offline",
    });

    expect(
      resolveEnvSecretRefFromConfig({ unexpected: true }, undefined, {}),
    ).toMatchObject({
      status: "invalid",
    });
  });

  it("loads secrets config from <openclawRoot>/openclaw.json and fails closed on invalid JSON", () => {
    const emptyRoot = makeTempRoot();
    expect(loadSecretsConfigFromOpenClawRoot(emptyRoot)).toBeUndefined();
    expect(loadSecretsConfigFromOpenClawRoot(undefined)).toBeUndefined();

    const validRoot = makeTempRoot();
    writeFileSync(
      join(validRoot, "openclaw.json"),
      JSON.stringify({
        secrets: {
          defaults: { env: "restricted" },
          providers: {
            restricted: { source: "env", allowlist: ["ALLOWED_TOKEN"] },
          },
        },
      }),
      "utf8",
    );
    expect(loadSecretsConfigFromOpenClawRoot(validRoot)).toEqual({
      defaults: { env: "restricted" },
      providers: {
        restricted: { source: "env", allowlist: ["ALLOWED_TOKEN"] },
      },
    });

    const corruptRoot = makeTempRoot();
    writeFileSync(join(corruptRoot, "openclaw.json"), "{invalid json", "utf8");
    expect(() => loadSecretsConfigFromOpenClawRoot(corruptRoot)).toThrow();
  });
});

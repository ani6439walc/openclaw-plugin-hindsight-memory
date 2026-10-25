# Hindsight Memory Plugin for OpenClaw

Biomimetic long-term memory for [OpenClaw](https://openclaw.ai) using [Hindsight](https://vectorize.io/hindsight). Automatically captures conversations and intelligently recalls relevant context.

## This fork

This repository contains only the OpenClaw integration from Vectorize's Hindsight
monorepo, with automatic recall progress events for
[discord-activity](https://github.com/ani6439walc/openclaw-plugin-discord-activity).
The Hindsight engine and SDK dependencies remain upstream packages. See
[UPSTREAM.md](UPSTREAM.md) for the exact source revision and update procedure.
Original code is copyright Vectorize AI, Inc., licensed under [MIT](LICENSE).

The package name is `hindsight-memory`; the OpenClaw plugin ID is
`hindsight-memory`. Use this fork **in place of** the official integration, not
alongside it. This README does not assume the fork is published to npm.

## Quick Start

Requires OpenClaw `2026.10.4`, Node.js `>=24.16.0 <25 || >=26.1.0`,
and `pnpm@12.8.1` (matching `package.json`).

Build and check the package:

```bash
git clone https://github.com/ani6439walc/openclaw-plugin-hindsight-memory.git
cd openclaw-plugin-hindsight-memory
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
npm pack --pack-destination /tmp
```

Installing or replacing the plugin is a separate operator action. Save your
OpenClaw configuration first, then install the archive produced above (adjust the
version after updates):

```bash
openclaw plugins install npm-pack:/tmp/hindsight-memory-2026.10.4.tgz --force

# Optional: configure a new installation using this checkout's setup wizard.
node dist/setup.js

openclaw plugins inspect hindsight-memory --runtime --json
```

`--force` replaces an existing installation of the same plugin. Existing
installations do not need to rerun the setup wizard. Verify
`plugins.entries.hindsight-memory.config` and the hook permissions below before
using the plugin. The `npm-pack:` install path exercises OpenClaw's managed
runtime dependency installation, as recommended by the
[official plugin guide](https://docs.openclaw.ai/plugins/building-plugins).

For an existing checkout, `pnpm build` only rebuilds `dist/`. After deliberately
installing/replacing the package or updating the loaded checkout, reload its code
with `openclaw plugins reload hindsight-memory`. Building and testing alone do
not reload plugin code or restart the Gateway. With the default hybrid reload
mode, plugin configuration and hook-policy changes replace the plugin runtime
automatically.

Recall progress uses the `plugin:hindsight-memory` agent event stream through
`emitAgentEvent` from `openclaw/plugin-sdk/agent-harness-runtime`. A compatible
discord-activity version can display the recall status, elapsed time, and result
count. Events do not include the query or recalled memory content; a reporting
failure must not prevent recall.

`node dist/setup.js` walks you through picking one of three modes:

- **Cloud** — managed Hindsight. Paste your cloud API token, done.
- **External API** — your own running Hindsight deployment. Prompts for the URL and optional token.
- **Embedded daemon** — spawns a local `hindsight-embed` daemon on this machine. Prompts for the LLM provider (OpenAI / Anthropic / Gemini / Groq / Claude Code / Codex / Ollama) and its API key.

The interactive wizard stores credentials **inline** in `openclaw.json` for simplicity — the value is masked as you paste it. For CI / production you can store credentials as a `SecretRef` (resolved from an env var, file, or exec source at startup) by using the non-interactive flags with `--token-env` / `--api-key-env`, or by switching an existing field afterwards with `openclaw config set ... --ref-source env --ref-id …`.

The plugin ID is `hindsight-memory`; migrate the previous entry, allow/deny references,
and memory slot from `hindsight` when upgrading. The npm package and CLI
commands keep their existing names, and recall progress emits to the `plugin:hindsight-memory`
event stream.

### Recall progress event contract

Events use stream `plugin:hindsight-memory` and the host's `runId` and
`sessionKey` envelope fields. Emission requires a hook context `runId`. The host
SDK emitter works inside agent-scoped prompt hooks, where the registration API
method `api.agent.events.emitAgentEvent` can return `global side effects disabled`.
Expired hook invocations do not emit events.

The `data` payload contains:

| Field         | Meaning                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `kind`        | Always `hindsight-memory.recall`.                                                                                |
| `pluginId`    | Plugin ID (`hindsight-memory`).                                                                                  |
| `recallId`    | A unique ID for each hook invocation that starts recall.                                                         |
| `sessionKey`  | Session routing key, when available.                                                                             |
| `state`       | `started`, followed by at most one terminal state: `completed`, `failed`, `cancelled`, or `skipped`.             |
| `durationMs`  | Terminal events only: elapsed milliseconds since `started`, including client initialization and readiness waits. |
| `resultCount` | Completed events only: number of retrieved results, including zero.                                              |
| `reason`      | Failure: `timeout` or `error`; cancellation: `service_stopped`; skipped after starting: `client_unavailable`.    |

Provider/session filters, disabled automatic recall, and other prechecks that
return before recall starts emit no events. Correlate events by `recallId` and
reject stale run/session events; do not infer recall success from silence.

### Manual configuration (without the wizard)

The wizard is a convenience wrapper — all of the same fields can be set directly with `openclaw config set`:

```bash
# Embedded daemon with OpenAI
openclaw config set plugins.entries.hindsight-memory.config.llmProvider openai
openclaw config set plugins.entries.hindsight-memory.config.llmApiKey \
    --ref-source env --ref-provider default --ref-id OPENAI_API_KEY

# Or: Claude Code (no API key needed)
openclaw config set plugins.entries.hindsight-memory.config.llmProvider claude-code

# Or: point at an external Hindsight API
openclaw config set plugins.entries.hindsight-memory.config.hindsightApiUrl https://mcp.hindsight.example.com
openclaw config set plugins.entries.hindsight-memory.config.hindsightApiToken \
    --ref-source env --ref-id HINDSIGHT_API_TOKEN
```

## Migrating from 0.5.x

0.6.0 removes all process-environment reads from the plugin. Configuration that
previously came from shell env vars must now go through OpenClaw's plugin config
(with SecretRef for credentials). Concrete mappings:

| Old (0.5.x)                              | New (0.6.0)                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENAI_API_KEY=…` (auto-detected)       | `openclaw config set plugins.entries.hindsight-memory.config.llmProvider openai` <br> `openclaw config set plugins.entries.hindsight-memory.config.llmApiKey --ref-source env --ref-id OPENAI_API_KEY` |
| `HINDSIGHT_API_LLM_PROVIDER=…`           | `openclaw config set plugins.entries.hindsight-memory.config.llmProvider …`                                                                                                                            |
| `HINDSIGHT_API_LLM_MODEL=…`              | `openclaw config set plugins.entries.hindsight-memory.config.llmModel …`                                                                                                                               |
| `HINDSIGHT_API_LLM_API_KEY=…`            | `openclaw config set plugins.entries.hindsight-memory.config.llmApiKey --ref-source env --ref-id …`                                                                                                    |
| `HINDSIGHT_API_LLM_BASE_URL=…`           | `openclaw config set plugins.entries.hindsight-memory.config.llmBaseUrl …`                                                                                                                             |
| `HINDSIGHT_EMBED_API_URL=…`              | `openclaw config set plugins.entries.hindsight-memory.config.hindsightApiUrl …`                                                                                                                        |
| `HINDSIGHT_EMBED_API_TOKEN=…`            | `openclaw config set plugins.entries.hindsight-memory.config.hindsightApiToken --ref-source env --ref-id …`                                                                                            |
| `HINDSIGHT_BANK_ID=…`                    | `openclaw config set plugins.entries.hindsight-memory.config.bankId …`                                                                                                                                 |
| `llmApiKeyEnv: "MY_KEY"` (plugin config) | `llmApiKey` configured as a SecretRef with `--ref-id MY_KEY`                                                                                                                                           |

If your shell already exports `OPENAI_API_KEY`, the SecretRef config above resolves
to the same value at startup — no need to change your shell setup, just point the
plugin at the variable explicitly. Run `openclaw config validate` after migrating
to confirm the new shape parses cleanly.

## Features

- **Auto-capture** and **auto-recall** of memories each turn, injected into model context so recalled memories stay out of the visible chat transcript
- **Memory isolation** — configurable per agent, channel, user, or provider via `dynamicBankGranularity`
- **Historical backfill CLI** — import prior OpenClaw session history into Hindsight using the active plugin bank-routing config by default
- **Retention controls** — choose which message roles to retain, toggle auto-retain on/off, and stamp retained documents with consistent tags/source metadata

## Configuration

Optional settings in `~/.openclaw/openclaw.json` under `plugins.entries.hindsight-memory.config`:

| Option                     | Default                        | Description                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiPort`                  | `9077`                         | Port for the local Hindsight daemon                                                                                                                                                                                                                                                                              |
| `embedPort`                | `0`                            | Port for `hindsight-embed` server (`0` = auto-assign)                                                                                                                                                                                                                                                            |
| `embedVersion`             | `"latest"`                     | hindsight-embed version                                                                                                                                                                                                                                                                                          |
| `embedPackagePath`         | —                              | Local path to `hindsight-embed` package for development                                                                                                                                                                                                                                                          |
| `bankMission`              | —                              | Mission stamped onto the bank's `reflect_mission` column on first use. **Only affects the `reflect` operation** — does not steer retain or recall. Leave unset (or empty) to manage missions out-of-band via `PATCH /banks/{id}`.                                                                                |
| `retainMission`            | —                              | Mission stamped onto the bank's `retain_mission` column on first use. Steers what gets extracted as facts during retain. Leave unset to use built-in extraction rules.                                                                                                                                           |
| `observationsMission`      | —                              | Mission stamped onto the bank's `observations_mission` column on first use. Controls what gets synthesised into observations during consolidation.                                                                                                                                                               |
| `retainExtractionMode`     | —                              | Fact extraction mode stamped on each bank's first use: `concise`, `verbose`, `custom`, `verbatim`, or `chunks`. Use with dynamic banks so per-user banks match your analytics/base bank settings.                                                                                                                |
| `enableObservations`       | —                              | When set, stamped on first bank use to toggle observation consolidation after retain.                                                                                                                                                                                                                            |
| `enableAutoConsolidation`  | —                              | When set, stamped on first bank use (via bank config API) to toggle automatic consolidation scheduling.                                                                                                                                                                                                          |
| `dispositionSkepticism`    | —                              | Reflect skepticism trait (`1`–`5`) stamped on first bank use.                                                                                                                                                                                                                                                    |
| `dispositionLiteralism`    | —                              | Reflect literalism trait (`1`–`5`) stamped on first bank use.                                                                                                                                                                                                                                                    |
| `dispositionEmpathy`       | —                              | Reflect empathy trait (`1`–`5`) stamped on first bank use.                                                                                                                                                                                                                                                       |
| `entityLabels`             | —                              | Controlled vocabulary for entity labels. Either a list of attribute defs (see example below) or a `{ "attributes": [...] }` object — other shapes are ignored. Passed through to `PATCH /banks/{id}/config` as `entity_labels` on first bank use.                                                                |
| `llmProvider`              | —                              | LLM provider for memory extraction (`openai`, `anthropic`, `gemini`, `groq`, `ollama`, `openai-codex`, `claude-code`). Required unless `hindsightApiUrl` is set.                                                                                                                                                 |
| `llmModel`                 | provider default               | LLM model used with `llmProvider`                                                                                                                                                                                                                                                                                |
| `llmApiKey`                | —                              | API key for the LLM provider. **Sensitive** — set via `openclaw config set ... --ref-source env --ref-id OPENAI_API_KEY` to reference an env var (or `--ref-source file`/`exec` for mounted-secret/Vault sources).                                                                                               |
| `llmBaseUrl`               | —                              | Optional base URL override for OpenAI-compatible providers (e.g. `https://openrouter.ai/api/v1`)                                                                                                                                                                                                                 |
| `dynamicBankId`            | `true`                         | Enable per-context memory banks                                                                                                                                                                                                                                                                                  |
| `bankId`                   | —                              | Static bank ID used when `dynamicBankId` is `false`.                                                                                                                                                                                                                                                             |
| `bankIdPrefix`             | —                              | Prefix for bank IDs (e.g. `"prod"`)                                                                                                                                                                                                                                                                              |
| `agentBankMap`             | —                              | Explicit `agentId` → `bankId` routing, checked before static/dynamic derivation. Lets a group of agents share one named bank while others keep derived banks (e.g. `{"inbound": "ps-technology", "limpieza": "ps-limpieza"}`). Mapped names are used exactly as given — `bankIdPrefix` is not applied.           |
| `retainTags`               | `[]`                           | Tags applied to every retained document, useful for cross-agent/source labeling (e.g. `source_system:openclaw`, `agent:agentname`). Auto-retain also merges inline per-message tags from `<retain_tags>...</retain_tags>` or `<hindsight_retain_tags>...</hindsight_retain_tags>` blocks in user messages.       |
| `retainSource`             | `"openclaw"`                   | `source` value written into retained document metadata                                                                                                                                                                                                                                                           |
| `retainContext`            | built-in OpenClaw guidance     | Interpretation guidance sent through the Hindsight retain API `context` field. The default tells the extraction LLM that sender/channel/provider metadata, bank IDs, session keys, source systems, and tags are operational routing metadata, not human names, project names, or organizations.                  |
| `senderPrefixPattern`      | —                              | Regex matching a human display-name prefix some channels prepend to user text (e.g. `Alice: today weather?`). Give the name part only (`Alice\|Bob`, `[A-Za-z ]{1,20}`) — the `:` and anchoring are added. Strips it from recall queries and retained transcripts. Unset strips nothing; invalid regex ignored.  |
| `dynamicBankGranularity`   | `["agent", "channel", "user"]` | Fields used to derive bank ID. Options: `agent`, `channel`, `user`, `provider`                                                                                                                                                                                                                                   |
| `scope.skipRecallSessions` | `[]`                           | Session-key globs that skip automatic recall. `["**"]` disables it globally; explicit tools are unaffected.                                                                                                                                                                                                      |
| `scope.skipRetainSessions` | `[]`                           | Session-key globs that skip automatic retention, including session-end tail retention. `["**"]` disables it globally; explicit tools are unaffected.                                                                                                                                                             |
| `retainRoles`              | `["user", "assistant"]`        | Which message roles to retain. Options: `user`, `assistant`, `system`, `tool`                                                                                                                                                                                                                                    |
| `retainFormat`             | `"json"`                       | Serialization format for retained conversation content. `"json"` emits a structured array of `{role, content}` messages (matches Claude Code). `"text"` emits legacy `[role: x] … [x:end]` markers.                                                                                                              |
| `retainToolCalls`          | `true`                         | With `retainFormat: "json"`, each message's content is an Anthropic-shaped block array (`text` / `tool_use` / `tool_result`). Tool results are truncated at 2000 chars. Hindsight's own MCP tools (recall/retain/search/…) are filtered to prevent feedback loops. Set `false` to retain text-only content.      |
| `retainEveryNTurns`        | `1`                            | Retain every Nth turn. `1` = every turn (default). Values > 1 enable chunked retention with a sliding window.                                                                                                                                                                                                    |
| `retainOverlapTurns`       | `0`                            | Extra prior turns included when chunked retention fires. Window = `retainEveryNTurns + retainOverlapTurns`. Only applies when `retainEveryNTurns > 1`.                                                                                                                                                           |
| `recallBudget`             | `"mid"`                        | Recall effort: `low`, `mid`, or `high`. Higher budgets use more retrieval strategies.                                                                                                                                                                                                                            |
| `recallMaxTokens`          | `1024`                         | Max tokens for recall response. Controls how much memory context is injected per turn.                                                                                                                                                                                                                           |
| `recallTimeoutMs`          | `10000`                        | Deadline for the auto-recall request, in ms. Values below `1000` are ignored. At the deadline the HTTP request itself is aborted, not just abandoned, so a slow recall stops consuming a connection.                                                                                                             |
| `recallTypes`              | `["observation"]`              | Memory types to recall. Options: `world`, `experience`, `observation`. Defaults to observations — the consolidated, deduplicated view — to avoid surfacing the same answer multiple times when many raw memories say the same thing.                                                                             |
| `preferObservations`       | `false`                        | When `true`, recall drops raw facts already consolidated into an observation while keeping unconsolidated ones. Pair with a `recallTypes` that includes raw types (e.g. `["observation", "world", "experience"]`) to surface just-retained facts before consolidation, without duplicating consolidated content. |
| `recallMinScores`          | `{}`                           | Optional score floors for auto-recall, keyed by stage (for example `{"reranker": 0.3}`). Missing fields impose no floor; memories with missing or `null` scores pass. Reranker scores are query-local, so use this as a garbage gate rather than a calibrated relevance dial.                                    |
| `recallRoles`              | `["user", "assistant"]`        | Roles included when building prior context for recall query composition. Options: `user`, `assistant`, `system`, `tool`.                                                                                                                                                                                         |
| `recallTopK`               | —                              | Max number of memories to inject per turn. Applied after API response as a hard cap.                                                                                                                                                                                                                             |
| `recallContextTurns`       | `1`                            | Number of user turns to include when composing recall query context. `1` keeps latest-message-only behavior.                                                                                                                                                                                                     |
| `recallMaxQueryChars`      | `800`                          | Maximum character length for the composed recall query before calling recall.                                                                                                                                                                                                                                    |
| `recallPromptPreamble`     | built-in string                | Prompt text placed above recalled memories in the injected `<hindsight_memory_plugin>` context block.                                                                                                                                                                                                            |
| `recallInjectionPosition`  | `"user"`                       | Where to inject recalled memories: `user` places them before the user message and preserves the system prompt cache; `prepend` and `append` place them at the start or end of the system prompt.                                                                                                                 |
| `hindsightApiUrl`          | —                              | External Hindsight API URL (skips local daemon)                                                                                                                                                                                                                                                                  |
| `hindsightApiToken`        | —                              | Auth token for external API. **Sensitive** — set via `openclaw config set ... --ref-source env --ref-id HINDSIGHT_API_TOKEN`.                                                                                                                                                                                    |
| `debugPerfTiming`          | `false`                        | Emit one info-level perf line per `before_prompt_build` (recall path) and `agent_end` (retain path) so you can spot whether latency is in the plugin or upstream. Off by default. Format: `perf: <hook> hook_total=Xms <hook-specific fields>`. Safe in production — uses the existing logger.                   |

### Per-agent bank mapping

`dynamicBankId` is all-or-nothing: either every agent shares one bank, or every agent gets its own derived one. `agentBankMap` adds the middle ground — name the bank for specific agents and leave the rest alone:

```json
{
  "dynamicBankId": true,
  "dynamicBankGranularity": ["agent", "channel", "user"],
  "agentBankMap": {
    "inbound": "ps-technology",
    "outbound": "ps-technology",
    "limpieza": "ps-limpieza"
  }
}
```

`inbound` and `outbound` share `ps-technology`, `limpieza` gets `ps-limpieza`, and every other agent keeps the per-agent/channel/user bank it had before. The map is consulted first, so it also overrides a static `bankId` — one gateway can pin most traffic to a shared bank while carving out named banks for a few agents.

Details worth knowing:

- **Mapped names are used verbatim.** `bankIdPrefix` is not applied, because you named the bank yourself.
- **Retain, recall and the knowledge tools all follow the map** — they resolve the bank through the same path.
- **Bank defaults still apply.** A mapped bank is stamped with the configured missions, extraction mode, entity labels and so on when it is first used, exactly like a derived bank.
- **Agent ids match exactly** — the lookup is case-sensitive and not fuzzy, so `Inbound` is not `inbound`. Keys are trimmed, values too.
- **Mapped agents are exempt from the sender/surface skips.** A session whose sender cannot be resolved, or whose dispatch surface differs from the session's provider, is normally skipped rather than routed into a bank keyed by the wrong thing. A mapped agent's bank depends on neither, so those sessions are retained as intended. Cron, heartbeat and subagent sessions are eligible unless excluded by `scope`; `temp:` sessions and internal coordination messages remain excluded.
- **Entries with a blank or non-string bank are ignored** (and logged), rather than routing an agent to a bank named `""`.

### Per-user dynamic bank defaults

When `dynamicBankId` is enabled (default), OpenClaw derives a separate Hindsight bank per context (e.g. per Slack user). New banks otherwise inherit only Hindsight server defaults (`concise` extraction, no entity labels, etc.). Set the options below in plugin config to stamp **full bank defaults on first use** — before the first retain or recall touches that bank:

```json
{
  "dynamicBankId": true,
  "dynamicBankGranularity": ["agent", "channel", "user"],
  "retainExtractionMode": "verbose",
  "enableObservations": true,
  "enableAutoConsolidation": true,
  "dispositionSkepticism": 3,
  "dispositionLiteralism": 3,
  "dispositionEmpathy": 4,
  "entityLabels": [
    { "name": "person", "description": "A human user or contact" },
    { "name": "project", "description": "A software project or product" }
  ],
  "retainMission": "Extract durable preferences, decisions, and project context.",
  "observationsMission": "Synthesise stable user preferences and active projects.",
  "bankMission": "You are a helpful assistant with long-term memory across channels."
}
```

Unset options are not sent — existing behaviour is unchanged when you only configure missions (as before). Each bank is configured at most once per gateway process.

### Manual Knowledge Tools

The plugin always registers explicit knowledge & memory tools when the host supports tool registration (`memory_recall`, `memory_reflect`, `memory_store`, `knowledge_page`). The automatic-memory `scope` does not restrict these tools or change their bank routing. Use `knowledge_page` to manage consolidated knowledge pages/mental models (`action: "list" | "get" | "create" | "update" | "delete"`). Use `memory_recall` for ordinary memory lookup. Use `memory_reflect` only for deliberate synthesis, retrospectives, or long-term preference/pattern questions; it retrieves memories and then calls the configured Reflect LLM to generate an answer. Use `memory_store` to upload documents or raw knowledge directly into the memory bank.

Knowledge tools resolve the same dynamic memory bank as auto-recall and auto-retain: the plugin runs the shared identity-resolution path (`resolveAndCacheIdentity`) from the tool session context before deriving the bank ID. With user-scoped dynamic banking (`dynamicBankGranularity` includes `"user"`), tools target the per-user bank for that session; if sender identity cannot be resolved, tool execution returns a clear error instead of querying the shared `openclaw` default or an `anonymous` fallback bank. Configured bank defaults (missions, extraction mode, entity labels, etc.) are applied on first knowledge-tool use, matching `getClientForContext` behavior.

`memory_reflect` uses conservative defaults: `budget: "low"`, `max_tokens: 1024`, and `fact_types: ["world", "experience", "observation"]`. Production deployments should also set a finite bank-level `reflect_source_facts_max_tokens` value, such as `4096` or `8192`, rather than leaving reflection source facts unlimited.

### Automatic memory scope

Automatic recall and retention are enabled by default for all session types, including cron, subagent and heartbeat. Use `scope.skipRecallSessions` and `scope.skipRetainSessions` to exclude sessions independently. No providers or session types are added to either list automatically. Internal coordination messages, ephemeral `temp:` sessions and invalid bank identities are still filtered.

Both options accept glob patterns matched against the entire session key, such as `agent:<agentId>:cron:<jobId>:run:<sessionId>`. Session keys describe the session namespace; they do not necessarily contain the actual message provider.

Glob syntax:

- `*` — matches any characters except `:` (single segment)
- `**` — matches anything including `:` (multiple segments)
- A session is skipped when any pattern matches. There is no negation or allow-override syntax.

| Pattern               | Matches                                              |
| --------------------- | ---------------------------------------------------- |
| `agent:*:cron:**`     | All cron sessions for any agent                      |
| `agent:*:subagent:**` | All subagent sessions for any agent                  |
| `agent:main:**`       | All sessions under the `main` agent                  |
| `**`                  | All sessions, including events without a session key |

Omitting `scope`, using `{}`, or omitting either list leaves that action without scope exclusions. An empty list `[]` also imposes no scope exclusions. If a list contains patterns but the event has no session key, that action is skipped because the exclusion rules cannot be evaluated. A malformed scope, unknown scope field, non-string pattern or empty pattern string is a configuration error.

**Example config** — exclude cron jobs from automatic memory entirely, allow subagents to recall but not retain:

```json
{
  "scope": {
    "skipRecallSessions": ["agent:*:cron:**"],
    "skipRetainSessions": ["agent:*:cron:**", "agent:*:subagent:**"]
  }
}
```

To disable an automatic action globally, set its list to `["**"]`. To disable both, set both lists to `["**"]`. The explicit memory and knowledge tools remain available.

### Migrating previous memory controls

This is a breaking configuration change. Remove the old fields from plugin config before loading this version; the strict configuration schema rejects them. There are no compatibility aliases.

| Removed setting                          | Replacement                                                                                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoRecall: false`                      | Add `"**"` to `scope.skipRecallSessions`.                                                                                                                                                     |
| `autoRetain: false`                      | Add `"**"` to `scope.skipRetainSessions`.                                                                                                                                                     |
| `autoRecall: true` / `autoRetain: true`  | Remove the setting; automatic memory is enabled by default.                                                                                                                                   |
| `ignoreSessionPatterns`                  | Copy its patterns into both skip lists.                                                                                                                                                       |
| `statelessSessionPatterns`               | Copy its patterns into `skipRetainSessions`; also copy them into `skipRecallSessions` if `skipStatelessSessions` was omitted or `true`.                                                       |
| `skipStatelessSessions`                  | Remove after migrating the stateless patterns; `false` meant recall remained allowed.                                                                                                         |
| `enableTools` / `enableKnowledgeTools`   | Remove; explicit tools are always registered when supported by the host. Disabling tools through plugin config is no longer supported.                                                        |
| `excludeProviders`                       | Remove; provider-wide exclusions have no lossless session-glob equivalent because provider and session namespace can differ. Choose exclusions from the actual session keys you want to skip. |
| `operationalSessionPolicy` (unpublished) | Remove; cron/subagent sessions are now eligible by default. Use the skip lists for sessions that should remain excluded.                                                                      |

Merge migrated patterns with any patterns already in the corresponding list. Existing cron, subagent and heartbeat sessions become eligible unless excluded by the new scope. To retain the old cron/subagent namespace exclusions, add `agent:*:cron:**` and `agent:*:subagent:**` to both lists. Heartbeat can also use an ordinary session key; only a dedicated heartbeat namespace can be excluded with `agent:*:heartbeat:**`. Session patterns cannot distinguish heartbeat from other runs sharing the same key.

### Durable conversation retention

Auto-retain saves each eligible transcript before any API initialization or network request. Agent-scoped plugin instances enqueue only; the Gateway service delivers queued items on its existing timer (60 seconds by default, configurable with `retainQueueFlushIntervalMs`). A running service can also drain immediately after a turn.

`retainQueuePath` remains the queue base path, defaulting to `~/.openclaw/plugins/hindsight-memory/retain-queue.jsonl`. New items are JSON files with POSIX permissions `0600` in the adjacent `<retainQueuePath>.d` directory. On Windows, access is governed by directory ACLs; file contents are synced, while directory fsync is unavailable. Existing JSONL entries are migrated, and the original file is preserved as `.migrated` for recovery. Stop older plugin versions before upgrading so they cannot continue writing the legacy JSONL.

Each worker cycle sorts a filename snapshot and asynchronously reads only the candidates needed for up to 50 deliverable items; expired or corrupt candidates are skipped. Corrupt files are preserved with a `.corrupt` suffix and excluded from future scans. Older hash-only outbox filenames are normalized once, asynchronously, before batching to preserve FIFO order. The worker removes an item only after the API accepts it. Initialization failures, request failures, and service retirement leave it available for the next retry or restart. The same operation ID is retained across attempts; servers supporting operation IDs can deduplicate a lost acknowledgement. Older servers cannot guarantee duplicate-free replay. Delivery means the asynchronous retain request was accepted, not that fact extraction has completed.

If server capability detection is unavailable, items stay queued until it succeeds. If disk persistence fails, the plugin reports an error and lets the agent reply continue. `retainQueueMaxAgeMs` still controls optional expiration; the default keeps items indefinitely. Only one Gateway process should drain a queue directory.

## Retention details

Retained documents use stable session-scoped IDs derived from the OpenClaw `sessionKey`. Every retain in a session shares one document id like `openclaw:agent:agentname:discord:channel:123`, so all turns of the conversation accumulate under a single Hindsight document (on legacy APIs without `update_mode: 'append'` support, the integration falls back to per-retain ids — `...:turn:<boot>:000001`, `...:window:<boot>:000002` for chunked retention — so prior turns aren't overwritten; `<boot>` is a token minted per host process, which keeps a restart from replaying ids the previous run already used). Retained documents include richer metadata such as `session_key`, `agent_id`, `provider`, `channel_id`, `thread_id`, `sender_id`, `turn_index`, and `retention_scope`. Each message in the retained JSON also carries a structured `timestamp` field (ISO 8601) lifted from OpenClaw's per-message time, so facts are not polluted by inline weekday/date prefixes.

`retainContext` is sent separately from the transcript content and gives Hindsight's extraction LLM interpretation guidance for the retained document. The default is designed for OpenClaw transcripts: it explains that sender/channel/provider metadata is operational routing data, that assistant-role first-person statements belong to the AI assistant, and that bank IDs or tags should not be treated as the discussed project. Sender/channel/provider stay in retain request metadata/context and are not prepended into retained transcript content.

## OpenClaw compatibility

This fork builds against the official OpenClaw `2026.10.4` SDK and declares that
exact peer dependency. Older hosts are not supported by this release.

The entry uses `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry` and
registers typed hooks with `api.on(...)`. Plugin settings come from the host's
resolved `api.pluginConfig`; SDK imports use focused public subpaths.

- `before_prompt_build` uses `currentUserMessage` when supplied. An explicit
  empty string skips recall, including image-only requests; it never falls back
  to history. The prepared prompt is used only when the harness omits the field.
- `agent_end` captures turns at the configured retention cadence. `session_end`
  flushes pending turns through `ctx.endedTranscript.readTail(...)`, bounded to
  1,000 messages and 2 MiB, while the handler is active. If the reader is absent or unavailable, the flush is
  skipped; the plugin does not read a session JSONL file as a fallback. The host
  may truncate the tail to its limits, so very large pending windows can be
  incomplete. Shutdown/restart gives all session-end handlers a shared two-second
  drain budget. Pending retains are persisted to the local outbox before any
  delivery attempt to Hindsight.
- Recall progress keeps the public SDK `emitAgentEvent` import because the
  registration API's event facade disallows global side effects in agent-scoped
  prompt hooks.

### Hook permissions

As a non-bundled plugin, automatic recall and retention require explicit
conversation access. Merge these keys into the existing entry in
`~/.openclaw/openclaw.json`; `hooks` is alongside `config`:

```json
{
  "plugins": {
    "entries": {
      "hindsight-memory": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": true
        }
      }
    }
  }
}
```

`allowConversationAccess` admits conversation hooks, including
`before_prompt_build` and `agent_end`, and grants access to the bounded ended
transcript when the host has a safe source. `session_end` itself can still run as
a metadata-only hook without the grant. `allowPromptInjection` defaults to
allowed; explicitly setting it to `false` blocks `before_prompt_build`, disabling
automatic recall injection. It does not grant conversation access. See the
[official hook permissions](https://docs.openclaw.ai/plugins/hooks#permissions-and-scope)
and [session lifecycle contract](https://docs.openclaw.ai/plugins/hooks/reference#hook-catalog).

The memory-slot switch from `memory-core` to `hindsight-memory` is expected:
Hindsight replaces OpenClaw's built-in memory plugin. A doctor report that
`memory-core` is not selected for that slot is therefore expected as well.

## Documentation

For full documentation, configuration options, troubleshooting, and development guide, see:

**[OpenClaw Integration Documentation](https://vectorize.io/hindsight/sdks/integrations/openclaw)**

## Development

To test local changes to the Hindsight package before publishing:

1. Add `embedPackagePath` to your plugin config in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "hindsight-memory": {
        "enabled": true,
        "config": {
          "embedPackagePath": "/path/to/hindsight-wt3/hindsight-embed"
        }
      }
    }
  }
}
```

2. The plugin will use `uv run --directory <path> hindsight-embed` instead of `uvx hindsight-embed@latest`

3. To use a specific profile for testing:

```bash
# Check daemon status
uvx hindsight-embed@latest -p openclaw daemon status

# View logs
tail -f ~/.hindsight/profiles/openclaw.log

# List profiles
uvx hindsight-embed@latest profile list
```

## Backfilling Existing OpenClaw History

The package includes a config-aware backfill CLI for importing historical OpenClaw sessions into Hindsight.

By default it mirrors the active plugin settings for:

- `dynamicBankId`
- `dynamicBankGranularity`
- `bankIdPrefix`
- local daemon vs external `hindsightApiUrl`

Dry-run example:

```bash
node dist/backfill.js \
  --openclaw-root ~/.openclaw \
  --dry-run
```

Direct invocation from a built checkout:

```bash
node dist/backfill.js --openclaw-root ~/.openclaw --dry-run
```

Migration-oriented overrides are explicit:

```bash
node dist/backfill.js \
  --openclaw-root ~/.openclaw \
  --bank-strategy agent \
  --agent proj-run \
  --resume \
  --max-pending-operations 10
```

Useful options:

- `--agent <id>` limit import to selected agents
- `--exclude-archive` ignore `sessions-archive-from-migration_backup`
- `--bank-strategy mirror-config|agent|fixed`
- `--resume` skip only entries already finalized as completed
- `--checkpoint <path>` store progress outside the default location
- `--wait-until-drained` block until the touched bank queues have finished and checkpoint state can be finalized

## Links

- [Hindsight Documentation](https://vectorize.io/hindsight)
- [OpenClaw Documentation](https://openclaw.ai)
- [GitHub Repository](https://github.com/vectorize-io/hindsight)

## License

MIT

### Jules PR review

The Jules review workflow follows skill-harness. Connect this repository to Jules
and configure the `JULES_API_KEY` GitHub Actions secret. Reviews run for pull
requests opened by the owner or trusted collaborators; GitHub supplies
`GITHUB_TOKEN` automatically. Large diffs use a temporary branch that the workflow
cleans up after review.

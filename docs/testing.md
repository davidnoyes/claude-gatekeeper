# Testing

## Running Tests

```bash
# All tests
nvm exec npm test

# With verbose output
nvm exec npm test -- --verbose

# With coverage report
nvm exec npm run test:coverage

# Integration tests only (spawns the compiled CLI/hook binaries)
nvm exec npm run test:integration

# Live E2E tests only (real Claude CLI, costs a little real money)
nvm exec npm run test:e2e

# Watch mode (re-run on changes)
nvm exec npm run test:watch
```

## Test Structure

```
tests/
├── unit/                       # Unit tests (mocked dependencies)
│   ├── allowlist.test.ts       # Permission allow/deny/ask-list matching
│   ├── config.test.ts          # Config loading, merging, validation
│   ├── context.test.ts         # Context file loading, truncation
│   ├── daemon.test.ts          # Dashboard daemon state file + PID liveness
│   ├── dashboard.test.ts       # Dashboard helper functions
│   ├── desktop-notify.test.ts  # Local desktop notification on escalation
│   ├── enable.test.ts          # Enable/disable toggle
│   ├── evaluator.test.ts       # AI response parsing, CLI/API backends
│   ├── index.test.ts           # Main pipeline orchestration
│   ├── logger.test.ts          # Audit logging
│   ├── notify.test.ts          # ntfy.sh push notification formatting/parsing
│   ├── patterns.test.ts        # User-defined pattern sanitization/storage
│   ├── project-dir.test.ts     # Project directory resolution from transcript_path
│   ├── prompt.test.ts          # Prompt construction
│   ├── rules.test.ts           # Static pattern matching
│   └── types.test.ts           # Confidence level ordering/thresholds
├── integration/                 # Integration tests (spawn real compiled binaries)
│   ├── cli.test.ts              # `bin/gatekeeper` subcommands end-to-end
│   ├── dashboard.test.ts        # Real dashboard HTTP/SSE server
│   ├── hook.test.ts             # Spawns dist/index.js with fixture stdin
│   └── fake-claude.js           # Stand-in `claude` CLI used by hook.test.ts
├── e2e/                          # Live tests against the real Claude CLI (excluded from `npm test`)
│   └── live.test.ts
└── fixtures/                    # Sample permission request payloads
    ├── bash-npm-build.json
    ├── bash-rm-rf.json
    ├── bash-curl-pipe-sh.json
    ├── bash-sudo.json
    ├── write-src-file.json
    ├── write-etc-passwd.json
    └── webfetch-github.json
```

## What Each Test Suite Covers

### `allowlist.test.ts`
- Glob-style matching against the user's Claude Code allow/deny/ask permission lists (`Bash(echo:*)`, `WebFetch(domain:...)` incl. subdomains, etc.)
- Priority order: deny > ask > allow
- Missing/empty settings.json and malformed rules
- Per-segment compound matching — every segment of a `&&`/`||`/`;`-chained command must match (command smuggling)
- Command-substitution suppression — matches are withheld when `$()`, backticks, or `<()`/`>()` are present (evasion via substitution)

### `config.test.ts`
- Default config when no file exists
- Merging user config with defaults
- Malformed JSON handling
- Value validation (threshold clamping, enum validation)
- Pattern array merging (user + defaults, no duplicates)
- Path resolution (~/ to home directory)

### `context.test.ts`
- Loading all context files (settings, CLAUDE.md, GATEKEEPER_POLICY.md)
- Graceful handling of missing files (returns null)
- Content truncation to maxContextLength
- Fallback from `GATEKEEPER_POLICY.md` to `.claude/GATEKEEPER_POLICY.md`

### `daemon.test.ts`
- Dashboard daemon state file (`statePath`/`logPath`) locations
- Parsing daemon state JSON (rejects zero/negative/non-numeric PIDs, defaults port)
- PID liveness checking

### `dashboard.test.ts` (unit)
- Localhost detection and token validation helpers
- Decision-line parsing used to build the dashboard's data feed

### `desktop-notify.test.ts`
- `notifyEscalation` is a no-op when `escalationNotifyCommand` is unset/empty
- Spawns the configured command via `sh -c` with `GATEKEEPER_TOOL`/`INPUT`/`REASON`/`CWD` env vars, inherits `process.env`, and detaches (`unref()`)
- Never throws, even if spawning fails
- Per-tool input summarization (WebFetch/Write, etc.)

### `enable.test.ts`
- Toggling `enabled` in config on/off, including when no config exists yet
- Idempotent messaging when already enabled/disabled
- Warning when enabling with no hooks registered

### `evaluator.test.ts`
- JSON response parsing (valid, embedded in text, malformed)
- Confidence clamping and defaults
- Keyword fallback matching (approve/escalate)
- Cost capture from the CLI backend's `total_cost_usd` field
- CLI backend: success, non-zero exit, spawn error, timeout, tools disabled (`--allowedTools ''`)
- API backend: error handling

### `index.test.ts`
- Full pipeline: approve flow, escalate flow, error flow
- Static rule bypass (approve and escalate)
- Disabled config handling
- Actor-hook model: in hands-free mode, `PermissionRequest` defers evaluation to `PreToolUse` (the actor hook) so decisions aren't double-evaluated or double-logged; in allow-or-ask mode it's the reverse
- Malformed/unreadable stdin: escalates in allow-or-ask mode (fail-safe), denies in hands-free mode (fail-closed)
- HookOutput JSON format validation

### `logger.test.ts`
- Log line format and content
- Log level filtering
- Long command truncation
- Tool-specific input summarization
- Silent error swallowing
- Debug vs info vs warn levels
- JSONL decision sink (`decisionJsonlPath`, `readDecisions`) alongside the text log
- `aggregateCosts` bucketing of logged costs

### `notify.test.ts`
- ntfy.sh notification formatting (per-tool labels, truncation, session name/id fallback)
- `notifyAndWait` timeout when topic/config is missing
- SSE response parsing and nonce validation for remote approve/deny replies

### `patterns.test.ts`
- `sanitizePatterns`: trims/dedupes, rejects non-array/non-string/control-char/oversized/too-many-wildcard entries
- Approve-kind patterns reject an all-wildcard `*`; escalate-kind patterns allow it
- `setUserPatterns`/`getUserPatterns` round-trip; invalid input leaves stored config unchanged
- `loadConfig` merges custom patterns with the built-in defaults

### `project-dir.test.ts`
- `encodeProjectPath`/`decodeProjectSlug` round-trip Claude Code's directory-slug encoding (slashes, dots, spaces, underscores, hyphenated names)
- `extractSlugFromTranscriptPath`
- `resolveProjectDir` prefers `transcript_path`, falling back to `cwd` when decoding fails or the path is missing

### `prompt.test.ts`
- System prompt content validation
- Permission rule summarization (with truncation for long lists)
- User message construction with all context variants
- Graceful handling of null context

### `rules.test.ts`
- Match target extraction per tool type
- Compound command splitting (pipes, &&, ||, ;)
- Wildcard pattern matching
- Dangerous command escalation
- Always-approve pattern matching
- Per-segment checking for compound commands (compound smuggling)
- Command-substitution suppression
- Non-Bash tool matching (Write, WebFetch)

### `types.test.ts`
- `CONFIDENCE_LEVELS` ordering
- `meetsThreshold` comparison logic (equal/exceeds/below)

### `hook.test.ts` (integration)
- Invalid/empty stdin → escalate
- Static rule matches → escalate (rm -rf, sudo, curl|sh)
- Missing API key → escalate
- `AskUserQuestion` handling in supervised vs. hands-free mode
- Full AI evaluation pipeline against a fake `claude` CLI (approve/escalate/timeout/malformed/error)
- Config-driven behavior (disabled, threshold changes)
- Never crashes (exit 0 on all code paths)
- Approval JSON format validation

### `cli.test.ts` (integration)
- `setup`: hook registration, preserves existing hooks, no duplicate entries, optional config/policy creation
- `uninstall`: hook removal, preserves unrelated hooks, optional config deletion, per-project policy warning
- `status`, `notify` subcommands, `enable`/`disable`
- Full setup → uninstall round-trip against the compiled CLI

### `dashboard.test.ts` (integration)
- Real HTTP server: `/api/status`, `/api/decisions`, `/api/costs` (day/week/month buckets)
- SSE streaming via `/api/stream`, including `Last-Event-ID` reconnect
- Token-gated `/api/enable` and `/api/mode` (rejects invalid mode)
- `/api/patterns` GET/POST (rejects missing token, invalid body, all-wildcard approve pattern)
- Host-header validation rejects non-localhost requests

## Test Fixtures

Each fixture is a valid `HookInput` JSON that simulates a real Claude Code permission request:

| Fixture | Tool | Expected |
|---------|------|----------|
| `bash-npm-build.json` | Bash | Evaluate (AI decides) |
| `bash-rm-rf.json` | Bash | Escalate (static rule) |
| `bash-curl-pipe-sh.json` | Bash | Escalate (static rule) |
| `bash-sudo.json` | Bash | Escalate (static rule) |
| `write-src-file.json` | Write | Evaluate (AI decides) |
| `write-etc-passwd.json` | Write | Evaluate (AI decides) |
| `webfetch-github.json` | WebFetch | Evaluate (AI decides) |

## Coverage Thresholds

The project enforces minimum coverage (see `jest.config.js` for exact numbers; currently 75% branches, 80% functions/lines/statements). Run `npm run test:coverage` to check.

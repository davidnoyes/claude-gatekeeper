# Configuration

## Config File Location

```
~/.claude/claude-gatekeeper/config.json
```

The config file is optional. All fields have sensible defaults.

## Full Configuration Reference

```json
{
  "enabled": true,
  "mode": "allow-or-ask",
  "backend": "cli",
  "model": "haiku",
  "confidenceThreshold": "high",
  "timeoutMs": 90000,
  "maxContextLength": 5000,
  "logFile": "~/.claude/claude-gatekeeper/decisions.log",
  "logLevel": "info",
  "alwaysEscalatePatterns": [],
  "alwaysApprovePatterns": [],
  "notify": {
    "topic": "your-unguessable-topic-name",
    "server": "https://ntfy.sh",
    "timeoutMs": 60000
  },
  "escalationNotifyCommand": "terminal-notifier -title \"Gatekeeper\" -message \"$GATEKEEPER_TOOL: $GATEKEEPER_REASON\""
}
```

## Field Reference

### `enabled` (boolean, default: `true`)
Master switch. Set to `false` to disable the hook entirely — all permission requests will pass through to the user as normal.

### `mode` (string, default: `"allow-or-ask"`)
The gatekeeper's operating mode:
- `"allow-or-ask"` — Safe commands are auto-approved by AI; uncertain or dangerous commands are escalated to the user for a decision. The AI never auto-denies in this mode — you always have the final say.
- `"hands-free"` — Safe commands are auto-approved by AI; uncertain or dangerous commands are auto-denied with a reason (no user interaction). Errors and timeouts also deny (fail-closed), since there's no one to ask.
- `"full"` — Coming soon; not yet available.

Switch modes with `claude-gatekeeper mode <name>` (or run `claude-gatekeeper mode` with no argument to see the current mode). This is just a config write — it sets `mode` in `config.json`.

### `backend` (string, default: `"cli"`)
Which AI backend to use:
- `"cli"` — Uses `claude -p --model haiku` subprocess. Zero config, piggybacks on existing Claude Code auth. No API key needed.
- `"api"` — Uses `@anthropic-ai/sdk` directly. Requires `ANTHROPIC_API_KEY` env var. ~2x faster than CLI.

If `"api"` is set but `ANTHROPIC_API_KEY` is missing, automatically falls back to `"cli"`.

### `model` (string, default: `"haiku"`)
Model to use for evaluation:
- CLI backend: passed as `--model` flag to `claude -p`
- API backend: `"haiku"` maps to `claude-haiku-4-5-20251001`. Any other value is passed directly.

### `confidenceThreshold` (string, default: `"high"`)
Minimum confidence level required from the AI to auto-approve. The AI picks from five ordered levels; only responses at or above the threshold are auto-approved.

| Level | Meaning | Use as threshold |
|-------|---------|-----------------|
| `"none"` | No basis for a judgment | Approve almost everything (not recommended) |
| `"low"` | Slight lean but very uncertain | Very aggressive — most AI responses pass |
| `"medium"` | Somewhat confident, notable uncertainty | Moderate — approve when AI has a reasonable read |
| `"high"` | Confident with minor reservations | **Default** — good balance of safety and convenience |
| `"absolute"` | No reasonable doubt | Very conservative — only approve when AI is certain |

### `timeoutMs` (number, default: `90000`)
Maximum time in milliseconds to wait for AI evaluation. Clamped to [1000, 120000]. If the AI doesn't respond in time, the request is escalated to the user (allow-or-ask) or denied (hands-free).

### `maxContextLength` (number, default: `5000`)
Maximum characters of each context file (CLAUDE.md and GATEKEEPER_POLICY.md, global and project) to include in the AI prompt. Longer values give the AI more context but increase latency and token usage.

### `logFile` (string, default: `~/.claude/claude-gatekeeper/decisions.log`)
Path to the audit log file. Supports `~` for home directory. The directory is created automatically if it doesn't exist.

### `logLevel` (string, default: `"info"`)
- `"debug"` — Log everything including full prompts sent to the AI
- `"info"` — Log decisions with reasoning
- `"warn"` — Only log warnings and errors (minimal logging)

### `alwaysEscalatePatterns` (string[], default: see below)
Wildcard patterns that bypass AI and always escalate to the user (allow-or-ask) or deny with a reason (hands-free). These are checked **before** any AI call, so they're essentially free.

Patterns use `*` as a wildcard that matches any characters (including `/` and spaces). For Bash commands, each segment of compound commands (split on `|`, `&&`, `||`, `;`) is checked individually.

Default patterns:
```
rm -rf /*, rm -rf /, rm -rf ~, rm -rf $HOME
> /dev/sd*, mkfs.*, dd if=*
chmod -R 777 /*, :(){:|:&};:
curl *| *sh, curl *| *bash, wget *| *sh, wget *| *bash
sudo *, su *
npm publish*, npm unpublish*
aws * delete-*, aws * terminate-*, aws * destroy-*
terraform apply*, terraform destroy*
docker rm *, docker rmi *, docker system prune*
```

User-provided patterns are **merged** with (added to) the defaults — the built-in safety patterns can't be accidentally removed by a user config. This is different from `alwaysApprovePatterns` below, whose user list **replaces** its (empty) default outright.

For `Bash` commands, patterns are matched against each segment of a compound command individually (split on `|`, `&&`, `||`, `;`, and newlines), so a dangerous command can't hide behind a benign one in a chain like `echo hello && sudo rm -rf /`.

Both `alwaysEscalatePatterns` and `alwaysApprovePatterns` can also be viewed and edited from the dashboard's Patterns panel (`claude-gatekeeper dashboard`), which validates entries (length, wildcard count, no control characters, no all-wildcard approve patterns) before saving them to `config.json`.

### `alwaysApprovePatterns` (string[], default: `[]`)
Wildcard patterns that bypass AI and always auto-approve. Use carefully — these skip all safety checks. Unlike `alwaysEscalatePatterns`, a user-provided list here **replaces** the default (empty) list entirely.

Example:
```json
{
  "alwaysApprovePatterns": [
    "prettier *",
    "eslint *",
    "tsc --noEmit"
  ]
}
```

### `notify` (object, optional, default: not set)
Enables ntfy.sh push notifications with Approve/Deny action buttons, so you can respond to an escalation from your phone. Only takes effect in `allow-or-ask` mode. If `notify.topic` is missing or not a string, the entire `notify` config is dropped (treated as not set).

| Sub-field | Default | Notes |
|-----------|---------|-------|
| `topic` | *(required)* | The ntfy topic name. Its presence is what activates notifications. Anyone who knows the topic name can read/publish to it on the public server, so use a long, unguessable value. |
| `server` | `"https://ntfy.sh"` | ntfy server URL. Point this at a self-hosted server if desired. |
| `timeoutMs` | `60000` | How long to wait for a phone response before falling back to the normal escalation flow. Clamped to [5000, 120000]. |
| `token` | *(none)* | Optional bearer token, for a private/authenticated ntfy server. |

Set up notifications with `claude-gatekeeper notify setup` (interactive wizard), test with `claude-gatekeeper notify test`, and remove with `claude-gatekeeper notify disable`. Each notification includes a one-time random nonce that the Approve/Deny action must echo back, so a replayed or guessed response can't be used to approve a different request.

### `escalationNotifyCommand` (string, optional, default: not set)
A shell command run best-effort and detached (never blocks the hook) whenever the gatekeeper escalates a request to the user in `allow-or-ask` mode — useful for firing a local desktop notification. The command receives request details via environment variables rather than string interpolation, so there's no shell-injection risk from tool input:

- `GATEKEEPER_TOOL` — the tool name (e.g. `Bash`)
- `GATEKEEPER_INPUT` — a summary of the tool input (e.g. the command or file path)
- `GATEKEEPER_REASON` — the reason for escalation
- `GATEKEEPER_CWD` — the working directory of the request

Example using [terminal-notifier](https://github.com/julienXX/terminal-notifier) on macOS:
```json
{
  "escalationNotifyCommand": "terminal-notifier -title \"Gatekeeper: $GATEKEEPER_TOOL\" -message \"$GATEKEEPER_REASON\""
}
```

## Gatekeeper Policy Files

In addition to the config file, you can create per-project gatekeeper policies:

- `<project>/GATEKEEPER_POLICY.md` — Project-level policy
- `<project>/.claude/GATEKEEPER_POLICY.md` — Alternative location

These are human-readable markdown files that the AI uses as additional context when making decisions. See `templates/GATEKEEPER_POLICY.md` for the default template.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Required for `"api"` backend. Not needed for `"cli"` backend. |

## Example Configurations

### Conservative (fewer auto-approvals)
```json
{
  "confidenceThreshold": "absolute",
  "timeoutMs": 5000
}
```

### Aggressive (more auto-approvals)
```json
{
  "confidenceThreshold": "medium",
  "alwaysApprovePatterns": ["prettier *", "eslint *", "tsc *"]
}
```

### Fast (direct API)
```json
{
  "backend": "api",
  "timeoutMs": 5000
}
```

### Disabled
```json
{
  "enabled": false
}
```

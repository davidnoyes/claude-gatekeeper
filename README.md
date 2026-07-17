# Claude Gatekeeper

A Claude Code hook that uses AI to automatically evaluate permission prompts. Instead of being bombarded with "Do you want to proceed?" dialogs, this tool uses Claude Haiku to intelligently auto-approve safe operations while escalating uncertain or dangerous ones to you.

## How It Works

```
Permission Request → Static Rules → AI Evaluation → Decision
                      (ms fast)      (1-5s)
                         ↓               ↓
                    Escalate/Approve    Approve (high confidence)
                                       Escalate (low confidence or error)
```
> Note: This flow shows **allow-or-ask** mode. In **hands-free** mode, "escalate" becomes "deny with reason" and errors result in denial instead of escalation.

1. **Claude Code triggers a permission prompt** for a tool it wants to use (Bash, Write, Edit, etc.)
2. **Static rules check first** — obviously dangerous commands (rm -rf, sudo, curl|sh) are immediately escalated; known-safe patterns are immediately approved
3. **AI evaluation** — for everything else, Claude Haiku analyzes the request with full context (your settings, CLAUDE.md, project gatekeeper policy)
4. **Decision** — if AI confidence meets or exceeds the threshold (default: `high`), it auto-approves. Otherwise, the normal permission prompt appears

**Key safety guarantee:** In **allow-or-ask** mode, the tool never auto-denies — it can only approve or pass through to you. Any error results in the normal prompt appearing. In **hands-free** mode, uncertain or dangerous commands are denied with a reason (Claude adjusts its approach), and errors result in denial (fail-closed).

## Installation

```bash
# From source (npm package coming soon)
git clone https://github.com/ahmed-anas/claude-gatekeeper.git
cd claude-gatekeeper
nvm exec npm install
nvm exec npm run build
nvm exec npm link
```

Then run the setup wizard:

```bash
claude-gatekeeper setup
```

This will:
1. Register the PermissionRequest and PreToolUse hooks in `~/.claude/settings.json`
2. Optionally create a config file at `~/.claude/claude-gatekeeper/config.json`
3. Optionally install a global `GATEKEEPER_POLICY.md` template

To check your installation:

```bash
claude-gatekeeper status
```

## Uninstalling

```bash
claude-gatekeeper uninstall
```

This removes the hook from `~/.claude/settings.json` and optionally deletes `~/.claude/claude-gatekeeper/` (config, logs, gatekeeper policy). Per-project `GATEKEEPER_POLICY.md` files are **not** removed — delete those manually if needed.

To also remove the CLI:

```bash
npm uninstall -g claude-gatekeeper
```

## Modes

Claude Gatekeeper supports multiple operating modes. Switch with:

```bash
claude-gatekeeper mode              # show current mode
claude-gatekeeper mode hands-free   # switch to hands-free
claude-gatekeeper mode allow-or-ask # switch to allow-or-ask
```

### How each mode handles commands

| User's permission list | allow-or-ask (default) | hands-free | full (coming soon) |
|------------------------|----------------------|------------|-------------------|
| **allow list** | pass through | pass through | approve |
| **deny list** | ask user | deny with reason | deny |
| **ask list** | ask user | deny with reason | ask user |
| **not in any list** | AI → approve or ask | AI → approve or deny | AI → approve, deny, or ask |
| **error/timeout** | ask user | deny (fail-closed) | ask user |

### allow-or-ask (default)

Safe commands are auto-approved by AI. For uncertain commands, the permission prompt appears to the user while the hook evaluates in the background. If the user acts first (approve/reject), their choice takes effect immediately. If the hook finishes first and approves, the prompt disappears and Claude continues. The hook never denies in this mode — it only approves or lets the prompt stay.

### hands-free

The permission prompt **never appears** — the user is completely away. Safe commands are auto-approved, dangerous or uncertain ones are **denied with a reason** that Claude can read and adjust to. Errors result in denial (fail-closed). Ideal for unattended/automated workflows.

When a command is denied, Claude receives a message like:
> *"This is an automated deny by Claude Gatekeeper. The user is currently away and has delegated the AI gatekeeper to allow/deny commands. Reason: [explanation]. You may attempt alternative commands."*

### full (coming soon)

Full autonomous mode with extended capabilities. Not yet implemented.

## Enable / Disable

Quickly toggle the gatekeeper without uninstalling:

```bash
claude-gatekeeper disable   # pause — hooks escalate all requests to user
claude-gatekeeper enable    # resume AI evaluation
claude-gatekeeper status    # shows current state (active / paused / not installed)
```

When disabled, hooks remain registered but immediately escalate every request to the normal permission prompt. No AI calls are made. Re-enable anytime with `claude-gatekeeper enable`.

## Notifications

The gatekeeper has two independent, optional notification channels — use either, both, or neither. Both apply only in **allow-or-ask** mode (in hands-free there's no one to notify):

- **Push (remote approval)** — a phone push via ntfy with **Approve / Deny** buttons, so you can act on an escalation while away.
- **Desktop (local, informational)** — a local notification (e.g. `terminal-notifier`) fired only when the gatekeeper escalates to you. It informs; it can't approve. See [Desktop Notification on Escalation](#desktop-notification-on-escalation).

## Push Notifications (Remote Approval)

Approve or deny escalated requests from your phone via [ntfy.sh](https://ntfy.sh) push notifications. Only active in allow-or-ask mode.

### Setup

```bash
claude-gatekeeper notify setup
```

The interactive wizard guides you through:
1. Installing the ntfy app on your phone
2. Subscribing to a randomly generated, hard-to-guess topic
3. (Optional) providing an access token for a private/authenticated ntfy server
4. Verifying notifications work end-to-end

### How it works

When the gatekeeper escalates a request, your phone receives a push notification with **Approve** and **Deny** buttons. The terminal prompt also appears simultaneously — whichever you respond to first wins.

Each request carries a one-time **nonce** that the response must echo back, so a stale or replayed tap can't approve a later, unrelated request. If you set a `token` (in `config.json` under `notify.token`, or via the wizard), it's sent as a bearer `Authorization` header on both the publish and the response-listening (SSE) connections, so a private ntfy server can gate access.

### Configuration

`claude-gatekeeper notify setup` writes a `notify` block into
`~/.claude/claude-gatekeeper/config.json`; you can also edit it by hand:

```json
{
  "notify": {
    "topic": "gk-1a2b3c4d5e6f7g8h",
    "server": "https://ntfy.sh",
    "timeoutMs": 60000,
    "token": "tk_xxxxxxxx"
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `topic` | *(required)* | ntfy topic to publish to — its presence is what activates push notifications. Anyone who knows a **public** topic can see your requests and send approve/deny, so use a long, unguessable value (the wizard generates one). |
| `server` | `https://ntfy.sh` | ntfy server URL. Point this at a self-hosted / private ntfy instance to keep requests off the public server. |
| `timeoutMs` | `60000` | How long the hook waits for a phone response before falling back to the normal terminal prompt. Clamped to 5000–120000. |
| `token` | *(none)* | Bearer token sent as `Authorization` on both the publish and the SSE response stream. Use with a private/authenticated ntfy server so only you can read and approve. |

> **Security:** on the public `ntfy.sh` server a topic is effectively a shared secret — treat it like a password, and for anything sensitive prefer a private server with a `token`. Escalated requests are only ever *published* (never auto-approved); a response takes effect only if it carries the matching one-time nonce.

### Commands

```bash
claude-gatekeeper notify setup    # interactive setup wizard
claude-gatekeeper notify test     # send a test notification
claude-gatekeeper notify disable  # remove notification config
```

## Desktop Notification on Escalation

If you're at your machine (rather than remote), you can get a **local desktop notification only when the gatekeeper escalates to you** — never for the many commands it auto-approves. Set `escalationNotifyCommand` in your config to any shell command; it runs (best-effort, detached) on each escalation in allow-or-ask mode:

```json
// ~/.claude/claude-gatekeeper/config.json
{
  "escalationNotifyCommand": "terminal-notifier -title \"Gatekeeper — approval needed\" -subtitle \"$GATEKEEPER_TOOL\" -message \"$GATEKEEPER_INPUT\" -sound Glass"
}
```

The command receives details via environment variables (never interpolated into the shell, so there's no injection risk):

| Variable | Contents |
|----------|----------|
| `GATEKEEPER_TOOL` | Tool name (e.g. `Bash`, `Write`) |
| `GATEKEEPER_INPUT` | Short summary of the command / file / URL |
| `GATEKEEPER_REASON` | Why it was escalated |
| `GATEKEEPER_CWD` | Working directory |

This is more precise than a generic Claude Code `Notification` hook, which fires when the prompt *appears* — before the gatekeeper has decided — and so alerts even for requests that are then auto-approved.

## Dashboard

A local, real-time web view of gatekeeper decisions, with quick controls.

```bash
claude-gatekeeper dashboard              # start it and open your browser
claude-gatekeeper dashboard --port 4180  # choose the port (default 4180)
claude-gatekeeper dashboard --no-open    # don't auto-open the browser
```

- **Live feed** of every decision (approve / escalate / deny) with reasoning, confidence, model, and latency, streamed over Server-Sent Events — no polling.
- **Status + controls** to enable/disable the gatekeeper and switch modes.
- **Localhost only** (binds `127.0.0.1`); mutating controls are protected by a per-run token plus a Host-header check (anti CSRF / DNS-rebinding).

### Running it in the background

```bash
claude-gatekeeper dashboard daemon start [--port N]  # run detached in the background
claude-gatekeeper dashboard daemon status            # running? pid / port / URL
claude-gatekeeper dashboard daemon stop              # stop it
claude-gatekeeper dashboard daemon restart [--port N]
```

This is a plain background process tracked by a pidfile — **not** a launchd LaunchAgent or login item, and it does not auto-restart. It stops on logout or via `daemon stop`. This is deliberate: on MDM/EDR-managed machines, launchd persistence (a login item with an auto-relaunching listener) is often flagged as malware. For auto-start at login on an unmanaged machine, add `claude-gatekeeper dashboard daemon start` to your shell profile.

## AI Backend

### Default: `claude -p` (zero config)

By default, the hook uses `claude -p --model haiku` to evaluate requests. This piggybacks on your existing Claude Code authentication — **no API key needed**.

### Optional: Direct Anthropic API (faster)

For ~2x faster evaluations, set `ANTHROPIC_API_KEY` in your environment and configure:

```json
// ~/.claude/claude-gatekeeper/config.json
{
  "backend": "api"
}
```

## Configuration

Create `~/.claude/claude-gatekeeper/config.json` (all fields optional):

```json
{
  "enabled": true,
  "backend": "cli",
  "model": "haiku",
  "confidenceThreshold": "high",
  "timeoutMs": 30000,
  "maxContextLength": 5000,
  "logFile": "~/.claude/claude-gatekeeper/decisions.log",
  "logLevel": "info",
  "alwaysEscalatePatterns": [],
  "alwaysApprovePatterns": []
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch — use `claude-gatekeeper enable/disable` to toggle |
| `backend` | `"cli"` | `"cli"` for `claude -p`, `"api"` for direct Anthropic API |
| `model` | `"haiku"` | Model name (used as-is for CLI, mapped for API) |
| `confidenceThreshold` | `"high"` | Minimum confidence to auto-approve: `"none"`, `"low"`, `"medium"`, `"high"`, `"absolute"` |
| `timeoutMs` | `30000` | Max time to wait for AI response |
| `maxContextLength` | `5000` | Max chars of each CLAUDE.md / GATEKEEPER_POLICY.md to include in prompt |
| `logFile` | `~/.config/.../decisions.log` | Audit log file path |
| `logLevel` | `"info"` | `"debug"`, `"info"`, or `"warn"` |
| `alwaysEscalatePatterns` | (see below) | Wildcard patterns that always escalate |
| `alwaysApprovePatterns` | `[]` | Wildcard patterns that always approve (no AI). For compound commands (`a && b`), **every** segment must match |
| `notify` | (unset) | ntfy push config: `{ topic, server?, token?, timeoutMs? }` — see [Push Notifications](#push-notifications-remote-approval) |
| `escalationNotifyCommand` | (unset) | Shell command run on each escalation (allow-or-ask) — see [Desktop Notification on Escalation](#desktop-notification-on-escalation) |

### Default Always-Escalate Patterns

These dangerous patterns bypass AI and always show the prompt to you (in hands-free mode they're denied). Compound commands are split on `|`, `&&`, `;`, `&`, and newlines, and **each segment** is checked — so a dangerous command can't hide behind a safe prefix. Commands using command substitution (`$(...)`, backticks) skip the static-approve/allow fast paths and always go to AI:

- `rm -rf /*`, `rm -rf /`, `rm -rf ~`
- `sudo *`, `su *`
- `curl *| *sh`, `wget *| *bash`
- `npm publish*`, `npm unpublish*`
- `terraform apply*`, `terraform destroy*`
- `aws * delete-*`, `aws * terminate-*`
- `docker rm *`, `docker rmi *`, `docker system prune*`
- And more (fork bombs, disk wiping, etc.)

### Adding your own patterns

Your `alwaysEscalatePatterns` and `alwaysApprovePatterns` in `config.json` are **merged with** the defaults (they add to them — you can't accidentally remove a built-in safety pattern). Patterns use `*` as a wildcard and are matched per-segment for Bash. For example, to always be asked before any push:

```json
{
  "alwaysEscalatePatterns": ["git push*"]
}
```

Now `git push`, `git push origin main --force`, and `deploy.sh && git push` all escalate to you instead of being auto-approved. `alwaysApprovePatterns` works the same way but auto-approves (no AI); for a compound command, **every** segment must match an approve pattern.

## Audit Log

Every decision is logged to the audit file:

```
[2026-03-13T18:30:00.000Z] decision=approve confidence=high model=cli:haiku latency=1200ms tool=Bash input="npm run build" reasoning="Standard build command"
[2026-03-13T18:30:05.000Z] decision=escalate confidence=absolute model=static latency=0ms tool=Bash input="sudo rm -rf /" reasoning="Matched always-escalate pattern"
```

## Project Gatekeeper Policy

Create a `GATEKEEPER_POLICY.md` in your project root (or `.claude/GATEKEEPER_POLICY.md`) to customize the AI's decisions for your specific project. See `templates/GATEKEEPER_POLICY.md` for the default template.

## Testing

```bash
nvm exec npm test              # Unit + integration tests
nvm exec npm run test:integration  # Integration tests only (fake Claude CLI)
nvm exec npm run test:e2e      # E2E tests with real Claude CLI (costs ~$0.001/test)
nvm exec npm run test:coverage # With coverage report
```

## Architecture

```
src/
├── index.ts          # Entry point: stdin → orchestrate → stdout
├── cli.ts            # CLI commands (setup, status, dashboard, notify, …)
├── types.ts          # TypeScript interfaces
├── config.ts         # Configuration loading + defaults (atomic writes)
├── context.ts        # Load settings, CLAUDE.md, GATEKEEPER_POLICY.md
├── permissions.ts    # Match against Claude Code allow/deny/ask lists
├── rules.ts          # Static wildcard pattern matching (compound-aware)
├── evaluator.ts      # AI evaluation (dual backend; tools disabled)
├── prompt.ts         # System prompt + untrusted-context user message
├── logger.ts         # Audit log (text + JSONL feed for the dashboard)
├── notify.ts         # ntfy push notifications (token + nonce)
├── desktop-notify.ts # Escalation-only local desktop notification
├── dashboard.ts      # Local web dashboard (HTTP + SSE)
└── daemon.ts         # Run the dashboard as a background process
```

## How AI Evaluation Works

When a request passes static rules without a match, it goes to Claude Haiku for evaluation. The evaluator deliberately separates **trusted instructions** from **untrusted data**:

- The **system prompt** (authoritative) defines its role as a security evaluator with explicit approve-vs-escalate criteria, and includes your **trusted global** gatekeeper policy (`~/.claude/claude-gatekeeper/GATEKEEPER_POLICY.md`).
- The **user message** carries the request and its context: the tool name and full input (e.g. `Bash` + `{"command": "npm test"}`), the working directory, and your existing permission rules (allow/ask/deny lists). Everything else that could be attacker-influenced — the project `GATEKEEPER_POLICY.md`, **both your global and project `CLAUDE.md`**, and project settings — is wrapped in a clearly delimited **UNTRUSTED CONTEXT** block. The **only** authoritative input is the global gatekeeper policy (in the system prompt above); the evaluator is instructed to treat everything in the untrusted block as data only: it may raise suspicion (leading to escalation) but can **never** be a reason to approve. This stops a compromised or misled agent from writing a file that talks the gatekeeper into approving something.

The AI responds with a JSON object: `{"decision": "approve"|"escalate", "confidence": "<level>", "reasoning": "..."}`. If confidence meets the configured threshold (default: `high`), the decision is applied. Otherwise it escalates. In hands-free mode, "escalate" is converted to "deny" with the reasoning passed to Claude so it can adjust its approach.

The prompt is deliberately conservative — "when in doubt, ALWAYS escalate" — since a false escalation just means you see a normal prompt, while a false approval could be dangerous.

**Response parsing is fail-safe:** only a well-formed JSON object with an explicit `"decision": "approve"` can auto-approve. Malformed or unparseable output defaults to **escalation** — it never approves on a loose keyword match. For the default `claude -p` backend, the evaluator subprocess also runs with tools disabled (`--allowedTools ""`), so untrusted content in a request can't induce it to take actions.

## Decision Flow

> Note: This diagram shows **allow-or-ask** mode. In **hands-free** mode, "escalate" becomes "deny with reason" and errors result in denial instead of escalation.

```
                    ┌─────────────────┐
                    │  Permission     │
                    │  Request (stdin)│
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Static Rules   │ ◄── alwaysEscalate / alwaysApprove patterns
                    └────────┬────────┘
                             │
                  ┌──────────┼──────────┐
                  │          │          │
              escalate    evaluate    approve
                  │          │          │
                  ▼          ▼          ▼
              (exit 0)   ┌──────┐   (JSON stdout)
              no output  │  AI  │
                         └──┬───┘
                            │
                   ┌────────┼────────┐
                   │                 │
          confidence ≥ threshold  confidence < threshold
                   │                 │
                   ▼                 ▼
              (JSON stdout)      (exit 0)
              auto-approve       no output
                                 show prompt
```

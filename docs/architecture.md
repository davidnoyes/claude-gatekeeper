# Architecture

## Overview

Claude Gatekeeper is a Claude Code hook that uses AI to auto-approve safe permission requests and escalate uncertain ones. It runs as both a **PermissionRequest** hook (fired when Claude Code is about to show a "Do you want to proceed?" prompt) and a **PreToolUse** hook (fired before every tool call, ahead of Claude Code's own permission check). Both hook types fire for every tool call; which one actually performs the evaluation depends on the configured **mode**:

- **allow-or-ask** (supervised, default) — the hook can only approve or escalate. It never denies. `PermissionRequest` is the acting hook; `PreToolUse` defers.
- **hands-free** — for when the user is away and there's no one to escalate to. The hook approves or denies with a reason. `PreToolUse` is the acting hook (it must be able to block the tool call before it runs); `PermissionRequest` defers.

## Design Principles

1. **Never auto-deny (allow-or-ask)** — In allow-or-ask mode, the hook can only approve or escalate (pass to user). It never blocks operations. In hands-free mode, uncertain/dangerous commands are denied with a reason.
2. **Fail-safe / Fail-closed** — In allow-or-ask mode, any error results in escalation (fail-safe). In hands-free mode, any error results in denial (fail-closed, no human to ask).
3. **Layered evaluation** — The user's Claude Code permission lists and static rules run first (milliseconds); AI runs last (1-5 seconds). This keeps common cases fast.
4. **Context-aware, but trust-boundaried** — The AI receives the user's existing permission rules, CLAUDE.md, and gatekeeper policy to make informed decisions. Only the operator's own global `GATEKEEPER_POLICY.md` is treated as authoritative instructions; everything a project (or a malicious repo) could write — project policy, CLAUDE.md files, project settings — is passed as untrusted data that can raise suspicion but can never justify an approval. See `prompt.ts` below.
5. **Transparent** — Every decision is logged to a human-readable audit file and a JSONL sink with timestamps, reasoning, confidence scores, and (for AI evaluations) cost. A local dashboard reads that log to show decisions and cost totals in real time.

## Data Flow

> Note: This diagram shows the pipeline as run by the **actor** hook for **allow-or-ask** mode (see Overview). Both `PermissionRequest` and `PreToolUse` fire for every tool call, but only the mode's actor runs this pipeline — the non-actor hook exits immediately (no output), which is what prevents the AI from evaluating the same request twice. In **hands-free** mode, the actor is `PreToolUse`: "escalate" below becomes "deny with reason" and "exit 0 / no output" becomes a deny JSON response.

```
                    ┌─────────────────────────┐
                    │  Claude Code triggers    │
                    │  PermissionRequest hook  │
                    │  (JSON on stdin)         │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Parse stdin JSON         │
                    │  (HookInput type)         │
                    │  On failure: escalate     │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Load config              │
                    │  (~/.claude/claude-      │
                    │   gatekeeper/config.json) │
                    │  On failure: use defaults │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Interactive tool?        │
                    │  (e.g. AskUserQuestion)   │
                    │  Not an access request —  │
                    │  supervised: exit 0 (user │
                    │  answers); hands-free:    │
                    │  deny w/ "decide yourself"│
                    └────────────┬─────────────┘
                                 │ (not interactive)
                    ┌────────────▼─────────────┐
                    │  Check permission lists   │
                    │  (permissions.ts)         │
                    │  User's allow/deny/ask    │
                    │  lists from settings.json │
                    └─────┬──────┬─────────────┘
                          │      │
                       allow   deny/ask
                    (exit 0)     │
                                 └─▶ escalate (allow-or-ask) / deny (hands-free)
                                 │ (no match)
                    ┌────────────▼─────────────┐
                    │  Check static rules       │
                    │  (rules.ts)               │
                    │  alwaysEscalate patterns  │
                    │  alwaysApprove patterns   │
                    └─────┬──────┬──────┬──────┘
                          │      │      │
                     escalate evaluate approve
                          │      │      │
                     (exit 0)    │   (JSON stdout)
                     no output   │
                                 │
                    ┌────────────▼─────────────┐
                    │  Resolve project dir      │
                    │  (project-dir.ts)         │
                    │  Load context             │
                    │  (context.ts)             │
                    │  - User settings          │
                    │  - Project settings       │
                    │  - CLAUDE.md files         │
                    │  - GATEKEEPER_POLICY.md   │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Build AI prompt          │
                    │  (prompt.ts)              │
                    │  Trusted system prompt +  │
                    │  untrusted context block  │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  AI Evaluation            │
                    │  (evaluator.ts)           │
                    │  Backend: CLI or API      │
                    │  Returns: decision,       │
                    │  confidence, reasoning,   │
                    │  cost                     │
                    └─────┬────────────┬───────┘
                          │            │
                   confidence ≥    confidence <
                   threshold       threshold
                          │            │
                     (JSON stdout)  (exit 0)
                     auto-approve   no output
                                    show prompt
```

Every terminal outcome above (approve, escalate, deny) is also logged via `logger.ts`, and escalations may additionally trigger a desktop notification (`desktop-notify.ts`) and/or a remote push-approval round trip (`notify.ts`) before the hook exits.

### Dashboard & cost tracking (out-of-band)

The dashboard (`dashboard.ts`, optionally kept running via `daemon.ts`) is **not** part of the hook path above — it's a separate local process that only *reads* the JSONL decision log:

- Serves a read-only web UI plus a live SSE stream of decisions by tailing `decisions.jsonl` (the file `logger.ts` writes on every decision).
- Exposes small control/cost/pattern APIs (`/api/status`, `/api/costs`, `/api/patterns`, `/api/enable`, `/api/disable`, `/api/mode`); mutating endpoints require a per-process random token minted at server start.
- Computes cost totals via `logger.ts`'s `aggregateCosts()` from the `costUsd` field captured on each AI evaluation.

Because it never sits between the hook and its stdout, a slow, crashed, or unreachable dashboard cannot affect permission decisions.

## Module Responsibilities

### `index.ts` — Orchestrator
The main entry point, invoked for both `PermissionRequest` and `PreToolUse` hook events. Reads stdin, resolves config/mode, then runs: enabled check → interactive-tool guard → permission-list check (`permissions.ts`) → static rules (`rules.ts`) → AI evaluation (`evaluator.ts`) → decision output + logging.

Implements the **per-mode actor hook**: both hook types fire for every tool call, but exactly one of them performs the AI evaluation and logs the decision for a given mode — allow-or-ask's actor is `PermissionRequest` (non-blocking prompt UX; never denies); hands-free's actor is `PreToolUse` (must be able to deny before the tool runs). The non-actor hook defers (exit 0, no output) so the AI never evaluates the same request twice. This is a stateless function of `(mode, hookType)`, computed independently by each hook process, so the two hooks agree without any shared state.

The top-level catch-all ensures that any unhandled exception results in escalation (allow-or-ask) or denial (hands-free).

### `types.ts` — Type Definitions
All TypeScript interfaces shared across modules: `HookInput`, `HookOutput`, `EvaluationResult`, `ApproverConfig`, `PromptContext`, `UserSettings`, `RuleDecision`.

### `config.ts` — Configuration
Loads user config from `~/.claude/claude-gatekeeper/config.json` and merges with defaults. Validates values (clamps thresholds, validates enums). Falls back to defaults on any error.

### `context.ts` — Context Gathering
Reads files that provide context for the AI prompt:
- `~/.claude/settings.json` — user's permission rules
- `<cwd>/.claude/settings.json` — project permission rules
- `~/.claude/CLAUDE.md` — global instructions
- `<cwd>/CLAUDE.md` — project instructions
- `<cwd>/GATEKEEPER_POLICY.md` or `<cwd>/.claude/GATEKEEPER_POLICY.md` — project-specific gatekeeper rules

All reads are best-effort (missing files return null). CLAUDE.md content is truncated to `maxContextLength`.

### `project-dir.ts` — Project Directory Resolution
Resolves the real project directory from `transcript_path` rather than trusting `cwd`, because Claude Code subagents sometimes report `/private/tmp` as their working directory. Decodes Claude Code's lossy project-slug encoding (`~/.claude/projects/<slug>/`) via a greedy filesystem walk, falling back to `cwd` if decoding fails. Called by `index.ts` before `context.ts`/`prompt.ts` so the AI sees the correct project's CLAUDE.md and GATEKEEPER_POLICY.md.

### `permissions.ts` — Claude Code Permission List Matching
Replicates Claude Code's own allow/deny/ask permission-list matching (`~/.claude/settings.json`) ahead of the AI, since `PreToolUse` fires before Claude Code's built-in permission check runs. For Bash, compound commands are split into segments (reusing `rules.ts`'s splitter): a deny/ask match on *any* segment blocks the whole command, while an allow match requires *all* segments to be allow-listed (and is suppressed if command substitution is detected, as defense-in-depth). Returns `allow` (skip evaluation entirely), `deny` (with a reason — surfaced as a hands-free deny or a supervised escalation), or `none` (fall through to static rules/AI).

### `rules.ts` — Static Pattern Matching
Checks the command/file/URL against `alwaysEscalatePatterns` and `alwaysApprovePatterns` using simple wildcard matching. For Bash commands, it splits compound commands (pipes, &&, ;) and checks each segment individually.

Uses a custom wildcard matcher (not minimatch) because commands contain `/` characters and spaces that minimatch's file-path-oriented `*` doesn't handle correctly.

### `prompt.ts` — AI Prompt Construction & Trust Boundary
Builds the system prompt (security evaluator instructions for the current mode) and user message (tool details + context). This is where the trust boundary is enforced: the system prompt only ever carries the fixed evaluator instructions plus the operator's **global** `GATEKEEPER_POLICY.md` (`~/.claude/claude-gatekeeper/GATEKEEPER_POLICY.md`) — the one policy file a project cannot write — appended as an "Authoritative Global Policy" section. Everything a project (or a malicious repo) could influence — the **project** `GATEKEEPER_POLICY.md`, all CLAUDE.md files, and project/user settings — is placed in a clearly delimited `UNTRUSTED CONTEXT` block in the user message instead. The system prompt explicitly tells the model that block is data, not instructions: it may only increase suspicion (push toward escalate/deny), and can never be the basis for an approval. An attempt by untrusted content to instruct the model or claim pre-approval is itself grounds to escalate/deny.

### `evaluator.ts` — AI Evaluation
Two backends, both reached through `evaluate()`:

1. **CLI backend** (`claude -p --model <model> --system-prompt ... --allowedTools ''`, default): Spawns the Claude CLI as a subprocess with tools explicitly disabled (`--allowedTools ''`) and session persistence off, so the evaluator itself can never call tools or leave a session behind — it can only return a decision. Piggybacks on the user's existing Claude Code OAuth authentication; no API key needed.

2. **API backend** (optional): Uses `@anthropic-ai/sdk` directly with `ANTHROPIC_API_KEY`. Faster than CLI (no CLI startup overhead). Lazy-imported to avoid loading the SDK when not needed.

Both backends parse the AI response fail-safe (`parseAiResponse`): if it isn't valid JSON with a recognized `decision`, the result defaults to `escalate` (never `approve`) with low confidence. Timeouts (subprocess kill for CLI, `AbortController` for API) are retried once, then also default to escalate. The CLI backend captures `total_cost_usd` from the CLI's JSON output into `EvaluationResult.costUsd` for cost tracking; the API backend currently leaves `costUsd` undefined.

### `logger.ts` — Audit Logging & Cost Aggregation
Appends every decision to two sinks: a human-readable text log (timestamp, decision, confidence, model, latency, tool, input summary, reasoning) and a JSONL log (`decisions.jsonl`, derived from the configured log file path) carrying the same fields structured, plus `session` and `costUsd`. Logging failures are always silently swallowed — a broken log must never break the hook.

Also provides the read side used by the dashboard: `readDecisions()` parses the JSONL file into sequence-numbered records (skipping malformed lines), and `aggregateCosts()` sums `costUsd` into day/week/month buckets (local time).

### `notify.ts` — Remote Push Approval (ntfy.sh)
Optional remote-approval channel for allow-or-ask escalations, active only when `config.notify.topic` is set. Publishes an ntfy.sh notification with Approve/Deny action buttons, each carrying a random per-request nonce, then listens on an SSE response topic for the reply and validates the nonce before honoring it. Falls back to a normal escalation on send failure, timeout, or an invalid/missing nonce. Sends a follow-up confirmation notification once a decision lands, and supports a bearer token for private ntfy servers.

### `desktop-notify.ts` — Local Desktop Notification (escalation only)
Fires a local desktop notification whenever a request is escalated (never on approve/deny), if `config.escalationNotifyCommand` is set. Spawns the configured command detached and passes request details (`GATEKEEPER_TOOL`, `GATEKEEPER_INPUT`, `GATEKEEPER_REASON`, `GATEKEEPER_CWD`) via environment variables rather than string-interpolating them into the shell command, avoiding injection. Best-effort and non-blocking — all errors are swallowed.

### `patterns.ts` — Escalate/Approve Pattern Editor
Backend for viewing and editing the user's `alwaysEscalatePatterns`/`alwaysApprovePatterns` in `config.json`, used by the dashboard's pattern editor. `sanitizePatterns()` is the authoritative validator — checking pattern length, wildcard count, control characters, total pattern count, and (for approve patterns) rejecting an all-wildcard pattern that would approve everything — since it's the last line of defense before dashboard input is persisted and later compiled into regexes by `rules.ts`. Config-merge semantics matter here: escalate patterns in `config.json` are *additions* merged with the built-in defaults at load time, while approve patterns *replace* the (empty) default list entirely.

### `dashboard.ts` — Local Web Dashboard
A localhost-only (`127.0.0.1`) HTTP server for viewing gatekeeper decisions in real time and controlling the gatekeeper:
- `GET /api/status`, `/api/decisions`, `/api/costs`, `/api/patterns` — read-only.
- `GET /api/stream` — Server-Sent Events; tails `decisions.jsonl` via `fs.watch` and replays backlog (using `Last-Event-ID` for reconnect catch-up).
- `POST /api/enable`, `/api/disable`, `/api/mode`, `/api/patterns` — mutating; require a per-process random token (`X-Gatekeeper-Token`) generated at startup and injected into the served HTML, so only the page the server rendered can call them.

Every request is also checked against the `Host` header (`isLocalhost()`) as a DNS-rebinding guard, independent of the token check.

### `daemon.ts` — Dashboard Background Process
Runs the dashboard as a detached, pidfile-tracked background process (`~/.claude/claude-gatekeeper/dashboard.pid`) for `dashboard daemon start|stop|status|restart`. Deliberately a plain user-session process, **not** a launchd LaunchAgent/login item — on corporate MDM/EDR-managed Macs, launchd persistence (`KeepAlive` + login item) is often flagged as malware and killed. It stops on logout or an explicit `stop`, with no auto-restart and no system-level persistence.

### `status.ts` — Status Reporting
Reads hook registration (`~/.claude/settings.json`) and config to report whether `PermissionRequest`/`PreToolUse` hooks are registered, whether the gatekeeper is enabled, current mode/backend/model/threshold, policy file presence, and notification config. Exposes a human-readable form (`getStatusText()`, used by the `status` CLI command and `ai-help`) and a structured form (`getStatusData()`, used by `dashboard.ts`'s `/api/status`).

### `cli.ts` — CLI Entry Point
Commander.js CLI (`claude-gatekeeper <command>`) with subcommands: `setup`, `status`, `mode`, `enable`, `disable`, `notify setup|test|disable`, `dashboard` (with nested `dashboard daemon start|stop|status|restart`), `uninstall`, `ai`, and `help`. Running with no subcommand — or an unrecognized one, which is redirected to help — invokes the hidden default `hook` command, which calls `index.ts`'s `main()` to read stdin and run as a hook; this is what Claude Code actually invokes.

### Supporting modules & CLI commands
Thin layers over the core, mostly driven by `cli.ts`:
- `setup.ts` / `uninstall.ts` — register / unregister the `PermissionRequest` **and** `PreToolUse` hooks in `~/.claude/settings.json` and scaffold or remove the config + global policy.
- `mode.ts` / `enable.ts` — write `mode` / `enabled` changes to `config.json`.
- `notify-setup.ts` — interactive wizard that generates a random ntfy topic, guides phone setup, sends test/approval notifications, and persists the `notify` config.
- `ai-help.ts` — launches an interactive Claude session preloaded with gatekeeper context (the `ai` command).
- `cli-prompt.ts` — buffered `readline` helpers for the interactive wizards.
- `fs-utils.ts` — JSON read/write helpers; `writeJson` is atomic (temp file + `rename`) so a hook reading config never sees a partially-written file.

## Hook Protocol

### PermissionRequest (allow-or-ask actor)

| Hook behavior | Exit code | Stdout | Result |
|--------------|-----------|--------|--------|
| Auto-approve | 0 | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` | Command executes immediately |
| Escalate | 0 | (empty) | Normal permission prompt appears |
| Block | 2 | (any) | Command is blocked (we never use this) |
| Error | non-0/2 | (any) | Normal permission prompt appears |

### PreToolUse (hands-free actor; also fires as the non-actor pass-through in both modes)

| Hook behavior | Exit code | Stdout | Result |
|--------------|-----------|--------|--------|
| Auto-approve | 0 | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}` | Tool runs immediately |
| Deny (uncertain, dangerous, or internal error) | 0 | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` | Tool is blocked; the reason is shown to Claude, which may try an alternative |
| Non-actor pass-through | 0 | (empty) | No-op — the other hook is the mode's actor and already decided |

## Performance

| Path | Latency | When |
|------|---------|------|
| Permission-list hit | ~60ms | Command matches the user's allow/deny/ask list (`permissions.ts`) |
| Static rule hit | ~60ms | Command matches always-escalate or always-approve pattern |
| CLI backend | 2-5s | AI evaluation via `claude -p` |
| API backend | 0.6-2s | AI evaluation via direct API |
| Error fallback | <100ms | Parse error, config error, etc. |

All latencies are acceptable vs the 2-10 seconds a user typically takes to read and approve a prompt manually.

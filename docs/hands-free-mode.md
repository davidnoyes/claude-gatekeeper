# Hands-Free Mode — Design Document

## Overview

Hands-free mode allows Claude Gatekeeper to operate without a human in the loop. Instead of escalating uncertain/dangerous commands to the user, it **denies** them with a reason that Claude can see and act on.

## Approach: Dual-Hook with a Per-Mode Actor

- **PermissionRequest hook** — for approve (works reliably)
- **PreToolUse hook** — for deny in hands-free mode (deny actually works here, unlike PermissionRequest)

Both hooks point to the same `bin/gatekeeper` binary. The hook type is detected from `hook_event_name` in the stdin JSON. **Both hooks fire for every tool call**, so the process needs a way to avoid evaluating (and logging) the same command twice.

The fix is a per-mode **actor** hook: exactly one hook type runs the AI evaluation for a given mode; the other defers (exits 0, no output) and lets the actor decide.

- `allow-or-ask` → the actor is **PermissionRequest**. It can approve or step aside so the interactive prompt shows; it never denies. The non-actor (`PreToolUse`) defers immediately, preserving the non-blocking-prompt UX.
- `hands-free` (and the future `full` mode, see below) → the actor is **PreToolUse**, because it must be able to deny before the tool runs. `PermissionRequest` still runs first for these modes and handles the static interactive-question and permission-list safety backstops (so a risky question or a deny/ask-listed command can never silently slip through before the actor gets a turn) — but it defers the static-rule + AI evaluation to `PreToolUse`, so the AI runs exactly once per command.

The actor is also the sole point that calls `logDecision`, so each decision is recorded exactly once despite both hooks firing.

This is a stateless `f(mode, hookType)` computed independently in each hook process from the loaded config — the two hook invocations agree on who the actor is without any shared state between them.

### Looking ahead: `full` mode

`GATEKEEPER_MODES` currently only has `allow-or-ask` and `hands-free` (`claude-gatekeeper mode full` errors with "not yet available" — see `src/mode.ts`). The actor model above was built to generalize: a future `full` mode (approve/deny/ask, presumably with more nuanced escalation than a flat deny) only needs to join the `hands-free` side of the `AI_ACTOR` branch in `src/index.ts` — `PreToolUse` as its actor, `PermissionRequest` still running the interactive-question and permission-list backstops. No new hook plumbing is required.

## Why PreToolUse for Deny

PermissionRequest hook `deny` is broken (GitHub issue #19298) — Claude Code ignores the deny decision and shows the interactive prompt anyway. PreToolUse hook deny works correctly and feeds `permissionDecisionReason` back to Claude, enabling the AI to adjust its approach.

## Protocol

### PreToolUse Output (hands-free mode)

Allow:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow"
  }
}
```

Deny:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "This is an automated deny by Claude Gatekeeper. The user is currently away and has delegated the AI gatekeeper to allow/deny commands. Reason: [reasoning]. You may attempt alternative commands."
  }
}
```

### PermissionRequest Output (unchanged)

Allow: `{ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }`
Escalate: exit 0, no output

## Config

```json
{
  "mode": "allow-or-ask"
}
```

`mode` is one of `GATEKEEPER_MODES` — currently `"allow-or-ask"` or `"hands-free"` (`"full"` is planned, see below). Default `"allow-or-ask"` (supervised mode). Toggling this in config.json — or running `claude-gatekeeper mode <mode-name>` — switches behavior without re-running setup. An unrecognized value falls back to the default.

## Decision Flow

### Fail-closed ordering

Config is loaded — and with it the mode — **before** stdin is parsed. This matters because
if stdin turns out to be malformed, the mode already known decides whether that's an
escalate or a deny:

```
Load config (never throws; falls back to defaults) -> mode known
  -> enabled === false?              -> exit 0, no output
  -> parse stdin fails?
       allow-or-ask -> exit 0 (fail-safe: escalate)
       hands-free   -> write PreToolUse deny JSON (fail-closed: deny on hook bugs)
```

### Determine the actor

Once stdin parses, the hook computes who the actor is for this mode (see "Approach"
above) and whether *this* invocation is that actor:

```
actor = (mode === 'allow-or-ask') ? PermissionRequest : PreToolUse
isActor = (hook_event_name === actor)
```

The allow-or-ask non-actor (`PreToolUse`) defers immediately here — it has nothing to do,
since `PermissionRequest` handles everything for that mode, including interactive
questions.

### Interactive tools (questions) — checked next, before static rules/AI

`AskUserQuestion` (and any future question-only tool) is not an access request, so
it never goes through static rules or AI evaluation. Both hooks reach this check
in hands-free mode (only allow-or-ask's non-actor deferred above), so it acts as a
safety backstop regardless of which invocation runs it. In hands-free mode the user
is away, so Claude is told to decide for itself unless the choice is risky; in
allow-or-ask mode the question is left for the user:

```
Interactive tool? -> hands-free  -> write PreToolUse deny JSON with "decide yourself" guidance
                  -> allow-or-ask -> exit 0 (let the user answer the question)
```

### Permission-list check — also a backstop before deferring

Next, the tool use is checked against the user's Claude Code permission lists
(allow/deny/ask), for the same reason and the same reach as the interactive-tool
check above:

```
Allow-listed?           -> exit 0 (pass through, no evaluation needed)
Deny- or ask-listed?    -> hands-free  -> write PreToolUse deny JSON with reason
                        -> allow-or-ask -> exit 0 (escalate; never auto-override an explicit choice)
```

### Non-actor defers; actor evaluates

Only after the two backstops above does the hands-free/full non-actor (`PermissionRequest`)
defer:

```
!isActor -> exit 0, no output
```

The actor — and only the actor — runs static rules and, if needed, the AI evaluation,
and is the sole place that logs the decision:

```
[actor only] static rules -> approve -> write allow JSON (PermissionRequest or PreToolUse shape)
                           -> escalate/deny -> handleEscalation
          -> [AI] -> decision:
               approve (meets confidence threshold) -> write allow JSON
               otherwise                             -> handleEscalation
```

`handleEscalation` itself branches on mode: hands-free writes a `PreToolUse` deny with
reason; allow-or-ask tries remote (ntfy) approval if configured, otherwise notifies and
exits 0 to show the interactive prompt.

## Fail-Safe Behavior

`loadConfig` never throws — on any error (missing file, bad JSON) it falls back to
defaults, which means `mode` is always known, and known *before* stdin is parsed. That
ordering is what lets a stdin parse error fail closed in hands-free mode instead of
falling back to a supervised-style escalate.

| Scenario | Supervised Mode | Hands-Free Mode |
|----------|----------------|-----------------|
| Config load failure | Escalate (silently falls back to defaults, mode: allow-or-ask) | Escalate (same fallback — a broken config can't put you *into* hands-free) |
| Stdin parse error | Escalate | **Deny** (mode was already known from config, so this fails closed too) |
| AI timeout | Escalate | **Deny** (no human watching) |
| AI returns garbage | Escalate | **Deny** (no human watching) |
| Static rule match (dangerous pattern) | Escalate | **Deny** with reason |
| Permission deny/ask list match | Escalate | **Deny** with reason |
| Low confidence approve | Escalate | **Deny** (can't confidently approve) |
| Unhandled exception | Escalate | **Deny** (fail-closed) |

## Setup

Both hooks are always registered. Mode is controlled by config:
- `setup` registers both `PreToolUse` and `PermissionRequest` hooks
- `setup` always starts a new install in `allow-or-ask` mode and prints how to switch afterwards (`claude-gatekeeper mode <mode-name>`, which writes `mode` to config — see `src/mode.ts`)
- `uninstall` removes both hook types

## Files Changed

| File | Change |
|------|--------|
| `types.ts` | Widen `hook_event_name`, add `PreToolUseOutput`, widen `EvaluationResult.decision` to include `'deny'`, add `GATEKEEPER_MODES`/`GatekeeperMode`, add `mode` to config |
| `config.ts` | Add `mode: 'allow-or-ask'` default, validate against `GATEKEEPER_MODES` |
| `rules.ts` | `checkRules` gains `mode` param — returns `'deny'` instead of `'escalate'` in hands-free |
| `prompt.ts` | Add `SYSTEM_PROMPT_HANDS_FREE` variant, `buildPrompt` accepts `mode` |
| `evaluator.ts` | `parseAiResponse` accepts `"deny"` as valid decision |
| `index.ts` | Mode detection, per-mode actor hook, PreToolUse output functions, branching by hook type |
| `setup.ts` | Register both hooks; new installs default to allow-or-ask |
| `uninstall.ts` | Remove both hook types |
| `status.ts` | Show both hooks and mode |
| `mode.ts` | `claude-gatekeeper mode` command — view/switch mode, writes `mode` to config |
| `logger.ts` | No change (already logs decision as string) |
| `context.ts` | No change |

## Implementation Order

1. `types.ts` — widen types first
2. `config.ts` — add `mode` field
3. `rules.ts` — add mode parameter
4. `prompt.ts` — add hands-free prompt variant
5. `evaluator.ts` — accept `"deny"` in parser
6. `index.ts` — wire it all together, including the per-mode actor hook
7. `setup.ts` / `uninstall.ts` / `status.ts` / `mode.ts` — CLI changes
8. Tests

# Installation

## Prerequisites

- Node.js 18+
- Claude Code installed and authenticated
- (Optional) `ANTHROPIC_API_KEY` for the faster API backend

## Step 1: Build

```bash
cd /path/to/claude-gatekeeper
nvm exec npm install
nvm exec npm run build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

## Step 2: Register the Hooks

`claude-gatekeeper setup` (see Step 2a below) registers **two** hooks in your `~/.claude/settings.json`: `PermissionRequest` (the main gate) and `PreToolUse` (needed for actor-hook-model coverage). Both point at the same `bin/gatekeeper` binary. To do it manually instead, add both hook types:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/claude-gatekeeper/bin/gatekeeper",
            "timeout": 90
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/claude-gatekeeper/bin/gatekeeper",
            "timeout": 90
          }
        ]
      }
    ]
  }
}
```

**Important:**
- Use the **absolute path** to the `bin/gatekeeper` script
- The empty `matcher` (`""`) matches all tools — each hook fires for every relevant event
- The `timeout` of 90 (seconds — the hook `timeout` field is in seconds) is an outer backstop for a wedged process. Gatekeeper enforces its own ~90s abort internally, so on timeout the normal prompt appears (allow-or-ask) or the request is denied (hands-free).

If you already have a `hooks` section, merge the `PermissionRequest` and `PreToolUse` keys into it.

### Example: Merging with existing hooks

Before:
```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [{"type": "command", "command": "afplay /System/Library/Sounds/Glass.aiff &"}]
      }
    ]
  }
}
```

After:
```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [{"type": "command", "command": "afplay /System/Library/Sounds/Glass.aiff &"}]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/claude-gatekeeper/bin/gatekeeper",
            "timeout": 90
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/claude-gatekeeper/bin/gatekeeper",
            "timeout": 90
          }
        ]
      }
    ]
  }
}
```

### Step 2a: Or let `setup` do it for you

Instead of editing JSON by hand, run the setup wizard:

```bash
/path/to/claude-gatekeeper/bin/gatekeeper setup
```

This registers both hooks, optionally writes a default config, and optionally installs a global `GATEKEEPER_POLICY.md`. (If you ran `nvm exec npm link`, you can use `claude-gatekeeper setup` instead.)

## Step 3: (Optional) Create Gatekeeper Policy

Copy the template to your project:

```bash
cp /path/to/claude-gatekeeper/templates/GATEKEEPER_POLICY.md ./GATEKEEPER_POLICY.md
```

Edit it to match your project's specific needs.

## Step 4: (Optional) Custom Configuration

Create `~/.claude/claude-gatekeeper/config.json`:

```bash
mkdir -p ~/.claude/claude-gatekeeper
cat > ~/.claude/claude-gatekeeper/config.json << 'EOF'
{
  "confidenceThreshold": "high",
  "logLevel": "info"
}
EOF
```

See [configuration.md](configuration.md) for all options — for example `escalationNotifyCommand` to trigger a local desktop notification (e.g. `terminal-notifier`) whenever a request escalates.

## Step 5: Verify

Start a new Claude Code session and trigger a command that would normally prompt you. Check the audit log:

```bash
cat ~/.claude/claude-gatekeeper/decisions.log
```

You should see decision entries with timestamps, confidence scores, and reasoning.

## Uninstalling

Run `claude-gatekeeper uninstall` (or `bin/gatekeeper uninstall`), or do it manually:

1. Remove the `PermissionRequest` and `PreToolUse` hooks from `~/.claude/settings.json`
2. (Optional) Delete the config and log files:
   ```bash
   rm -rf ~/.claude/claude-gatekeeper
   ```

## What Else You Can Do

Once installed, `claude-gatekeeper` (or `bin/gatekeeper`) has a few more commands:

- `status` — show current installation and configuration
- `mode [name]` — view or switch operating mode (`allow-or-ask` / `hands-free`)
- `enable` / `disable` — toggle the gatekeeper without removing the hooks
- `notify setup|test|disable` — push notifications to your phone via [ntfy.sh](https://ntfy.sh) so you can approve/deny escalations remotely
- `dashboard [--port N] [--no-open]` — open a local web dashboard of decisions and cost; `dashboard daemon start|stop|status|restart` runs it as a background process (a plain session process tracked by a pidfile — **not** a launchd login item — so it doesn't get flagged as persistence on MDM/EDR-managed machines, and it doesn't auto-restart or survive logout)
- `ai` — interactive AI-assisted help for diagnosing your setup

See the [README](../README.md) for full details on each, and [configuration.md](configuration.md) for config options.

## Troubleshooting

### Hook doesn't seem to be running
- Verify the path in `~/.claude/settings.json` is correct and absolute
- Check that `bin/gatekeeper` is executable: `chmod +x bin/gatekeeper`
- Restart Claude Code (hooks are loaded at session start)

### Everything is escalating (nothing auto-approved)
- Check the log file for errors: `tail ~/.claude/claude-gatekeeper/decisions.log`
- If using CLI backend: ensure `claude` is in your PATH
- If using API backend: ensure `ANTHROPIC_API_KEY` is set
- Try lowering `confidenceThreshold` to `"medium"`

### Auto-approvals are too aggressive
- Raise `confidenceThreshold` to `"absolute"`
- Add patterns to `alwaysEscalatePatterns` in config
- Make your `GATEKEEPER_POLICY.md` more restrictive

### Want to see decisions and cost at a glance
- Run `claude-gatekeeper dashboard` for a local web view of recent decisions, or `dashboard daemon start` to keep it running in the background

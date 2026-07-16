/**
 * Desktop notification for gatekeeper escalations.
 *
 * Fires a local desktop notification (best-effort, non-blocking) when the
 * gatekeeper escalates a request to the user in allow-or-ask mode. The
 * notification command is spawned as a detached process and receives request
 * details via environment variables, so command text is never string-interpolated
 * into the shell (no injection risk).
 *
 * Only active when config.escalationNotifyCommand is set. No-op otherwise.
 */

import { spawn } from 'child_process';
import { ApproverConfig, HookInput } from './types';
import { summarizeInput } from './logger';

/**
 * Send a desktop notification for an escalation.
 * Spawns the configured command with request details in env vars.
 * Best-effort: swallows all errors — never blocks or throws.
 */
export function notifyEscalation(input: HookInput, reason: string, config: ApproverConfig): void {
  if (!config.escalationNotifyCommand || config.escalationNotifyCommand.length === 0) {
    return;
  }

  try {
    spawn('sh', ['-c', config.escalationNotifyCommand], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        GATEKEEPER_TOOL: input.tool_name,
        GATEKEEPER_INPUT: summarizeInput(input),
        GATEKEEPER_REASON: reason,
        GATEKEEPER_CWD: input.cwd,
      },
    }).unref();
  } catch {
    // Best-effort: swallow errors. Desktop notifications must never block the hook.
  }
}

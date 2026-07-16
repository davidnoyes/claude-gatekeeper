/**
 * Daemon command — run the dashboard as a session-scoped background process.
 *
 * This is deliberately a PLAIN detached user process tracked by a pidfile,
 * NOT a launchd daemon/LaunchAgent or login item. On corporate MDM/EDR-managed
 * macOS systems, launchd persistence (KeepAlive + login item) is often flagged
 * as malware and killed. A session process sidesteps that detection while still
 * allowing the dashboard to run in the background. It stops on logout or via
 * an explicit stop command — no auto-restart, no system persistence.
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, openSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Path to the daemon state file (contains JSON: { pid, port }). */
export function statePath(): string {
  return join(homedir(), '.claude', 'claude-gatekeeper', 'dashboard.pid');
}

/** Path to the daemon log file. */
export function logPath(): string {
  return join(homedir(), '.claude', 'claude-gatekeeper', 'dashboard-daemon.log');
}

/**
 * Parse daemon state from a raw state file string.
 * Returns { pid, port } if valid (port defaults to 4180 if missing/invalid).
 * Returns null if the input is null, unparseable, or contains an invalid pid.
 */
export function parseState(raw: string | null): { pid: number; port: number } | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    const pid = typeof obj.pid === 'number' ? obj.pid : parseInt(String(obj.pid), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const port = typeof obj.port === 'number' ? obj.port : parseInt(String(obj.port), 10);
    return { pid, port: Number.isInteger(port) && port > 0 ? port : 4180 };
  } catch {
    return null;
  }
}

/** Read and parse the daemon state file. Returns null if missing or invalid. */
export function readState(): { pid: number; port: number } | null {
  const path = statePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return parseState(raw);
  } catch {
    return null;
  }
}

/** Check if a process with the given PID is alive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM'; // Exists but not ours
  }
}

/** Start the dashboard daemon in the background. */
export function startDaemon(port: number): void {
  const state = readState();
  if (state && isAlive(state.pid)) {
    console.log(`\nDashboard is already running (pid ${state.pid}).`);
    console.log(`  URL: http://127.0.0.1:${state.port}\n`);
    return;
  }

  const dir = join(homedir(), '.claude', 'claude-gatekeeper');
  mkdirSync(dir, { recursive: true });

  const cliPath = join(__dirname, 'cli.js');
  const logFile = logPath();
  const out = openSync(logFile, 'a');

  const child = spawn(process.execPath, [cliPath, 'dashboard', '--no-open', '--port', String(port)], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();

  writeFileSync(statePath(), JSON.stringify({ pid: child.pid, port }) + '\n', 'utf-8');

  console.log('\nDashboard daemon started.\n');
  console.log(`  PID:  ${child.pid}`);
  console.log(`  Port: ${port}`);
  console.log(`  URL:  http://127.0.0.1:${port}`);
  console.log(`  Log:  ${logFile}`);
  console.log('');
  console.log('This is a plain background process — no login item, no auto-restart.');
  console.log('It stops on logout or with `claude-gatekeeper dashboard daemon stop`.');
  console.log('');
}

/** Stop the dashboard daemon. */
export function stopDaemon(): void {
  const state = readState();
  if (!state) {
    console.log('\nDashboard is not running (no pidfile).\n');
    return;
  }

  if (!isAlive(state.pid)) {
    try {
      unlinkSync(statePath());
    } catch {
      // Ignore
    }
    console.log('\nDashboard is not running (stale pidfile removed).\n');
    return;
  }

  try {
    process.kill(state.pid, 'SIGTERM');
    console.log(`\nStopped dashboard daemon (pid ${state.pid}).\n`);
  } catch (err) {
    console.error(`\nFailed to stop daemon (pid ${state.pid}): ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  try {
    unlinkSync(statePath());
  } catch {
    // Ignore
  }
}

/** Show daemon status. */
export function daemonStatus(): void {
  const state = readState();
  const running = state && isAlive(state.pid);

  console.log('\nDashboard Daemon Status');
  console.log('=======================\n');

  console.log(`  Running:  ${running ? 'yes' : 'no'}`);
  if (running && state) {
    console.log(`  PID:      ${state.pid}`);
    console.log(`  Port:     ${state.port}`);
    console.log(`  URL:      http://127.0.0.1:${state.port}`);
  }
  console.log(`  Log:      ${logPath()}`);
  console.log('');

  if (!running) {
    console.log('Run `claude-gatekeeper dashboard daemon start` to start the daemon.\n');
  }
}

/** Restart the daemon (prefer the previously-stored port). */
export function restartDaemon(port: number): void {
  const state = readState();
  const preferredPort = state?.port ?? port;
  stopDaemon();
  startDaemon(preferredPort);
}

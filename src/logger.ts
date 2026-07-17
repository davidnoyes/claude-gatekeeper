/**
 * Audit logging for hook decisions.
 *
 * Every decision (approve, escalate, error) is logged to a file with
 * timestamp, tool info, confidence, reasoning, and latency. This provides
 * a complete audit trail for reviewing what was auto-approved.
 *
 * Key safety invariant: logging failures are silently swallowed.
 * A broken log file must never prevent the hook from functioning.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { ApproverConfig, EvaluationResult, HookInput } from './types';

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function timestamp(): string {
  return new Date().toISOString();
}

export function summarizeInput(input: HookInput): string {
  if (input.tool_name === 'Bash') {
    const cmd = String(input.tool_input.command || '');
    return cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd;
  }
  if (input.tool_name === 'Edit' || input.tool_name === 'Write') {
    return String(input.tool_input.file_path || '');
  }
  if (input.tool_name === 'WebFetch') {
    return String(input.tool_input.url || '');
  }
  if (input.tool_name === 'AskUserQuestion') {
    const questions = input.tool_input.questions as Array<{ question?: string }> | undefined;
    return String(questions?.[0]?.question || '').slice(0, 120);
  }
  return JSON.stringify(input.tool_input).slice(0, 120);
}

/** Derive the JSONL file path from the log file path. */
export function decisionJsonlPath(logFile: string): string {
  return logFile.replace(/\.log$/, '.jsonl') + (logFile.endsWith('.log') ? '' : '.jsonl');
}

export function logDecision(
  input: HookInput,
  result: EvaluationResult,
  config: ApproverConfig
): void {
  if (config.logLevel === 'warn') return;

  try {
    ensureDir(config.logFile);
    const summary = summarizeInput(input);
    const line = `[${timestamp()}] decision=${result.decision} confidence=${result.confidence} model=${result.model} latency=${result.latencyMs}ms tool=${input.tool_name} input="${summary}" reasoning="${result.reasoning}"\n`;
    appendFileSync(config.logFile, line);

    // Also write to JSONL
    const jsonlPath = decisionJsonlPath(config.logFile);
    const jsonlRecord = {
      ts: timestamp(),
      decision: result.decision,
      confidence: result.confidence,
      model: result.model,
      latencyMs: result.latencyMs,
      tool: input.tool_name,
      cwd: input.cwd,
      session: input.session_name ?? input.session_id,
      input: summary,
      reasoning: result.reasoning,
      costUsd: result.costUsd,
    };
    appendFileSync(jsonlPath, JSON.stringify(jsonlRecord) + '\n');
  } catch {
    // Never break the hook if logging fails
  }
}

export function logWarning(message: string, config: ApproverConfig): void {
  try {
    ensureDir(config.logFile);
    const line = `[${timestamp()}] WARN ${message}\n`;
    appendFileSync(config.logFile, line);
  } catch {
    // Never break the hook if logging fails
  }
}

export function logError(
  input: HookInput | null,
  error: unknown,
  config: ApproverConfig
): void {
  try {
    ensureDir(config.logFile);
    const errMsg = error instanceof Error ? error.message : String(error);
    const tool = input ? `tool=${input.tool_name} ` : '';
    const line = `[${timestamp()}] ERROR ${tool}error="${errMsg}"\n`;
    appendFileSync(config.logFile, line);
  } catch {
    // Never break the hook if logging fails
  }
}

export function logDebug(message: string, config: ApproverConfig): void {
  if (config.logLevel !== 'debug') return;

  try {
    ensureDir(config.logFile);
    const line = `[${timestamp()}] DEBUG ${message}\n`;
    appendFileSync(config.logFile, line);
  } catch {
    // Never break the hook if logging fails
  }
}

/** Decision record shape (for dashboard consumption). */
export interface DecisionRecord {
  seq: number;
  ts: string;
  decision: string;
  confidence: string;
  model: string;
  latencyMs: number;
  tool: string;
  cwd: string;
  session: string;
  input: string;
  reasoning: string;
  costUsd?: number;
}

/**
 * Read decisions from JSONL file, assigning each line an absolute sequence number.
 * Returns the last `limit` records in oldest→newest order.
 * Skips malformed/unparseable lines silently.
 */
export function readDecisions(jsonlPath: string, limit: number): DecisionRecord[] {
  if (!existsSync(jsonlPath)) return [];

  try {
    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n');
    const records: DecisionRecord[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        records.push({ seq: i, ...parsed });
      } catch {
        // Skip malformed lines
      }
    }

    // Return last `limit` records
    const start = Math.max(0, records.length - limit);
    return records.slice(start);
  } catch {
    return [];
  }
}

/** Aggregated cost/count totals for a time bucket. */
export interface CostBucket {
  costUsd: number;
  count: number;
}

/**
 * Aggregate AI evaluation cost totals from the JSONL decision log into
 * day/week/month buckets (local time), relative to `now`.
 *
 * A record counts toward every bucket it falls within (e.g. today's eval
 * also counts toward this week and this month). Records without a numeric
 * `costUsd` (static/permission decisions, or older logs predating this
 * feature) are ignored.
 */
export function aggregateCosts(
  jsonlPath: string,
  now: Date = new Date()
): { day: CostBucket; week: CostBucket; month: CostBucket } {
  const day: CostBucket = { costUsd: 0, count: 0 };
  const week: CostBucket = { costUsd: 0, count: 0 };
  const month: CostBucket = { costUsd: 0, count: 0 };

  if (!existsSync(jsonlPath)) {
    return { day, week, month };
  }

  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));

  try {
    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (typeof record.costUsd !== 'number') continue;

      const d = new Date(String(record.ts));
      if (isNaN(d.getTime())) continue;

      const isToday =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      const isThisWeek = d.getTime() >= weekStart.getTime();
      const isThisMonth = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();

      if (isToday) {
        day.costUsd += record.costUsd;
        day.count += 1;
      }
      if (isThisWeek) {
        week.costUsd += record.costUsd;
        week.count += 1;
      }
      if (isThisMonth) {
        month.costUsd += record.costUsd;
        month.count += 1;
      }
    }
  } catch {
    return { day: { costUsd: 0, count: 0 }, week: { costUsd: 0, count: 0 }, month: { costUsd: 0, count: 0 } };
  }

  return { day, week, month };
}

/**
 * Pattern editor backend — read/write the user's escalate/approve pattern
 * lists in ~/.claude/claude-gatekeeper/config.json.
 *
 * Merge/replace semantics (see config.ts `mergeConfig`):
 * - alwaysEscalatePatterns in config.json holds only the user's ADDITIONS —
 *   they get MERGED with the built-in defaults at load time. The defaults
 *   themselves are immutable via this API.
 * - alwaysApprovePatterns in config.json is the FULL list — it REPLACES the
 *   default (empty) list at load time, so whatever is written here becomes
 *   the entire approve list.
 *
 * `sanitizePatterns` is the authoritative validator: the dashboard UI is
 * untrusted, and this is the last line of defense before patterns are
 * persisted and later compiled into regexes (rules.ts `wildcardMatch`).
 * It throws on any violation rather than silently coercing bad input, so
 * callers must handle rejection explicitly.
 */

import { getConfigPath } from './config';
import { readJson, writeJson } from './fs-utils';
import { existsSync, readFileSync } from 'fs';

const MAX_PATTERN_LENGTH = 500;
const MAX_WILDCARDS = 20;
const MAX_PATTERNS = 200;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const ALL_WILDCARD_RE = /^[\s*]*$/;

/**
 * Validate and normalize a list of patterns. Throws on any violation —
 * validation is authoritative, never silently coerces away problems
 * (beyond trimming and deduping).
 */
export function sanitizePatterns(input: unknown, opts?: { kind?: 'escalate' | 'approve' }): string[] {
  if (!Array.isArray(input)) {
    throw new Error('patterns must be an array');
  }

  const result: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') {
      throw new Error('each pattern must be a string');
    }

    const trimmed = item.trim();
    if (trimmed.length === 0) continue;

    if (CONTROL_CHAR_RE.test(trimmed)) {
      throw new Error(`pattern contains a newline or control character: ${JSON.stringify(trimmed)}`);
    }
    if (trimmed.length > MAX_PATTERN_LENGTH) {
      throw new Error(`pattern exceeds ${MAX_PATTERN_LENGTH} characters: ${trimmed.slice(0, 50)}...`);
    }
    const wildcardCount = (trimmed.match(/\*/g) || []).length;
    if (wildcardCount > MAX_WILDCARDS) {
      throw new Error(`pattern has too many wildcards (max ${MAX_WILDCARDS}): ${trimmed}`);
    }
    if (opts?.kind === 'approve' && ALL_WILDCARD_RE.test(trimmed)) {
      throw new Error(`pattern would auto-approve everything: ${JSON.stringify(trimmed)}`);
    }

    if (!result.includes(trimmed)) {
      result.push(trimmed);
    }
  }

  if (result.length > MAX_PATTERNS) {
    throw new Error(`too many patterns (max ${MAX_PATTERNS})`);
  }

  return result;
}

/** Read the user's raw pattern lists from config.json. Never throws — missing file/keys return []. */
export function getUserPatterns(): { escalate: string[]; approve: string[] } {
  const raw = readJson(getConfigPath());
  return {
    escalate: Array.isArray(raw?.alwaysEscalatePatterns) ? (raw!.alwaysEscalatePatterns as string[]) : [],
    approve: Array.isArray(raw?.alwaysApprovePatterns) ? (raw!.alwaysApprovePatterns as string[]) : [],
  };
}

/**
 * Validate and persist the user's escalate/approve pattern lists.
 * Sanitizes both lists first — if either is invalid, nothing is written.
 * Refuses to overwrite a config.json that exists but fails to parse as JSON,
 * so a hand-broken config is never silently clobbered.
 */
export function setUserPatterns(escalate: unknown, approve: unknown): { escalate: string[]; approve: string[] } {
  const sanitizedEscalate = sanitizePatterns(escalate, { kind: 'escalate' });
  const sanitizedApprove = sanitizePatterns(approve, { kind: 'approve' });

  const configPath = getConfigPath();
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      throw new Error('config.json is not valid JSON — fix it first');
    }
  }

  existing.alwaysEscalatePatterns = sanitizedEscalate;
  existing.alwaysApprovePatterns = sanitizedApprove;
  writeJson(configPath, existing);

  return { escalate: sanitizedEscalate, approve: sanitizedApprove };
}

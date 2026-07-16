/**
 * Checks tool uses against the user's Claude Code permission lists.
 *
 * PreToolUse hooks fire before Claude Code checks its own permissions,
 * so we replicate the check to:
 * - Skip evaluation for allow-listed commands (performance)
 * - Immediately deny deny-listed and ask-listed commands in hands-free mode
 *
 * This is best-effort. If we can't match, we fall through to AI evaluation.
 *
 * Claude Code permission format examples:
 *   "Bash(echo:*)"           → Bash commands starting with "echo"
 *   "Read(///**)"            → Read any file
 *   "WebSearch"              → Any WebSearch use
 *   "WebFetch(domain:x.com)" → WebFetch for specific domain
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { HookInput } from './types';
import { splitCompoundCommand, hasCommandSubstitution } from './rules';

interface ParsedRule {
  toolName: string;
  pattern: string | null;
}

interface PermissionLists {
  allow: string[];
  deny: string[];
  ask: string[];
}

function parseRule(rule: string): ParsedRule | null {
  const match = rule.match(/^(\w+)(?:\((.+)\))?$/);
  if (!match) return null;
  return { toolName: match[1], pattern: match[2] || null };
}

function getInputString(input: HookInput): string {
  switch (input.tool_name) {
    case 'Bash':
      return String(input.tool_input.command || '');
    case 'Write':
    case 'Edit':
    case 'Read':
    case 'Glob':
      return String(input.tool_input.file_path || input.tool_input.pattern || '');
    case 'Grep':
      return String(input.tool_input.pattern || '');
    case 'WebFetch':
      return String(input.tool_input.url || '');
    default:
      return '';
  }
}

function matchesRule(input: HookInput, pattern: string): boolean {
  const inputStr = getInputString(input);

  if (pattern === '*' || pattern === '///**') return true;

  // WebFetch domain matching
  if (input.tool_name === 'WebFetch' && pattern.startsWith('domain:')) {
    const expectedDomain = pattern.slice('domain:'.length);
    try {
      const hostname = new URL(inputStr).hostname;
      return hostname === expectedDomain || hostname.endsWith('.' + expectedDomain);
    } catch {
      return false;
    }
  }

  // "prefix:*" → starts with prefix followed by space or end
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return inputStr === prefix || inputStr.startsWith(prefix + ' ');
  }

  // Wildcard patterns like "git *push *--force*"
  if (pattern.includes('*')) {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${regexStr}$`).test(inputStr);
  }

  return inputStr === pattern;
}

function matchesAnyRule(input: HookInput, rules: string[]): string | null {
  for (const rule of rules) {
    const parsed = parseRule(rule);
    if (!parsed) continue;
    if (parsed.toolName !== input.tool_name) continue;
    if (parsed.pattern === null) return rule;
    if (matchesRule(input, parsed.pattern)) return rule;
  }
  return null;
}

function loadPermissions(): PermissionLists {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return {
      allow: settings?.permissions?.allow ?? [],
      deny: settings?.permissions?.deny ?? [],
      ask: settings?.permissions?.ask ?? [],
    };
  } catch {
    return { allow: [], deny: [], ask: [] };
  }
}

export type PermissionCheckResult =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'none' };

/**
 * Check the tool use against the user's Claude Code permission lists.
 *
 * Returns:
 * - { action: 'allow' } — command is in allow-list, skip evaluation
 * - { action: 'deny', reason } — command is in deny/ask list, deny immediately
 * - { action: 'none' } — no match, proceed to evaluation
 */
export function checkPermissions(input: HookInput): PermissionCheckResult {
  const perms = loadPermissions();

  // For Bash, check deny/ask against ALL segments (any match → deny)
  if (input.tool_name === 'Bash') {
    const command = getInputString(input);
    const segments = splitCompoundCommand(command);

    // Check deny list — any segment match OR full command match → deny
    for (const segment of segments) {
      const segmentInput: HookInput = {
        ...input,
        tool_input: { ...input.tool_input, command: segment },
      };
      const denyMatch = matchesAnyRule(segmentInput, perms.deny);
      if (denyMatch) {
        return {
          action: 'deny',
          reason: `This command is explicitly blocked by the user's deny list (matched: ${denyMatch}).`,
        };
      }
    }
    // Also check full command
    const fullDenyMatch = matchesAnyRule(input, perms.deny);
    if (fullDenyMatch) {
      return {
        action: 'deny',
        reason: `This command is explicitly blocked by the user's deny list (matched: ${fullDenyMatch}).`,
      };
    }

    // Check ask list — any segment match OR full command match → deny (no user available)
    for (const segment of segments) {
      const segmentInput: HookInput = {
        ...input,
        tool_input: { ...input.tool_input, command: segment },
      };
      const askMatch = matchesAnyRule(segmentInput, perms.ask);
      if (askMatch) {
        return {
          action: 'deny',
          reason: `This command requires user review (matched: ${askMatch}) but the user is currently away. Try a safer alternative.`,
        };
      }
    }
    // Also check full command
    const fullAskMatch = matchesAnyRule(input, perms.ask);
    if (fullAskMatch) {
      return {
        action: 'deny',
        reason: `This command requires user review (matched: ${fullAskMatch}) but the user is currently away. Try a safer alternative.`,
      };
    }

    // Allow list — ALL segments must match
    // Command substitution detection: suppress allow-list fast path (defense-in-depth)
    if (hasCommandSubstitution(command)) {
      return { action: 'none' };
    }
    // Check each segment individually against allow rules
    const allSegmentsAllowed = segments.every(segment => {
      const segmentInput: HookInput = {
        ...input,
        tool_input: { ...input.tool_input, command: segment },
      };
      return matchesAnyRule(segmentInput, perms.allow) !== null;
    });
    if (allSegmentsAllowed && segments.length > 0) {
      return { action: 'allow' };
    }
  } else {
    // Non-Bash tools: keep original behavior (whole-input matching)
    const denyMatch = matchesAnyRule(input, perms.deny);
    if (denyMatch) {
      return {
        action: 'deny',
        reason: `This command is explicitly blocked by the user's deny list (matched: ${denyMatch}).`,
      };
    }

    const askMatch = matchesAnyRule(input, perms.ask);
    if (askMatch) {
      return {
        action: 'deny',
        reason: `This command requires user review (matched: ${askMatch}) but the user is currently away. Try a safer alternative.`,
      };
    }

    const allowMatch = matchesAnyRule(input, perms.allow);
    if (allowMatch) {
      return { action: 'allow' };
    }
  }

  return { action: 'none' };
}

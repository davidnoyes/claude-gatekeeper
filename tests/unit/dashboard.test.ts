/**
 * Unit tests for dashboard helpers.
 */

import { isLocalhost, hasValidToken, parseDecisionLine } from '../../src/dashboard';
import { readDecisions, decisionJsonlPath } from '../../src/logger';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('isLocalhost', () => {
  it('accepts localhost', () => {
    expect(isLocalhost('localhost')).toBe(true);
    expect(isLocalhost('localhost:4180')).toBe(true);
  });

  it('accepts 127.0.0.1', () => {
    expect(isLocalhost('127.0.0.1')).toBe(true);
    expect(isLocalhost('127.0.0.1:4180')).toBe(true);
  });

  it('rejects other hosts', () => {
    expect(isLocalhost('example.com')).toBe(false);
    expect(isLocalhost('10.0.0.1')).toBe(false);
    expect(isLocalhost('attacker.com')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isLocalhost(undefined)).toBe(false);
  });
});

describe('hasValidToken', () => {
  const token = 'secret123';

  it('returns true when token matches', () => {
    expect(hasValidToken({ 'x-gatekeeper-token': 'secret123' }, token)).toBe(true);
  });

  it('returns false when token missing', () => {
    expect(hasValidToken({}, token)).toBe(false);
  });

  it('returns false when token wrong', () => {
    expect(hasValidToken({ 'x-gatekeeper-token': 'wrong' }, token)).toBe(false);
  });
});

describe('parseDecisionLine', () => {
  it('parses valid JSON and assigns seq', () => {
    const line = '{"decision":"approve","tool":"Bash"}';
    const result = parseDecisionLine(line, 42);
    expect(result).toEqual({ seq: 42, decision: 'approve', tool: 'Bash' });
  });

  it('returns null for malformed JSON', () => {
    expect(parseDecisionLine('not json', 0)).toBe(null);
    expect(parseDecisionLine('', 0)).toBe(null);
  });
});

describe('decisionJsonlPath', () => {
  it('replaces .log with .jsonl', () => {
    expect(decisionJsonlPath('/var/log/decisions.log')).toBe('/var/log/decisions.jsonl');
  });

  it('appends .jsonl if not ending in .log', () => {
    expect(decisionJsonlPath('/var/log/decisions')).toBe('/var/log/decisions.jsonl');
  });
});

describe('readDecisions', () => {
  let tmpFile: string;

  beforeAll(() => {
    const tmpDir = join(tmpdir(), `gatekeeper-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    tmpFile = join(tmpDir, 'test.jsonl');
  });

  it('returns empty array for missing file', () => {
    expect(readDecisions('/nonexistent/file.jsonl', 10)).toEqual([]);
  });

  it('reads valid records with seq', () => {
    writeFileSync(tmpFile, '{"decision":"approve","tool":"Bash"}\n{"decision":"deny","tool":"Write"}\n');
    const records = readDecisions(tmpFile, 10);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ seq: 0, decision: 'approve', tool: 'Bash' });
    expect(records[1]).toMatchObject({ seq: 1, decision: 'deny', tool: 'Write' });
  });

  it('skips malformed lines', () => {
    writeFileSync(tmpFile, '{"valid":1}\nBAD LINE\n{"valid":2}\n');
    const records = readDecisions(tmpFile, 10);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ seq: 0, valid: 1 });
    expect(records[1]).toMatchObject({ seq: 2, valid: 2 });
  });

  it('respects limit', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `{"n":${i}}`).join('\n') + '\n';
    writeFileSync(tmpFile, lines);
    const records = readDecisions(tmpFile, 3);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ seq: 7, n: 7 });
    expect(records[2]).toMatchObject({ seq: 9, n: 9 });
  });

  it('handles blank lines', () => {
    writeFileSync(tmpFile, '{"a":1}\n\n{"b":2}\n\n\n');
    const records = readDecisions(tmpFile, 10);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ seq: 0, a: 1 });
    expect(records[1]).toMatchObject({ seq: 2, b: 2 });
  });
});

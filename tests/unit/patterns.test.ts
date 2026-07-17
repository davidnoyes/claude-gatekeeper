import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sanitizePatterns, getUserPatterns, setUserPatterns } from '../../src/patterns';
import { loadConfig } from '../../src/config';

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `gatekeeper-patterns-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  configPath = join(tmpDir, 'config.json');
  process.env.CLAUDE_GATEKEEPER_CONFIG = configPath;
});

afterEach(() => {
  delete process.env.CLAUDE_GATEKEEPER_CONFIG;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('sanitizePatterns', () => {
  it('trims whitespace and dedupes', () => {
    expect(sanitizePatterns(['  foo  ', 'foo', 'bar'])).toEqual(['foo', 'bar']);
  });

  it('drops empty/whitespace-only entries', () => {
    expect(sanitizePatterns(['foo', '   ', ''])).toEqual(['foo']);
  });

  it('throws on non-array input', () => {
    expect(() => sanitizePatterns('foo')).toThrow();
    expect(() => sanitizePatterns(null)).toThrow();
    expect(() => sanitizePatterns(undefined)).toThrow();
    expect(() => sanitizePatterns({})).toThrow();
  });

  it('throws on non-string element', () => {
    expect(() => sanitizePatterns(['foo', 123])).toThrow();
    expect(() => sanitizePatterns([{ a: 1 }])).toThrow();
  });

  it('throws on a pattern with a newline or control char', () => {
    expect(() => sanitizePatterns(['foo\nbar'])).toThrow();
    expect(() => sanitizePatterns(['foo\x00bar'])).toThrow();
    expect(() => sanitizePatterns(['foo\x7fbar'])).toThrow();
  });

  it('throws on a pattern longer than 500 chars', () => {
    const longPattern = 'a'.repeat(501);
    expect(() => sanitizePatterns([longPattern])).toThrow();
    expect(() => sanitizePatterns(['a'.repeat(500)])).not.toThrow();
  });

  it('throws on a pattern with more than 20 wildcards', () => {
    const manyStars = '*'.repeat(21);
    expect(() => sanitizePatterns([manyStars])).toThrow();
    expect(() => sanitizePatterns(['*'.repeat(20)])).not.toThrow();
  });

  it('throws when resulting array has more than 200 entries', () => {
    const many = Array.from({ length: 201 }, (_, i) => `pattern-${i}`);
    expect(() => sanitizePatterns(many)).toThrow();
    const exactly200 = Array.from({ length: 200 }, (_, i) => `pattern-${i}`);
    expect(() => sanitizePatterns(exactly200)).not.toThrow();
  });

  it("kind 'approve' rejects all-wildcard/whitespace patterns", () => {
    expect(() => sanitizePatterns(['*'], { kind: 'approve' })).toThrow();
    expect(() => sanitizePatterns(['  '], { kind: 'approve' })).not.toThrow(); // dropped as empty, no throw
    expect(() => sanitizePatterns(['**'], { kind: 'approve' })).toThrow();
    expect(() => sanitizePatterns([' * * '], { kind: 'approve' })).toThrow();
  });

  it("kind 'escalate' allows a broad '*' pattern", () => {
    expect(sanitizePatterns(['*'], { kind: 'escalate' })).toEqual(['*']);
  });
});

describe('setUserPatterns / getUserPatterns', () => {
  it('writes both arrays and preserves other config keys', () => {
    writeFileSync(configPath, JSON.stringify({
      enabled: true,
      mode: 'hands-free',
      escalationNotifyCommand: 'terminal-notifier -title "Test"',
    }));

    const result = setUserPatterns(['esc-pattern'], ['app-pattern']);
    expect(result).toEqual({ escalate: ['esc-pattern'], approve: ['app-pattern'] });

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.enabled).toBe(true);
    expect(written.mode).toBe('hands-free');
    expect(written.escalationNotifyCommand).toBe('terminal-notifier -title "Test"');
    expect(written.alwaysEscalatePatterns).toEqual(['esc-pattern']);
    expect(written.alwaysApprovePatterns).toEqual(['app-pattern']);

    const roundTripped = getUserPatterns();
    expect(roundTripped).toEqual({ escalate: ['esc-pattern'], approve: ['app-pattern'] });
  });

  it('getUserPatterns returns empty arrays when config file does not exist', () => {
    expect(getUserPatterns()).toEqual({ escalate: [], approve: [] });
  });

  it('refuses to overwrite a config file with invalid JSON', () => {
    writeFileSync(configPath, '{ not json');

    expect(() => setUserPatterns([], [])).toThrow('config.json is not valid JSON');

    // File content must be unchanged
    expect(readFileSync(configPath, 'utf-8')).toBe('{ not json');
  });

  it('propagates validation errors without writing anything', () => {
    writeFileSync(configPath, JSON.stringify({ enabled: true }));
    const before = readFileSync(configPath, 'utf-8');

    expect(() => setUserPatterns([123], [])).toThrow();
    expect(readFileSync(configPath, 'utf-8')).toBe(before);

    expect(() => setUserPatterns([], ['*'])).toThrow();
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('loadConfig merges written escalate patterns with defaults', () => {
    setUserPatterns(['my-custom-escalate'], ['my-approve']);

    const config = loadConfig();
    expect(config.alwaysEscalatePatterns).toContain('my-custom-escalate');
    expect(config.alwaysEscalatePatterns).toContain('sudo *'); // default preserved
    expect(config.alwaysApprovePatterns).toEqual(['my-approve']);
  });
});

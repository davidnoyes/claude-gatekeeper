import { logDecision, logWarning, logError, logDebug, decisionJsonlPath, readDecisions, aggregateCosts } from '../../src/logger';
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ApproverConfig, EvaluationResult, HookInput } from '../../src/types';

jest.mock('fs');

const mockAppendFileSync = appendFileSync as jest.MockedFunction<typeof appendFileSync>;
const mockMkdirSync = mkdirSync as jest.MockedFunction<typeof mkdirSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;

const baseConfig: ApproverConfig = {
  enabled: true,
  mode: 'allow-or-ask' as const,
  backend: 'cli',
  model: 'haiku',
  confidenceThreshold: 'high',
  timeoutMs: 10000,
  maxContextLength: 2000,
  logFile: '/tmp/test-decisions.log',
  logLevel: 'info',
  alwaysEscalatePatterns: [],
  alwaysApprovePatterns: [],
};

const baseInput: HookInput = {
  session_id: 'test-session',
  cwd: '/home/user/project',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
};

const baseResult: EvaluationResult = {
  decision: 'approve',
  confidence: 'high',
  reasoning: 'Safe dev command',
  model: 'cli:haiku',
  latencyMs: 1200,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockMkdirSync.mockReturnValue(undefined);
});

describe('logDecision', () => {
  it('writes a formatted log line and JSONL record', () => {
    logDecision(baseInput, baseResult, baseConfig);

    expect(mockAppendFileSync).toHaveBeenCalledTimes(2);

    // First call: text log
    const logLine = mockAppendFileSync.mock.calls[0][1] as string;
    expect(logLine).toContain('decision=approve');
    expect(logLine).toContain('confidence=high');
    expect(logLine).toContain('model=cli:haiku');
    expect(logLine).toContain('tool=Bash');
    expect(logLine).toContain('npm test');
    expect(logLine).toContain('Safe dev command');

    // Second call: JSONL
    const jsonlLine = mockAppendFileSync.mock.calls[1][1] as string;
    const parsed = JSON.parse(jsonlLine.trim());
    expect(parsed.decision).toBe('approve');
    expect(parsed.confidence).toBe('high');
    expect(parsed.tool).toBe('Bash');
    expect(parsed.input).toBe('npm test');
  });

  it('writes costUsd into the JSONL record when present', () => {
    logDecision(baseInput, { ...baseResult, costUsd: 0.0038 }, baseConfig);

    const jsonlLine = mockAppendFileSync.mock.calls[1][1] as string;
    const parsed = JSON.parse(jsonlLine.trim());
    expect(parsed.costUsd).toBe(0.0038);
  });

  it('omits costUsd from the JSONL record when absent', () => {
    logDecision(baseInput, baseResult, baseConfig);

    const jsonlLine = mockAppendFileSync.mock.calls[1][1] as string;
    const parsed = JSON.parse(jsonlLine.trim());
    expect('costUsd' in parsed).toBe(false);
  });

  it('does not log when logLevel is warn', () => {
    logDecision(baseInput, baseResult, { ...baseConfig, logLevel: 'warn' });
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('truncates long commands', () => {
    const longInput = {
      ...baseInput,
      tool_input: { command: 'x'.repeat(200) },
    };
    logDecision(longInput, baseResult, baseConfig);

    const logLine = mockAppendFileSync.mock.calls[0][1] as string;
    expect(logLine).toContain('...');
    expect(logLine.length).toBeLessThan(500);
  });

  it('summarizes Write tool input as file_path', () => {
    const writeInput: HookInput = {
      ...baseInput,
      tool_name: 'Write',
      tool_input: { file_path: '/src/index.ts', content: 'lots of code' },
    };
    logDecision(writeInput, baseResult, baseConfig);

    const logLine = mockAppendFileSync.mock.calls[0][1] as string;
    expect(logLine).toContain('/src/index.ts');
  });

  it('swallows errors silently', () => {
    mockAppendFileSync.mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => logDecision(baseInput, baseResult, baseConfig)).not.toThrow();
  });
});

describe('logWarning', () => {
  it('writes a warning line', () => {
    logWarning('API key not set', baseConfig);

    const logLine = mockAppendFileSync.mock.calls[0][1] as string;
    expect(logLine).toContain('WARN');
    expect(logLine).toContain('API key not set');
  });
});

describe('logError', () => {
  it('writes an error line with tool info', () => {
    logError(baseInput, new Error('timeout'), baseConfig);

    const logLine = mockAppendFileSync.mock.calls[0][1] as string;
    expect(logLine).toContain('ERROR');
    expect(logLine).toContain('tool=Bash');
    expect(logLine).toContain('timeout');
  });

  it('handles null input', () => {
    logError(null, new Error('startup failure'), baseConfig);

    const logLine = mockAppendFileSync.mock.calls[0][1] as string;
    expect(logLine).toContain('ERROR');
    expect(logLine).toContain('startup failure');
  });

  it('handles non-Error objects', () => {
    logError(null, 'string error', baseConfig);

    const logLine = mockAppendFileSync.mock.calls[0][1] as string;
    expect(logLine).toContain('string error');
  });
});

describe('logDebug', () => {
  it('writes when logLevel is debug', () => {
    logDebug('detailed info', { ...baseConfig, logLevel: 'debug' });
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
  });

  it('does not write when logLevel is info', () => {
    logDebug('detailed info', baseConfig);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });
});

describe('decisionJsonlPath', () => {
  it('derives JSONL path from .log file', () => {
    expect(decisionJsonlPath('/tmp/test-decisions.log')).toBe('/tmp/test-decisions.jsonl');
  });

  it('appends .jsonl if not ending in .log', () => {
    expect(decisionJsonlPath('/tmp/decisions')).toBe('/tmp/decisions.jsonl');
  });
});

describe('readDecisions', () => {
  it('returns empty array for missing file', () => {
    mockExistsSync.mockReturnValue(false);
    expect(readDecisions('/nonexistent.jsonl', 10)).toEqual([]);
  });

  it('parses JSONL records with seq', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{"decision":"approve"}\n{"decision":"deny"}\n');
    const records = readDecisions('/tmp/test.jsonl', 10);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ seq: 0, decision: 'approve' });
    expect(records[1]).toMatchObject({ seq: 1, decision: 'deny' });
  });

  it('skips malformed lines', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{"ok":1}\nBAD\n{"ok":2}\n');
    const records = readDecisions('/tmp/test.jsonl', 10);
    expect(records).toHaveLength(2);
    expect(records[0].seq).toBe(0);
    expect(records[1].seq).toBe(2);
  });

  it('respects limit', () => {
    mockExistsSync.mockReturnValue(true);
    const lines = Array.from({ length: 10 }, (_, i) => `{"n":${i}}`).join('\n') + '\n';
    mockReadFileSync.mockReturnValue(lines);
    const records = readDecisions('/tmp/test.jsonl', 3);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ seq: 7, n: 7 });
    expect(records[2]).toMatchObject({ seq: 9, n: 9 });
  });
});

describe('aggregateCosts', () => {
  // aggregateCosts reads real files via `fs`, which is mocked at the module
  // level in this file. Delegate the mocked functions to the real
  // implementation so we can exercise this suite against an actual temp
  // JSONL file (per the task brief) without touching the other suites above.
  const actualFs = jest.requireActual('fs');
  let costJsonlPath: string;

  beforeEach(() => {
    costJsonlPath = join(tmpdir(), `gatekeeper-cost-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    mockExistsSync.mockImplementation((p: unknown) => actualFs.existsSync(p));
    mockReadFileSync.mockImplementation((p: unknown, enc: unknown) => actualFs.readFileSync(p, enc));
  });

  afterEach(() => {
    try {
      unlinkSync(costJsonlPath);
    } catch {
      // ignore if never written
    }
  });

  it('returns zeroed buckets when the file is missing', () => {
    const result = aggregateCosts(join(tmpdir(), 'gatekeeper-cost-test-missing.jsonl'), new Date(2026, 6, 16, 12, 0, 0));
    expect(result).toEqual({
      day: { costUsd: 0, count: 0 },
      week: { costUsd: 0, count: 0 },
      month: { costUsd: 0, count: 0 },
    });
  });

  it('buckets records by local day/week/month with nested inclusion, ignoring records without costUsd', () => {
    // Fixed "now": Thursday 2026-07-16 (local). Week starts Monday 2026-07-13 00:00 local.
    const now = new Date(2026, 6, 16, 12, 0, 0);

    const records = [
      { ts: new Date(2026, 6, 16, 9, 0, 0).toISOString(), costUsd: 0.001 }, // today
      { ts: new Date(2026, 6, 14, 9, 0, 0).toISOString(), costUsd: 0.002 }, // earlier this week (Tue), not today
      { ts: new Date(2026, 6, 5, 9, 0, 0).toISOString(), costUsd: 0.004 },  // earlier this month, not this week
      { ts: new Date(2026, 5, 20, 9, 0, 0).toISOString(), costUsd: 0.008 }, // last month
      { ts: new Date(2026, 6, 16, 10, 0, 0).toISOString() },                // no costUsd — excluded
    ];

    actualFs.writeFileSync(costJsonlPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const result = aggregateCosts(costJsonlPath, now);

    expect(result.day).toEqual({ costUsd: 0.001, count: 1 });
    expect(result.week.count).toBe(2);
    expect(result.week.costUsd).toBeCloseTo(0.003, 10);
    expect(result.month.count).toBe(3);
    expect(result.month.costUsd).toBeCloseTo(0.007, 10);
  });
});

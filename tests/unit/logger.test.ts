import { logDecision, logWarning, logError, logDebug, decisionJsonlPath, readDecisions } from '../../src/logger';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
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

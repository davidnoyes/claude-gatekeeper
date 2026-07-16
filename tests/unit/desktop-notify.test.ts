import { notifyEscalation } from '../../src/desktop-notify';
import { ApproverConfig, HookInput } from '../../src/types';
import { spawn } from 'child_process';

jest.mock('child_process');

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

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

beforeEach(() => {
  jest.clearAllMocks();
  mockSpawn.mockReturnValue({
    unref: jest.fn(),
  } as any);
});

describe('notifyEscalation', () => {
  it('does nothing when escalationNotifyCommand is undefined', () => {
    notifyEscalation(baseInput, 'some reason', baseConfig);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('does nothing when escalationNotifyCommand is empty string', () => {
    notifyEscalation(baseInput, 'some reason', { ...baseConfig, escalationNotifyCommand: '' });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns command with sh -c when escalationNotifyCommand is set', () => {
    const config = { ...baseConfig, escalationNotifyCommand: 'terminal-notifier -title "Gatekeeper" -message "$GATEKEEPER_REASON"' };
    notifyEscalation(baseInput, 'test reason', config);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      'sh',
      ['-c', 'terminal-notifier -title "Gatekeeper" -message "$GATEKEEPER_REASON"'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        env: expect.objectContaining({
          GATEKEEPER_TOOL: 'Bash',
          GATEKEEPER_INPUT: 'npm test',
          GATEKEEPER_REASON: 'test reason',
          GATEKEEPER_CWD: '/home/user/project',
        }),
      })
    );
  });

  it('includes all environment variables from process.env', () => {
    const config = { ...baseConfig, escalationNotifyCommand: 'echo test' };
    const originalEnv = process.env.PATH;
    notifyEscalation(baseInput, 'reason', config);

    const spawnCall = mockSpawn.mock.calls[0][2];
    expect(spawnCall?.env?.PATH).toBe(originalEnv);
  });

  it('calls unref on the spawned process', () => {
    const mockUnref = jest.fn();
    mockSpawn.mockReturnValue({ unref: mockUnref } as any);

    const config = { ...baseConfig, escalationNotifyCommand: 'test-cmd' };
    notifyEscalation(baseInput, 'reason', config);

    expect(mockUnref).toHaveBeenCalledTimes(1);
  });

  it('does not throw when spawn throws', () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const config = { ...baseConfig, escalationNotifyCommand: 'test-cmd' };
    expect(() => notifyEscalation(baseInput, 'reason', config)).not.toThrow();
  });

  it('passes summarized input for WebFetch tool', () => {
    const webFetchInput: HookInput = {
      ...baseInput,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' },
    };
    const config = { ...baseConfig, escalationNotifyCommand: 'test-cmd' };
    notifyEscalation(webFetchInput, 'reason', config);

    const spawnCall = mockSpawn.mock.calls[0][2];
    expect(spawnCall?.env?.GATEKEEPER_INPUT).toBe('https://example.com');
    expect(spawnCall?.env?.GATEKEEPER_TOOL).toBe('WebFetch');
  });

  it('passes summarized input for Write tool', () => {
    const writeInput: HookInput = {
      ...baseInput,
      tool_name: 'Write',
      tool_input: { file_path: '/src/index.ts', content: 'lots of code' },
    };
    const config = { ...baseConfig, escalationNotifyCommand: 'test-cmd' };
    notifyEscalation(writeInput, 'reason', config);

    const spawnCall = mockSpawn.mock.calls[0][2];
    expect(spawnCall?.env?.GATEKEEPER_INPUT).toBe('/src/index.ts');
  });
});

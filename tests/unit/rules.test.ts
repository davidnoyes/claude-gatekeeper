import { checkRules, extractMatchTarget, splitCompoundCommand, matchesAnyPattern, hasCommandSubstitution } from '../../src/rules';
import { ApproverConfig, HookInput } from '../../src/types';

const baseConfig: ApproverConfig = {
  enabled: true,
  mode: 'allow-or-ask' as const,
  backend: 'cli',
  model: 'haiku',
  confidenceThreshold: 'high',
  timeoutMs: 10000,
  maxContextLength: 2000,
  logFile: '/tmp/test.log',
  logLevel: 'info',
  alwaysEscalatePatterns: [
    'rm -rf /*',
    'rm -rf /',
    'sudo *',
    'curl *| *sh',
    'npm publish*',
    'terraform apply*',
  ],
  alwaysApprovePatterns: [
    'echo *',
    'ls *',
  ],
};

function bashInput(command: string): HookInput {
  return {
    session_id: 'test',
    cwd: '/project',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command },
  };
}

function writeInput(filePath: string): HookInput {
  return {
    session_id: 'test',
    cwd: '/project',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: 'hello' },
  };
}

function webFetchInput(url: string): HookInput {
  return {
    session_id: 'test',
    cwd: '/project',
    hook_event_name: 'PermissionRequest',
    tool_name: 'WebFetch',
    tool_input: { url },
  };
}

describe('extractMatchTarget', () => {
  it('extracts command from Bash tool', () => {
    expect(extractMatchTarget(bashInput('npm test'))).toBe('npm test');
  });

  it('extracts file_path from Write tool', () => {
    expect(extractMatchTarget(writeInput('/src/index.ts'))).toBe('/src/index.ts');
  });

  it('extracts url from WebFetch tool', () => {
    expect(extractMatchTarget(webFetchInput('https://example.com'))).toBe('https://example.com');
  });

  it('returns JSON for unknown tools', () => {
    const input: HookInput = {
      session_id: 'test',
      cwd: '/project',
      hook_event_name: 'PermissionRequest',
      tool_name: 'CustomTool',
      tool_input: { foo: 'bar' },
    };
    expect(extractMatchTarget(input)).toBe('{"foo":"bar"}');
  });
});

describe('splitCompoundCommand', () => {
  it('splits pipe commands', () => {
    expect(splitCompoundCommand('cat file | grep foo')).toEqual(['cat file', 'grep foo']);
  });

  it('splits && chains', () => {
    expect(splitCompoundCommand('cd /tmp && rm -rf /')).toEqual(['cd /tmp', 'rm -rf /']);
  });

  it('splits || chains', () => {
    expect(splitCompoundCommand('test -f file || echo missing')).toEqual(['test -f file', 'echo missing']);
  });

  it('splits semicolons', () => {
    expect(splitCompoundCommand('echo a; echo b')).toEqual(['echo a', 'echo b']);
  });

  it('handles single command', () => {
    expect(splitCompoundCommand('npm test')).toEqual(['npm test']);
  });

  it('handles empty segments', () => {
    expect(splitCompoundCommand('echo hello |')).toEqual(['echo hello']);
  });

  it('splits single & (background)', () => {
    expect(splitCompoundCommand('sleep 10 & echo done')).toEqual(['sleep 10', 'echo done']);
  });

  it('splits newlines', () => {
    expect(splitCompoundCommand('echo a\necho b')).toEqual(['echo a', 'echo b']);
  });
});

describe('matchesAnyPattern', () => {
  it('matches glob patterns', () => {
    expect(matchesAnyPattern('sudo reboot', ['sudo *'])).toBe(true);
  });

  it('does not match non-matching patterns', () => {
    expect(matchesAnyPattern('npm test', ['sudo *'])).toBe(false);
  });

  it('returns false for empty patterns', () => {
    expect(matchesAnyPattern('anything', [])).toBe(false);
  });
});

describe('hasCommandSubstitution', () => {
  it('detects $() substitution', () => {
    expect(hasCommandSubstitution('echo $(whoami)')).toBe(true);
  });

  it('detects backtick substitution', () => {
    expect(hasCommandSubstitution('echo `whoami`')).toBe(true);
  });

  it('detects process substitution <()', () => {
    expect(hasCommandSubstitution('diff <(ls a) <(ls b)')).toBe(true);
  });

  it('detects process substitution >()', () => {
    expect(hasCommandSubstitution('tee >(grep foo)')).toBe(true);
  });

  it('returns false for clean commands', () => {
    expect(hasCommandSubstitution('echo hello')).toBe(false);
  });
});

describe('checkRules', () => {
  it('escalates dangerous commands', () => {
    expect(checkRules(bashInput('sudo rm -rf /'), baseConfig)).toBe('escalate');
    expect(checkRules(bashInput('rm -rf /'), baseConfig)).toBe('escalate');
    expect(checkRules(bashInput('npm publish'), baseConfig)).toBe('escalate');
    expect(checkRules(bashInput('terraform apply -auto-approve'), baseConfig)).toBe('escalate');
  });

  it('approves always-approve patterns', () => {
    expect(checkRules(bashInput('echo hello world'), baseConfig)).toBe('approve');
    expect(checkRules(bashInput('ls -la'), baseConfig)).toBe('approve');
  });

  it('returns evaluate for unknown commands', () => {
    expect(checkRules(bashInput('npm test'), baseConfig)).toBe('evaluate');
    expect(checkRules(bashInput('python3 script.py'), baseConfig)).toBe('evaluate');
  });

  it('escalates compound commands with dangerous segments', () => {
    expect(checkRules(bashInput('echo hello && sudo reboot'), baseConfig)).toBe('escalate');
    expect(checkRules(bashInput('cat file | sudo tee /etc/passwd'), baseConfig)).toBe('escalate');
  });

  it('approves non-Bash tools matching approve patterns', () => {
    const config = { ...baseConfig, alwaysApprovePatterns: ['/project/src/*'] };
    expect(checkRules(writeInput('/project/src/index.ts'), config)).toBe('approve');
  });

  it('escalates non-Bash tools matching escalate patterns', () => {
    const config = { ...baseConfig, alwaysEscalatePatterns: ['/etc/*'] };
    expect(checkRules(writeInput('/etc/passwd'), config)).toBe('escalate');
  });

  it('returns evaluate for unmatched non-Bash tools', () => {
    expect(checkRules(writeInput('/project/src/index.ts'), baseConfig)).toBe('evaluate');
  });

  it('does NOT approve if any segment fails to match approve pattern', () => {
    const config = { ...baseConfig, alwaysApprovePatterns: ['git *'] };
    // "git status" is approved, but "rm -rf ./x" is not → whole command returns 'evaluate'
    expect(checkRules(bashInput('git status && rm -rf ./x'), config)).toBe('evaluate');
  });

  it('approves compound command when all segments match approve pattern', () => {
    const config = { ...baseConfig, alwaysApprovePatterns: ['git *'] };
    // Both "git status" and "git log" match "git *" → approve
    expect(checkRules(bashInput('git status && git log'), config)).toBe('approve');
  });

  it('escalates compound with dangerous segment even if other segments match approve', () => {
    const config = { ...baseConfig, alwaysApprovePatterns: ['echo *'] };
    // "echo hello" matches approve pattern, but "sudo reboot" matches escalate pattern → escalate takes priority
    expect(checkRules(bashInput('echo hello && sudo reboot'), config)).toBe('escalate');
  });

  it('does NOT approve commands with command substitution', () => {
    const config = { ...baseConfig, alwaysApprovePatterns: ['echo *'] };
    expect(checkRules(bashInput('echo a$(sudo rm -rf /)'), config)).toBe('evaluate');
  });

  it('escalates dangerous segments separated by newline', () => {
    expect(checkRules(bashInput('echo safe\nsudo dangerous'), baseConfig)).toBe('escalate');
  });

  it('escalates dangerous segments separated by single &', () => {
    expect(checkRules(bashInput('npm test & sudo reboot'), baseConfig)).toBe('escalate');
  });
});

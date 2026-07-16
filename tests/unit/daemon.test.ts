import { describe, it, expect } from '@jest/globals';
import { homedir } from 'os';
import { join } from 'path';
import { statePath, logPath, parseState, isAlive } from '../../src/daemon';

describe('daemon', () => {
  describe('statePath', () => {
    it('returns the expected pidfile path', () => {
      const expected = join(homedir(), '.claude', 'claude-gatekeeper', 'dashboard.pid');
      expect(statePath()).toBe(expected);
    });
  });

  describe('logPath', () => {
    it('returns the expected log file path', () => {
      const expected = join(homedir(), '.claude', 'claude-gatekeeper', 'dashboard-daemon.log');
      expect(logPath()).toBe(expected);
    });
  });

  describe('parseState', () => {
    it('returns null for null input', () => {
      expect(parseState(null)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseState('')).toBeNull();
    });

    it('returns null for garbage input', () => {
      expect(parseState('not json')).toBeNull();
    });

    it('returns null for invalid JSON object (missing pid)', () => {
      expect(parseState('{}')).toBeNull();
    });

    it('returns null for zero pid', () => {
      expect(parseState('{"pid": 0}')).toBeNull();
    });

    it('returns null for negative pid', () => {
      expect(parseState('{"pid": -123}')).toBeNull();
    });

    it('returns null for non-numeric pid', () => {
      expect(parseState('{"pid": "abc"}')).toBeNull();
    });

    it('parses valid JSON with pid only (defaults port to 4180)', () => {
      const result = parseState('{"pid": 1234}');
      expect(result).toEqual({ pid: 1234, port: 4180 });
    });

    it('parses valid JSON with both pid and port', () => {
      const result = parseState('{"pid": 5678, "port": 8080}');
      expect(result).toEqual({ pid: 5678, port: 8080 });
    });

    it('defaults port to 4180 when port is invalid', () => {
      expect(parseState('{"pid": 100, "port": "not-a-number"}')).toEqual({ pid: 100, port: 4180 });
      expect(parseState('{"pid": 100, "port": 0}')).toEqual({ pid: 100, port: 4180 });
      expect(parseState('{"pid": 100, "port": -5}')).toEqual({ pid: 100, port: 4180 });
    });

    it('parses pid from string representation', () => {
      const result = parseState('{"pid": "999", "port": "3000"}');
      expect(result).toEqual({ pid: 999, port: 3000 });
    });
  });

  describe('isAlive', () => {
    it('returns true for the current process', () => {
      expect(isAlive(process.pid)).toBe(true);
    });

    it('returns false for an almost-certainly-unused pid', () => {
      // Use a very high PID that is almost certainly not running
      expect(isAlive(2147483646)).toBe(false);
    });
  });
});

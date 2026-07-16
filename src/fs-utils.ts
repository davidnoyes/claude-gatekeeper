import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';

/** Read and parse a JSON file, returning null on failure. */
export function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write a JSON file, creating directories as needed.
 *
 * Writes to a temp file in the same directory and then atomically renames it
 * over the target. rename(2) is atomic within a filesystem, so a concurrent
 * reader (e.g. a gatekeeper hook loading config while the dashboard toggles a
 * setting) always sees either the old or the new complete file — never a
 * truncated, half-written one.
 */
export function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

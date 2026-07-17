/**
 * Local dashboard server for viewing gatekeeper decisions in real-time.
 *
 * Provides a read-only web UI plus a small control API for enable/disable/mode.
 * Streams new decisions via SSE. Localhost-only (127.0.0.1), token-protected for mutating endpoints.
 */

import * as http from 'http';
import { randomBytes } from 'crypto';
import { readFileSync, existsSync, watch, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { getStatusData } from './status';
import { readDecisions, decisionJsonlPath, DecisionRecord, aggregateCosts } from './logger';
import { loadConfig } from './config';
import { setEnabled } from './enable';
import { setMode } from './mode';

/** Resolve templates directory (same pattern as setup.ts). */
function getTemplatesDir(): string {
  return resolve(join(__dirname, '..', 'templates'));
}

/** Security guard: check Host header for DNS rebinding protection. */
export function isLocalhost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/** Token guard predicate for mutating endpoints. */
export function hasValidToken(headers: http.IncomingHttpHeaders, token: string): boolean {
  return headers['x-gatekeeper-token'] === token;
}

/** Parse line into a decision record with sequence number. */
export function parseDecisionLine(line: string, seq: number): DecisionRecord | null {
  try {
    const parsed = JSON.parse(line);
    return { seq, ...parsed };
  } catch {
    return null;
  }
}

interface DashboardServer {
  server: http.Server;
  close: () => Promise<void>;
}

/** Create the dashboard HTTP server (testable factory). */
export function createDashboardServer(opts: { port: number }): DashboardServer {
  const token = randomBytes(16).toString('hex');
  const config = loadConfig();
  const jsonlPath = decisionJsonlPath(config.logFile);

  // SSE state
  const sseClients = new Set<http.ServerResponse>();
  let watcherActive = false;
  let fileOffset = 0;
  let lineCount = 0;
  let watcher: ReturnType<typeof watch> | null = null;

  /** Initialize tail-follow state. */
  function initTailFollow(): void {
    if (watcherActive) return;
    watcherActive = true;

    if (existsSync(jsonlPath)) {
      const content = readFileSync(jsonlPath, 'utf-8');
      fileOffset = Buffer.byteLength(content);
      lineCount = content.split('\n').filter(l => l.trim()).length;
    } else {
      fileOffset = 0;
      lineCount = 0;
    }

    startWatcher();
  }

  /** Start fs watcher for tail-follow. */
  function startWatcher(): void {
    if (watcher) return;

    const watchTarget = existsSync(jsonlPath) ? jsonlPath : dirname(jsonlPath);

    try {
      watcher = watch(watchTarget, (eventType, filename) => {
        // If watching directory, only react when the target file appears
        if (!existsSync(jsonlPath)) return;

        try {
          const stats = statSync(jsonlPath);
          const currentSize = stats.size;

          // File truncated/rotated
          if (currentSize < fileOffset) {
            fileOffset = 0;
            lineCount = 0;
          }

          // No new data
          if (currentSize <= fileOffset) return;

          // Read new bytes
          const fd = require('fs').openSync(jsonlPath, 'r');
          const newBytes = currentSize - fileOffset;
          const buffer = Buffer.allocUnsafe(newBytes);
          require('fs').readSync(fd, buffer, 0, newBytes, fileOffset);
          require('fs').closeSync(fd);

          fileOffset = currentSize;

          // Parse complete lines
          const chunk = buffer.toString('utf-8');
          const lines = chunk.split('\n');
          const partialLine = lines.pop(); // buffer incomplete trailing line

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const record = parseDecisionLine(trimmed, lineCount++);
            if (!record) continue;

            // Broadcast to all SSE clients
            const event = `id: ${record.seq}\nevent: decision\ndata: ${JSON.stringify(record)}\n\n`;
            for (const res of sseClients) {
              if (!res.writableEnded) {
                res.write(event);
              }
            }
          }
        } catch {
          // Ignore read errors (file might be being written)
        }
      });
    } catch {
      // Fallback: no watcher (static reads only)
    }
  }

  /** Stop watcher and clean up. */
  function stopWatcher(): void {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    for (const res of sseClients) {
      if (!res.writableEnded) res.end();
    }
    sseClients.clear();
  }

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // Security: DNS rebinding guard on all requests
    if (!isLocalhost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: invalid Host header');
      return;
    }

    // GET / — serve dashboard HTML
    if (method === 'GET' && url === '/') {
      const templatePath = join(getTemplatesDir(), 'dashboard.html');
      if (existsSync(templatePath)) {
        let html = readFileSync(templatePath, 'utf-8');
        html = html.replace(/__GATEKEEPER_TOKEN__/g, token);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } else {
        // Fallback if template missing during parallel dev
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><body><h1>Dashboard Template Missing</h1><p>templates/dashboard.html not found</p></body></html>`);
      }
      return;
    }

    // GET /api/status
    if (method === 'GET' && url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getStatusData()));
      return;
    }

    // GET /api/decisions?limit=N
    if (method === 'GET' && url.startsWith('/api/decisions')) {
      const limitMatch = url.match(/[?&]limit=(\d+)/);
      const limit = limitMatch ? parseInt(limitMatch[1], 10) : 200;
      const decisions = readDecisions(jsonlPath, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(decisions));
      return;
    }

    // GET /api/costs
    if (method === 'GET' && url === '/api/costs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(aggregateCosts(jsonlPath)));
      return;
    }

    // GET /api/stream — SSE
    if (method === 'GET' && url === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      // Initialize tail-follow on first SSE client
      if (!watcherActive) initTailFollow();

      // Send initial backlog or catch-up
      const lastEventId = req.headers['last-event-id'];
      const lastSeq = lastEventId ? parseInt(String(lastEventId), 10) : -1;

      if (lastSeq >= 0) {
        // Send only newer decisions
        const allDecisions = readDecisions(jsonlPath, 1000);
        for (const record of allDecisions) {
          if (record.seq > lastSeq) {
            res.write(`id: ${record.seq}\nevent: decision\ndata: ${JSON.stringify(record)}\n\n`);
          }
        }
      } else {
        // Send recent backlog (last 100)
        const recent = readDecisions(jsonlPath, 100);
        for (const record of recent) {
          res.write(`id: ${record.seq}\nevent: decision\ndata: ${JSON.stringify(record)}\n\n`);
        }
      }

      // Add to client set for live updates
      sseClients.add(res);

      // Heartbeat interval
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(': ping\n\n');
        } else {
          clearInterval(heartbeat);
        }
      }, 25000);

      // Clean up on disconnect
      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      });

      return;
    }

    // POST /api/enable
    if (method === 'POST' && url === '/api/enable') {
      if (!hasValidToken(req.headers, token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: missing or invalid token' }));
        return;
      }
      setEnabled(true);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: getStatusData() }));
      return;
    }

    // POST /api/disable
    if (method === 'POST' && url === '/api/disable') {
      if (!hasValidToken(req.headers, token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: missing or invalid token' }));
        return;
      }
      setEnabled(false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: getStatusData() }));
      return;
    }

    // POST /api/mode
    if (method === 'POST' && url === '/api/mode') {
      if (!hasValidToken(req.headers, token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: missing or invalid token' }));
        return;
      }

      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const newMode = parsed.mode;

          // Validate mode before calling setMode (which might call process.exit)
          const { GATEKEEPER_MODES } = require('./types');
          if (!newMode || !GATEKEEPER_MODES.includes(newMode as any)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Unknown mode: "${newMode}". Available: ${GATEKEEPER_MODES.join(', ')}` }));
            return;
          }

          // Apply mode change directly to avoid process.exit in setMode
          const { getConfigPath } = require('./config');
          const { readJson, writeJson } = require('./fs-utils');
          const { existsSync } = require('fs');
          const configPath = getConfigPath();
          const existing = existsSync(configPath) ? readJson(configPath) ?? {} : {};
          existing.mode = newMode;
          writeJson(configPath, existing);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: getStatusData() }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  // Listen on localhost only
  server.listen(opts.port, '127.0.0.1');

  return {
    server,
    close: async () => {
      stopWatcher();
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // server.close() waits for existing connections to end; the browser's
        // SSE/keep-alive socket never closes on its own, so force them shut or
        // the close callback (and shutdown) hangs forever.
        server.closeAllConnections();
      });
    },
  };
}

/** Start the dashboard server (CLI entry point). */
export async function startDashboard(opts: { port: number; open: boolean }): Promise<void> {
  const { server, close } = createDashboardServer(opts);

  // Surface listen failures (e.g. port already in use) with a clear message
  // instead of an uncaught crash that leaves a blank browser tab.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${opts.port} is already in use — a dashboard may already be running.`);
      console.error(`Open http://127.0.0.1:${opts.port} in your browser, or start with --port <n>.\n`);
    } else {
      console.error(`\nDashboard server error: ${err.message}\n`);
    }
    process.exit(1);
  });

  console.log(`Dashboard running at http://127.0.0.1:${opts.port}`);

  // Auto-open browser (unless --no-open)
  if (opts.open) {
    const platform = process.platform;
    if (platform === 'darwin') {
      try {
        require('child_process').spawn('open', [`http://127.0.0.1:${opts.port}`], { detached: true, stdio: 'ignore' }).unref();
      } catch {
        // Ignore if opener fails
      }
    }
  }

  // SIGINT handler
  const handleSignal = async () => {
    console.log('\nShutting down dashboard...');
    // Hard stop if close() ever stalls, so the process can never hang on exit.
    setTimeout(() => process.exit(0), 2000).unref();
    await close();
    process.exit(0);
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  // Keep the process alive
  return new Promise(() => {});
}

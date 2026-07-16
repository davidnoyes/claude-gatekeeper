/**
 * Integration tests for the dashboard server.
 */

import { createDashboardServer } from '../../src/dashboard';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as http from 'http';

const TEST_PORT = 14180;

let tmpDir: string;
let configPath: string;
let logFile: string;
let jsonlPath: string;

beforeAll(() => {
  tmpDir = join(tmpdir(), `gatekeeper-dashboard-test-${Date.now()}`);
  const configDir = join(tmpDir, '.claude', 'claude-gatekeeper');
  mkdirSync(configDir, { recursive: true });

  configPath = join(configDir, 'config.json');
  logFile = join(configDir, 'decisions.log');
  jsonlPath = join(configDir, 'decisions.jsonl');

  // Create initial config
  writeFileSync(
    configPath,
    JSON.stringify({
      enabled: true,
      mode: 'allow-or-ask',
      backend: 'cli',
      model: 'haiku',
      confidenceThreshold: 'high',
      logFile,
    })
  );

  // Set env var to use our temp config
  process.env.CLAUDE_GATEKEEPER_CONFIG = configPath;
});

afterAll(() => {
  delete process.env.CLAUDE_GATEKEEPER_CONFIG;
});

describe('Dashboard server', () => {
  let dashboardServer: Awaited<ReturnType<typeof createDashboardServer>>;

  beforeEach(() => {
    dashboardServer = createDashboardServer({ port: TEST_PORT });
  });

  afterEach(async () => {
    if (dashboardServer) {
      await dashboardServer.close();
    }
  });

  it('responds to GET /api/status', async () => {
    const status = await httpGet(`http://127.0.0.1:${TEST_PORT}/api/status`);
    const parsed = JSON.parse(status.body);
    expect(parsed.enabled).toBe(true);
    expect(parsed.mode).toBe('allow-or-ask');
    expect(parsed.backend).toBe('cli');
  });

  it('responds to GET /api/decisions', async () => {
    // Seed the jsonl file
    writeFileSync(
      jsonlPath,
      '{"ts":"2025-01-01T00:00:00.000Z","decision":"approve","tool":"Bash"}\n' +
      '{"ts":"2025-01-01T00:01:00.000Z","decision":"deny","tool":"Write"}\n'
    );

    const response = await httpGet(`http://127.0.0.1:${TEST_PORT}/api/decisions?limit=10`);
    const parsed = JSON.parse(response.body);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ seq: 0, decision: 'approve', tool: 'Bash' });
    expect(parsed[1]).toMatchObject({ seq: 1, decision: 'deny', tool: 'Write' });
  });

  it('streams decisions via SSE', async () => {
    // Seed initial decision
    writeFileSync(jsonlPath, '{"ts":"2025-01-01T00:00:00.000Z","decision":"approve","tool":"Bash"}\n');

    // Connect to SSE
    const events: string[] = [];
    const ssePromise = new Promise<void>((resolve) => {
      const req = http.get(`http://127.0.0.1:${TEST_PORT}/api/stream`, (res) => {
        res.on('data', (chunk: Buffer) => {
          events.push(chunk.toString());
          // After receiving initial event, append a new decision
          if (events.length === 1) {
            setTimeout(() => {
              writeFileSync(
                jsonlPath,
                '{"ts":"2025-01-01T00:00:00.000Z","decision":"approve","tool":"Bash"}\n' +
                '{"ts":"2025-01-01T00:01:00.000Z","decision":"deny","tool":"Write"}\n',
                { flag: 'w' }
              );
            }, 100);
          }
          // After second event, close
          if (events.length >= 2) {
            req.destroy();
            resolve();
          }
        });
      });
    });

    await ssePromise;

    // Should have received at least 2 events
    expect(events.length).toBeGreaterThanOrEqual(2);

    // Parse first event (initial backlog)
    const firstEvent = events[0];
    expect(firstEvent).toContain('event: decision');
    expect(firstEvent).toContain('id: 0');
    expect(firstEvent).toContain('"decision":"approve"');
  });

  it('reconnects with Last-Event-ID header', async () => {
    // Seed two decisions
    writeFileSync(
      jsonlPath,
      '{"ts":"2025-01-01T00:00:00.000Z","decision":"approve","tool":"Bash","seq":0}\n' +
      '{"ts":"2025-01-01T00:01:00.000Z","decision":"deny","tool":"Write","seq":1}\n'
    );

    // Connect with Last-Event-ID=0 (should only get seq > 0)
    const events: string[] = [];
    const ssePromise = new Promise<void>((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${TEST_PORT}/api/stream`,
        { headers: { 'Last-Event-ID': '0' } },
        (res) => {
          res.on('data', (chunk: Buffer) => {
            events.push(chunk.toString());
            if (events.length >= 1) {
              req.destroy();
              resolve();
            }
          });
        }
      );
    });

    await ssePromise;

    // Should only receive seq=1
    expect(events[0]).toContain('id: 1');
    expect(events[0]).toContain('"decision":"deny"');
  });

  it('rejects POST /api/enable without token', async () => {
    const response = await httpPost(`http://127.0.0.1:${TEST_PORT}/api/enable`, {}, {});
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('Forbidden');
  });

  it('accepts POST /api/enable with valid token', async () => {
    // Extract token from server's HTML response
    const htmlResponse = await httpGet(`http://127.0.0.1:${TEST_PORT}/`);
    const tokenMatch = htmlResponse.body.match(/"([a-f0-9]{32})"/);
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1];

    // Disable first
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.enabled = false;
    writeFileSync(configPath, JSON.stringify(config));

    // POST enable with token
    const response = await httpPost(
      `http://127.0.0.1:${TEST_PORT}/api/enable`,
      {},
      { 'X-Gatekeeper-Token': token }
    );
    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.status.enabled).toBe(true);

    // Verify config file updated
    const updatedConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(updatedConfig.enabled).toBe(true);
  });

  it('accepts POST /api/mode with valid token', async () => {
    // Extract token
    const htmlResponse = await httpGet(`http://127.0.0.1:${TEST_PORT}/`);
    const tokenMatch = htmlResponse.body.match(/"([a-f0-9]{32})"/);
    const token = tokenMatch![1];

    // POST mode change
    const response = await httpPost(
      `http://127.0.0.1:${TEST_PORT}/api/mode`,
      { mode: 'hands-free' },
      { 'X-Gatekeeper-Token': token }
    );
    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.status.mode).toBe('hands-free');

    // Verify config updated
    const updatedConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(updatedConfig.mode).toBe('hands-free');
  });

  it('rejects invalid mode', async () => {
    const htmlResponse = await httpGet(`http://127.0.0.1:${TEST_PORT}/`);
    const tokenMatch = htmlResponse.body.match(/"([a-f0-9]{32})"/);
    const token = tokenMatch![1];

    const response = await httpPost(
      `http://127.0.0.1:${TEST_PORT}/api/mode`,
      { mode: 'invalid-mode' },
      { 'X-Gatekeeper-Token': token }
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Unknown mode');
  });

  it('rejects non-localhost Host header', async () => {
    const response = await httpGet(`http://127.0.0.1:${TEST_PORT}/api/status`, {
      Host: 'evil.com',
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('Forbidden');
  });
});

// Helpers

interface HttpResponse {
  statusCode: number;
  body: string;
}

function httpGet(url: string, headers: Record<string, string> = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk.toString(); });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 500, body }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function httpPost(
  url: string,
  data: unknown,
  headers: Record<string, string> = {}
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', chunk => { responseBody += chunk.toString(); });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 500, body: responseBody }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * ntfy.sh push notification integration.
 *
 * Sends notifications with approve/deny action buttons when the gatekeeper
 * escalates a request in allow-or-ask mode. Listens for the user's response
 * via Server-Sent Events (SSE) on a response topic.
 *
 * Only active when config.notify.topic is set. No-op otherwise.
 */

import * as https from 'https';
import * as http from 'http';
import { randomBytes } from 'crypto';
import { ApproverConfig, HookInput } from './types';
import { summarizeInput, logDebug } from './logger';

/** Parse an SSE message body for approve/deny with nonce validation. */
export function parseSSEResponse(body: string, expectedNonce: string): 'approve' | 'deny' | null {
  const trimmed = body.trim();
  const parts = trimmed.split(':');
  if (parts.length !== 2) return null;

  const decision = parts[0].toLowerCase();
  const nonce = parts[1];

  if (nonce !== expectedNonce) return null;
  if (decision === 'approve') return 'approve';
  if (decision === 'deny') return 'deny';
  return null;
}

/** Format notification title and message from hook input. */
export function formatNotification(
  input: HookInput,
  reason: string
): { title: string; message: string } {
  const session = input.session_name ?? input.session_id.slice(0, 8);
  const summary = summarizeInput(input);
  const label = input.tool_name === 'Bash' ? 'Command' : input.tool_name === 'WebFetch' ? 'URL' : 'File';
  const lines = [
    `Tool: ${input.tool_name}`,
    `${label}: ${summary}`,
    `Directory: ${input.cwd}`,
    `Session: ${session}`,
    `Reason: ${reason}`,
  ];
  return {
    title: 'Claude Gatekeeper — Approval Needed',
    message: lines.join('\n'),
  };
}

/** Build the ntfy.sh JSON payload with action buttons and nonce. */
function buildPayload(
  topic: string,
  server: string,
  title: string,
  message: string,
  nonce: string
): string {
  return JSON.stringify({
    topic,
    title,
    message,
    tags: ['lock'],
    priority: 4,
    actions: [
      {
        action: 'http',
        label: 'Approve',
        url: `${server}/${topic}-response`,
        method: 'POST',
        headers: { 'X-Title': 'approved' },
        body: `approve:${nonce}`,
        clear: true,
      },
      {
        action: 'http',
        label: 'Deny',
        url: `${server}/${topic}-response`,
        method: 'POST',
        headers: { 'X-Title': 'denied' },
        body: `deny:${nonce}`,
        clear: true,
      },
    ],
  });
}

/** Map a decision result to confirmation notification details. */
function confirmationDetails(result: 'approve' | 'deny' | 'timeout'): { label: string; tag: string } {
  switch (result) {
    case 'approve': return { label: 'Approved', tag: 'white_check_mark' };
    case 'deny': return { label: 'Denied', tag: 'x' };
    case 'timeout': return { label: 'Timed Out — Escalated', tag: 'hourglass' };
  }
}

/** Send a low-priority confirmation notification to the main topic. */
async function sendConfirmation(
  server: string,
  topic: string,
  result: 'approve' | 'deny' | 'timeout',
  toolName: string,
  summary: string,
  token?: string
): Promise<void> {
  const { label, tag } = confirmationDetails(result);
  const payload = JSON.stringify({
    topic,
    title: `Claude Gatekeeper — ${label}`,
    message: `Tool: ${toolName} — ${summary}`,
    tags: [tag],
    priority: 2,
  });
  await postJson(`${server}/`, payload, token).catch(() => {});
}

/** POST a JSON payload to a URL. Returns true on 2xx. */
function postJson(url: string, body: string, token?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const req = mod.request(
      parsed,
      { method: 'POST', headers },
      (res) => {
        res.resume(); // Drain response body so Node can close the socket
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

/** SSE listener handle — allows cancellation from outside. */
interface SSEListener {
  promise: Promise<'approve' | 'deny' | 'timeout'>;
  cancel: () => void;
}

/** Listen on the SSE response topic for approve/deny. Returns a cancellable handle. */
function listenForResponse(
  server: string,
  topic: string,
  timeoutMs: number,
  nonce: string,
  token?: string
): SSEListener {
  let finish: (result: 'approve' | 'deny' | 'timeout') => void;

  const promise = new Promise<'approve' | 'deny' | 'timeout'>((resolve) => {
    let resolved = false;
    finish = (result: 'approve' | 'deny' | 'timeout') => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { req.destroy(); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    const sseUrl = `${server}/${topic}-response/sse`;
    const parsed = new URL(sseUrl);
    const mod = parsed.protocol === 'https:' ? https : http;

    const options: http.RequestOptions = { method: 'GET' };
    if (token) {
      options.headers = { 'Authorization': `Bearer ${token}` };
    }

    const req = mod.get(parsed, options, (res) => {
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const json = JSON.parse(line.slice(6));
            const msg = String(json.message || '');
            const decision = parseSSEResponse(msg, nonce);
            if (decision) {
              finish(decision);
              return;
            }
          } catch { /* not valid JSON, skip */ }
        }
      });
      res.on('end', () => finish('timeout'));
      res.on('error', () => finish('timeout'));
    });

    req.on('error', () => finish('timeout'));
  });

  return { promise, cancel: () => finish!('timeout') };
}

/**
 * Send a notification and wait for the user's response.
 * Returns 'approve', 'deny', or 'timeout'.
 */
export async function notifyAndWait(
  input: HookInput,
  reason: string,
  config: ApproverConfig
): Promise<'approve' | 'deny' | 'timeout'> {
  const notify = config.notify;
  if (!notify?.topic) return 'timeout';

  const server = notify.server || 'https://ntfy.sh';
  const timeoutMs = notify.timeoutMs || 60000;
  const token = notify.token;

  const nonce = randomBytes(16).toString('hex');

  const { title, message } = formatNotification(input, reason);
  const payload = buildPayload(notify.topic, server, title, message, nonce);

  logDebug(`notify: sending to ${server}/ (topic: ${notify.topic})`, config);

  // Start listening BEFORE sending so we don't miss a fast response
  const listener = listenForResponse(server, notify.topic, timeoutMs, nonce, token);

  // ntfy JSON publish endpoint is POST / (root); topic goes in the JSON body
  const sent = await postJson(`${server}/`, payload, token);
  if (!sent) {
    listener.cancel(); // Clean up SSE connection and timer
    logDebug('notify: failed to send notification', config);
    return 'timeout';
  }

  logDebug('notify: notification sent, waiting for response...', config);
  const result = await listener.promise;
  logDebug(`notify: response=${result}`, config);

  await sendConfirmation(server, notify.topic, result, input.tool_name, summarizeInput(input), token);

  return result;
}

/**
 * Send a test notification to verify setup.
 */
export async function sendTestNotification(topic: string, server: string, token?: string): Promise<boolean> {
  const payload = JSON.stringify({
    topic,
    title: 'Claude Gatekeeper — Test Notification',
    message: 'This is a test from claude-gatekeeper.\nIf you see this, notifications are working!',
    tags: ['white_check_mark'],
  });
  // ntfy JSON publish endpoint is POST / (root); topic goes in the JSON body
  return postJson(`${server}/`, payload, token);
}

/**
 * Send a test approval request and wait for user to tap Approve.
 */
export async function sendTestApproval(
  topic: string,
  server: string,
  timeoutMs: number,
  token?: string
): Promise<'approve' | 'deny' | 'timeout'> {
  const nonce = randomBytes(16).toString('hex');
  const payload = buildPayload(
    topic,
    server,
    'Claude Gatekeeper — Setup Test',
    'Please tap "Approve" to confirm your setup is working.',
    nonce
  );

  const listener = listenForResponse(server, topic, timeoutMs, nonce, token);
  // ntfy JSON publish endpoint is POST / (root); topic goes in the JSON body
  const sent = await postJson(`${server}/`, payload, token);
  if (!sent) {
    listener.cancel();
    return 'timeout';
  }

  const result = await listener.promise;
  await sendConfirmation(server, topic, result, 'Test', 'Setup verification', token);
  return result;
}

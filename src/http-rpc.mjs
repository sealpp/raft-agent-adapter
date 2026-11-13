// SPDX-License-Identifier: MIT
// ACP over CodeBuddy's streamable-HTTP endpoint.
//
// Raft starts one adapter process per agent. Those processes are cheap; the
// expensive CodeBuddy server is shared. The daemon in src/http-daemon.mjs owns
// one loopback server, and every adapter attaches with its own ACP connection
// and session. CodeBuddy's Web UI client path (clientInfo.name =
// "codebuddy-web-ui" plus the x-codebuddy-web-ui header) routes concurrent
// sessions correctly; the ordinary ACP client path does not.
//
// The HTTP surface is the public one documented by CodeBuddy:
//   POST /api/v1/acp/connect  -> connectionId + sessionToken
//   GET  /api/v1/acp          -> SSE notifications (one stream per connection)
//   POST /api/v1/acp          -> JSON-RPC requests, responses arrive as SSE
//   DELETE /api/v1/acp        -> close the connection
import http from 'node:http';
import { ensureDaemon, detachDaemon } from './http-shared.mjs';

const ACP_PATH = '/api/v1/acp';
const CONNECT_PATH = '/api/v1/acp/connect';
const CLOSE_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 60000;

function parseSseChunk(state, chunk, onMessage) {
  state.buffer += chunk;
  for (let at; (at = state.buffer.indexOf('\n')) >= 0;) {
    const line = state.buffer.slice(0, at).replace(/\r$/, '');
    state.buffer = state.buffer.slice(at + 1);
    if (!line.startsWith('data:')) continue;
    const text = line.slice(5).trim();
    if (!text) continue;
    let message;
    try { message = JSON.parse(text); } catch { continue; }
    onMessage(message);
  }
}

function parseControlChunk(state, chunk, onMessage) {
  state.buffer += chunk;
  for (let at; (at = state.buffer.indexOf('\n')) >= 0;) {
    const line = state.buffer.slice(0, at).trim();
    state.buffer = state.buffer.slice(at + 1);
    if (!line) continue;
    try { onMessage(JSON.parse(line)); } catch { /* ignore malformed control frames */ }
  }
}

function readBody(response) {
  return new Promise((resolve, reject) => {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { text += chunk; });
    response.on('end', () => resolve(text));
    response.on('error', reject);
  });
}

export class HttpRpc {
  constructor(config, { env = process.env, cwd = process.cwd() } = {}) {
    this.config = config;
    this.env = env;
    this.cwd = cwd;
    this.nextId = 0;
    this.pending = new Map();
    this.onNotification = null;
    this.onRequest = null;
    this.onExit = null;
    this.port = null;
    this.password = null;
    this.control = null;
    this.connectionId = null;
    this.sessionToken = null;
    this.sse = null;
    this.streams = new Set();
    this.connecting = null;
    this.closed = false;
    this.paused = false;
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
    this.exited = false;
  }

  endpoint() {
    return 'http://127.0.0.1:' + this.port + ACP_PATH;
  }

  headers(extra = {}) {
    return {
      'x-codebuddy-request': '1',
      'x-codebuddy-web-ui': '1',
      authorization: 'Bearer ' + this.password,
      ...(this.connectionId ? { 'acp-connection-id': this.connectionId } : {}),
      ...(this.sessionToken ? { 'acp-session-token': this.sessionToken } : {}),
      ...extra
    };
  }

  requestRaw(method, pathname, { headers = {}, body = null, timeout = 0, pauseResponse = true } = {}) {
    const url = new URL('http://127.0.0.1:' + this.port + pathname);
    return new Promise((resolve, reject) => {
      const request = http.request(url, { method, headers: this.headers(headers), agent: this.agent }, response => {
        if (!pauseResponse || !this.paused) return resolve(response);
        response.pause();
        resolve(response);
      });
      if (timeout > 0) {
        const timer = setTimeout(() => request.destroy(new Error('Timed out: ' + method + ' ' + pathname)), timeout);
        request.once('close', () => clearTimeout(timer));
      }
      request.on('error', reject);
      if (body !== null) {
        const text = JSON.stringify(body);
        request.setHeader('content-type', 'application/json');
        request.setHeader('content-length', Buffer.byteLength(text));
        request.end(text);
      } else request.end();
    });
  }

  async start() {
    const attached = await ensureDaemon({ env: this.env, cwd: this.cwd });
    this.control = attached.socket;
    this.port = attached.port;
    this.password = attached.password;
    const controlState = { buffer: '' };
    this.control.setEncoding('utf8');
    this.control.on('data', chunk => parseControlChunk(controlState, chunk, message => {
      if (message.type === 'backend-exit') this.exit(new Error(message.message ?? 'The shared CodeBuddy backend exited'));
    }));
    this.control.on('close', () => {
      if (!this.closed && !this.exited) this.exit(new Error('The shared CodeBuddy backend control channel closed'));
    });
    try {
      await this.connect();
    } catch (error) {
      detachDaemon(this.control);
      this.control = null;
      throw error;
    }
  }

  async connect() {
    const connectResponse = await this.requestRaw('POST', CONNECT_PATH, { timeout: 10000, pauseResponse: false });
    const connectText = await readBody(connectResponse);
    if (connectResponse.statusCode !== 200) throw new Error('CodeBuddy ACP connect failed: HTTP ' + connectResponse.statusCode + ' ' + connectText.slice(0, 400));
    let parsed;
    try { parsed = JSON.parse(connectText); } catch { throw new Error('CodeBuddy ACP connect returned invalid JSON'); }
    this.connectionId = parsed.connectionId;
    this.sessionToken = parsed.sessionToken;
    if (!this.connectionId) throw new Error('CodeBuddy ACP connect did not return a connection id');

    const response = await this.requestRaw('GET', ACP_PATH, { headers: { accept: 'text/event-stream' } });
    if (response.statusCode !== 200) {
      const text = await readBody(response);
      throw new Error('CodeBuddy ACP SSE failed: HTTP ' + response.statusCode + ' ' + text.slice(0, 400));
    }
    this.sse = response;
    this.streams.add(response);
    if (this.paused) response.pause();
    const state = { buffer: '' };
    response.setEncoding('utf8');
    response.on('data', chunk => parseSseChunk(state, chunk, message => this.dispatch(message)));
    response.on('close', () => {
      this.streams.delete(response);
      if (!this.closed) this.exit(new Error('The CodeBuddy ACP notification stream closed'));
    });
    response.on('error', error => {
      this.streams.delete(response);
      if (!this.closed) this.exit(error);
    });
  }

  ensure() {
    if (this.connectionId) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.start().catch(error => {
        this.exit(error);
        throw error;
      }).finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  dispatch(message) {
    if (message?.method) {
      if (Object.hasOwn(message, 'id')) {
        Promise.resolve(this.onRequest?.(message) ?? Promise.reject(new Error('Unsupported host request ' + message.method)))
          .then(result => this.reply(message.id, result), error => this.reply(message.id, null, error));
      } else {
        this.onNotification?.(message);
      }
      return;
    }
    const pending = this.pending.get(message?.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), { rpc: message.error }));
    else pending.resolve(message.result);
  }

  // Responses to backend-initiated requests travel over the same POST channel.
  reply(id, result, error) {
    const message = error
      ? { jsonrpc: '2.0', id, error: { code: error.rpc?.code ?? -32601, message: error.message } }
      : { jsonrpc: '2.0', id, result };
    this.post(message);
  }

  post(message) {
    this.ensure().then(async () => {
      const response = await this.requestRaw('POST', ACP_PATH, {
        headers: { accept: 'application/json, text/event-stream' },
        body: message,
        timeout: 24 * 60 * 60 * 1000,
        pauseResponse: false
      });
      const contentType = response.headers['content-type'] ?? '';
      const state = { buffer: '' };
      if (contentType.includes('text/event-stream')) {
        response.setEncoding('utf8');
        response.on('data', chunk => parseSseChunk(state, chunk, item => this.dispatch(item)));
        response.on('error', error => this.fail(error));
      } else {
        const text = await readBody(response).catch(error => { this.fail(error); return ''; });
        if (text) { try { this.dispatch(JSON.parse(text)); } catch { /* the response was not JSON-RPC */ } }
      }
      if (response.statusCode >= 300) this.fail(new Error('CodeBuddy ACP POST failed: HTTP ' + response.statusCode));
    }).catch(error => {
      if (Object.hasOwn(message, 'id')) this.fail(error);
    });
  }

  request(method, params, timeout = REQUEST_TIMEOUT_MS) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Timed out: ' + method)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.post({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.post({ jsonrpc: '2.0', method, params });
  }

  pause() {
    this.paused = true;
    for (const stream of this.streams) stream.pause();
  }

  resume() {
    this.paused = false;
    for (const stream of this.streams) stream.resume();
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  exit(error) {
    if (this.exited || this.closed) return;
    this.exited = true;
    this.fail(error);
    this.onExit?.();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error('RPC closed'));
    for (const stream of this.streams) {
      try { stream.destroy(); } catch { /* already gone */ }
    }
    this.streams.clear();
    if (this.connectionId) {
      try {
        const response = await this.requestRaw('DELETE', ACP_PATH, { timeout: CLOSE_TIMEOUT_MS, pauseResponse: false });
        await readBody(response).catch(() => '');
      } catch { /* server may already be gone */ }
    }
    detachDaemon(this.control);
    this.control = null;
    this.agent.destroy();
  }
}

export function spawnHttpRpc(config, options) {
  return new HttpRpc(config, options);
}

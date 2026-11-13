// SPDX-License-Identifier: MIT
// Deterministic CodeBuddy HTTP ACP peer. Mirrors the public loopback surface:
// POST /api/v1/acp/connect, GET/POST/DELETE /api/v1/acp. Every connection is
// independent, so tests can prove two Raft agents get two live sessions.
// Never invokes a model.
import fs from 'node:fs';
import http from 'node:http';

if (process.env.MOCK_SPAWN_LOG) {
  try { fs.appendFileSync(process.env.MOCK_SPAWN_LOG, process.pid + '\n'); } catch { /* best effort */ }
}

const args = process.argv.slice(2);
const portAt = args.indexOf('--port');
const requestedPort = portAt >= 0 ? Number(args[portAt + 1]) : 0;

const models = {
  'default-model': { name: 'Auto', efforts: ['disabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'enabled'], current: 'enabled' },
  'gpt-5.5': { name: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'enabled'], current: 'enabled' }
};
const modes = [
  { id: 'default', name: 'Always Ask' },
  { id: 'acceptEdits', name: 'Accept Edits' },
  { id: 'plan', name: 'Plan' },
  { id: 'auto', name: 'Auto' },
  { id: 'dontAsk', name: "Don't Ask" },
  { id: 'bypassPermissions', name: 'Bypass Permissions' },
  { id: 'fullAccess', name: 'Full Access' }
];
const sessions = new Map();
const connections = new Map();
const permissionWaiters = new Map();
let connectionSeq = 0;
let sessionSeq = 0;
let permissionSeq = 0;
const calls = [];

function persist() {
  if (!process.env.MOCK_STATE_FILE) return;
  try { fs.writeFileSync(process.env.MOCK_STATE_FILE, JSON.stringify({ sessions: [...sessions.entries()], calls })); } catch { /* best effort */ }
}
const record = (method, extra = {}) => { calls.push({ pid: process.pid, method, ...extra }); persist(); };

const fresh = cwd => ({ model: 'default-model', effort: models['default-model'].current, cwd, mode: 'default' });
const configOf = session => ({
  models: { availableModels: Object.entries(models).map(([modelId, model]) => ({ modelId, name: model.name })), currentModelId: session.model },
  modes: { availableModes: modes, currentModeId: session.mode ?? 'default' },
  configOptions: [
    { type: 'select', id: 'mode', name: 'Permission Mode', category: 'mode', currentValue: session.mode ?? 'default', options: modes.map(mode => ({ value: mode.id, name: mode.name })) },
    { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: session.model, options: Object.entries(models).map(([value, model]) => ({ value, name: model.name })) },
    { type: 'select', id: 'thought_level', name: 'Deep Thinking', category: 'thought_level', currentValue: session.effort, options: models[session.model].efforts.map(value => ({ value, name: value })) }
  ],
  multitaskOn: false
});

const sendSse = (connection, message) => {
  if (!connection || connection.destroyed) return;
  connection.write('data: ' + JSON.stringify(message) + '\n\n');
};
const sendResponse = (res, message) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.end('data: ' + JSON.stringify(message) + '\n\n');
};
const sendJson = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const errorResponse = (id, message, code = -32603) => ({ jsonrpc: '2.0', id, error: { code, message } });

function sessionOf(id) {
  const session = sessions.get(id);
  if (!session) throw Object.assign(new Error('Session not found: ' + id), { code: -32602 });
  return session;
}

async function handleRpc(connection, message) {
  const { id, method, params = {} } = message;
  record(method, {
    sessionId: params.sessionId,
    ...(method === 'initialize' ? { clientName: params.clientInfo?.name } : {}),
    ...(method === 'session/set_config_option' ? { configId: params.configId, value: params.value } : {})
  });

  if (method === 'initialize') {
    return {
      protocolVersion: 1,
      agentInfo: { name: 'codebuddy-http-fixture', version: '0.0.0' },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true } },
      authMethods: [{ id: 'external', name: 'Login with Google/Github', description: null }]
    };
  }
  if (method === 'authenticate') return {};
  if (method === 'session/new') {
    const sessionId = 'cbc-http-' + process.pid + '-' + (++sessionSeq);
    sessions.set(sessionId, fresh(params.cwd));
    persist();
    return { sessionId, ...configOf(sessions.get(sessionId)) };
  }
  if (method === 'session/load' || method === 'session/resume') {
    if (!sessions.has(params.sessionId)) sessions.set(params.sessionId, fresh(params.cwd));
    persist();
    return configOf(sessions.get(params.sessionId));
  }
  if (method === 'session/set_config_option') {
    const session = sessionOf(params.sessionId);
    if (params.configId === 'model') {
      if (!models[params.value]) throw Object.assign(new Error('unknown model: ' + params.value), { code: -32602 });
      session.model = params.value;
      session.effort = models[params.value].current;
    } else if (params.configId === 'thought_level') {
      if (!models[session.model].efforts.includes(params.value)) throw Object.assign(new Error('invalid thought_level'), { code: -32602 });
      session.effort = params.value;
    } else if (params.configId === 'mode') {
      if (!modes.some(mode => mode.id === params.value)) throw Object.assign(new Error('invalid permission mode'), { code: -32602 });
      session.mode = params.value;
    } else throw Object.assign(new Error('unknown config option: ' + params.configId), { code: -32602 });
    persist();
    return configOf(session);
  }
  if (method === 'session/prompt') {
    const session = sessionOf(params.sessionId);
    const text = (params.prompt ?? []).map(item => item.text ?? '').join('\n');
    record('prompt-received', { text, sessionId: params.sessionId });
    sendSse(connection.sse, {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[' + session.model + '] ' + text } } }
    });
    if (text.includes('permission')) {
      const permissionId = 'perm-' + (++permissionSeq);
      const answer = new Promise(resolve => permissionWaiters.set(permissionId, resolve));
      sendSse(connection.sse, {
        jsonrpc: '2.0',
        id: permissionId,
        method: 'session/request_permission',
        params: { sessionId: params.sessionId, toolCall: { toolCallId: 't1', title: 'Run tests' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] }
      });
      const result = await answer;
      record('permission-resolved', { sessionId: params.sessionId, outcome: result?.outcome?.optionId ?? null });
      sendSse(connection.sse, {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ':permission-' + (result?.outcome?.optionId ?? 'unknown') } } }
      });
    }
    return { stopReason: 'end_turn' };
  }
  if (method === 'session/close' || method === 'session/delete') {
    sessions.delete(params.sessionId);
    persist();
    return {};
  }
  throw Object.assign(new Error('not implemented: ' + method), { code: -32601 });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/v1/health') return sendJson(res, 200, { data: { status: 'ok', pid: process.pid } });
  if (req.headers['x-codebuddy-request'] !== '1') return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Missing required header: x-codebuddy-request' } });
  if (req.headers.authorization !== 'Bearer ' + process.env.CODEBUDDY_GATEWAY_PASSWORD) return sendJson(res, 401, { error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });

  if (url.pathname === '/api/v1/acp/connect' && req.method === 'POST') {
    const connectionId = 'conn-' + process.pid + '-' + (++connectionSeq);
    const sessionToken = 'token-' + connectionId;
    connections.set(connectionId, { id: connectionId, token: sessionToken, sse: null });
    return sendJson(res, 200, { connectionId, sessionToken });
  }

  if (url.pathname === '/api/v1/acp') {
    record('acp-request', { webUi: req.headers['x-codebuddy-web-ui'] === '1', httpMethod: req.method });
    const connectionId = req.headers['acp-connection-id'];
    const connection = connections.get(connectionId);
    if (!connection) return sendJson(res, 409, { error: { code: 'ACP_NOT_FOUND', message: 'Connection not found' } });

    if (req.method === 'GET') {
      if (!String(req.headers.accept ?? '').includes('text/event-stream')) return sendJson(res, 406, { error: { code: 'NOT_ACCEPTABLE', message: 'Client must accept text/event-stream' } });
      if (connection.sse) return sendJson(res, 409, { jsonrpc: '2.0', error: { code: -32000, message: 'Another ACP client is already connected.' }, id: null });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(':ok\n\n');
      connection.sse = res;
      req.on('close', () => { if (connection.sse === res) connection.sse = null; });
      return;
    }

    if (req.method === 'DELETE') {
      if (connection.sse) { try { connection.sse.end(); } catch { /* already gone */ } }
      connections.delete(connectionId);
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        let message;
        try { message = JSON.parse(body); } catch { return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }); }
        if (!message.method) {
          const waiter = permissionWaiters.get(message.id);
          if (waiter) { permissionWaiters.delete(message.id); waiter(message.result); }
          res.writeHead(202).end();
          return;
        }
        try {
          const result = await handleRpc(connection, message);
          if (Object.hasOwn(message, 'id')) return sendResponse(res, { jsonrpc: '2.0', id: message.id, result });
          res.writeHead(202).end();
        } catch (error) {
          if (Object.hasOwn(message, 'id')) return sendResponse(res, errorResponse(message.id, error.message, error.code));
          res.writeHead(202).end();
        }
      });
      return;
    }
  }

  sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'No mapping found' } });
});

server.listen(requestedPort, '127.0.0.1', () => {
  record('http-listening', { port: server.address().port, password: Boolean(process.env.CODEBUDDY_GATEWAY_PASSWORD) });
});
const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
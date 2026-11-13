// SPDX-License-Identifier: MIT
// Deterministic CodeBuddy Code ACP peer for offline tests. Mirrors the surface
// observed in CodeBuddy 2.147.0 and 2.179.3: session/new requires sign-in, there
// is no session/close or session/delete (-32601), session/load and session/resume
// succeed without echoing sessionId, and thought_level options differ per model.
// Never invokes a model.
import fs from 'node:fs';
import { createInterface } from 'node:readline';

// Records one line per backend process so tests can prove that several
// adapter processes share a single backend instead of each spawning one.
if (process.env.MOCK_SPAWN_LOG) {
  try { fs.appendFileSync(process.env.MOCK_SPAWN_LOG, process.pid + '\n'); } catch { /* best effort */ }
}
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (sessionId, text) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const usageUpdate = (sessionId, meta) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used: 0, size: 960000, ...(meta ? { _meta: meta } : {}) } } });
const models = {
  'default-model': { name: 'Auto', efforts: ['disabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'enabled'], current: 'enabled' },
  'gpt-5.5': { name: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'enabled'], current: 'enabled' }
};
const sessions = new Map();
const queues = new Map();
const inflight = new Map();
const calls = [];
let counter = 0;
if (process.env.MOCK_STATE_FILE && fs.existsSync(process.env.MOCK_STATE_FILE)) {
  const saved = JSON.parse(fs.readFileSync(process.env.MOCK_STATE_FILE, 'utf8'));
  calls.push(...(saved.calls ?? []));
  for (const [id, stored] of saved.sessions ?? []) {
    sessions.set(id, stored);
    counter = Math.max(counter, Number(/^cbc-fixture-(\d+)$/.exec(id)?.[1] ?? 0));
  }
}
function persist() {
  if (!process.env.MOCK_STATE_FILE) return;
  fs.writeFileSync(process.env.MOCK_STATE_FILE, JSON.stringify({ sessions: [...sessions.entries()], calls }));
}
const record = (method, extra = {}) => { calls.push({ method, ...extra }); persist(); };
const rpcError = (message, code) => Object.assign(new Error(message), { code });
const modes = [
  { id: 'default', name: 'Always Ask' },
  { id: 'acceptEdits', name: 'Accept Edits' },
  { id: 'plan', name: 'Plan' },
  { id: 'auto', name: 'Auto' },
  { id: 'dontAsk', name: "Don't Ask" },
  { id: 'bypassPermissions', name: 'Bypass Permissions' },
  { id: 'fullAccess', name: 'Full Access' }
];
const fresh = cwd => ({ model: 'default-model', effort: models['default-model'].current, cwd, mode: 'default' });
const configOf = session => ({
  models: { availableModels: Object.entries(models).map(([modelId, m]) => ({ modelId, name: m.name })), currentModelId: session.model },
  modes: { availableModes: modes, currentModeId: session.mode ?? 'default' },
  configOptions: [
    { type: 'select', id: 'mode', name: 'Permission Mode', category: 'mode', currentValue: session.mode ?? 'default', options: modes.map(m => ({ value: m.id, name: m.name })) },
    { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: session.model, options: Object.entries(models).map(([value, m]) => ({ value, name: m.name })) },
    { type: 'select', id: 'thought_level', name: 'Deep Thinking', category: 'thought_level', currentValue: session.effort, options: models[session.model].efforts.map(value => ({ value, name: value })) }
  ],
  multitaskOn: false
});
function sessionOf(id) {
  const session = sessions.get(id);
  if (!session) throw rpcError(`Session not found: ${id}`, -32602);
  return session;
}

async function handle(method, params) {
  record(method, { sessionId: params.sessionId, ...(method === 'session/set_config_option' ? { configId: params.configId, value: params.value } : {}) });
  if (method === 'initialize') return {
    protocolVersion: 1,
    agentInfo: { name: 'codebuddy-acp-fixture', version: '0.0.0' },
    agentCapabilities: { loadSession: process.env.MOCK_NO_LOAD !== '1', promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true } },
    authMethods: [{ id: 'external', name: 'Login with Google/Github', description: null }]
  };
  if (method === 'authenticate') return {};
  if (method === 'session/new') {
    if (process.env.MOCK_UNAUTHENTICATED === '1') throw Object.assign(rpcError('Authentication required', -32000), { data: { category: 'auth' } });
    const sessionId = `cbc-fixture-${++counter}`;
    sessions.set(sessionId, fresh(params.cwd));
    persist();
    return { sessionId, ...configOf(sessions.get(sessionId)) };
  }
  if (method === 'session/load' || method === 'session/resume') {
    if (method === 'session/load' && process.env.MOCK_LOAD_FAILS === '1') throw rpcError('Authentication required', -32000);
    if (!sessions.has(params.sessionId)) sessions.set(params.sessionId, fresh(params.cwd));
    persist();
    return configOf(sessions.get(params.sessionId));
  }
  if (method === 'session/set_config_option') {
    const session = sessionOf(params.sessionId);
    if (params.configId === 'model') {
      if (!models[params.value]) throw rpcError(`unknown model: ${params.value}`, -32602);
      session.model = params.value;
      session.effort = models[params.value].current;
    } else if (params.configId === 'thought_level') {
      if (!models[session.model].efforts.includes(params.value)) throw rpcError(`invalid thought_level for ${session.model}: ${params.value}`, -32602);
      session.effort = params.value;
    } else if (params.configId === 'mode') {
      if (!modes.some(m => m.id === params.value)) throw rpcError(`invalid permission mode: ${params.value}`, -32602);
      session.mode = params.value;
    } else throw rpcError(`unknown config option: ${params.configId}`, -32602);
    persist();
    return configOf(session);
  }
  if (method === 'session/prompt') {
    sessionOf(params.sessionId);
    const busy = (inflight.get(params.sessionId) ?? 0) > 0;
    inflight.set(params.sessionId, (inflight.get(params.sessionId) ?? 0) + 1);
    const run = async () => {
      const text = params.prompt.map(item => item.text || '').join('\n');
      record('prompt-received', { text });
      if (/held/.test(text)) await new Promise(resolve => setTimeout(resolve, 60));
      if (text.includes('usage-two-calls')) {
        usageUpdate(params.sessionId);
        usageUpdate(params.sessionId, { 'codebuddy.ai/requestId': 'r1', usage: { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 } });
        usageUpdate(params.sessionId, { 'codebuddy.ai/requestId': 'r2', usage: { prompt_tokens: 60, completion_tokens: 6, total_tokens: 66, completion_tokens_details: { reasoning_tokens: 2 }, prompt_tokens_details: { cached_tokens: 20 } } });
        usageUpdate(params.sessionId, { 'codebuddy.ai/requestId': 'r1', usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45, completion_tokens_details: { reasoning_tokens: 2 }, prompt_tokens_details: { cached_tokens: 10 } } });
      }
      notify(params.sessionId, text);
      record('prompt-settled', { text });
      return { stopReason: 'end_turn' };
    };
    const turn = (queues.get(params.sessionId) ?? Promise.resolve()).then(run, run);
    queues.set(params.sessionId, turn.catch(() => {}).then(() => inflight.set(params.sessionId, inflight.get(params.sessionId) - 1)));
    return busy ? { stopReason: 'end_turn' } : turn;
  }
  if (method === 'session/close' || method === 'session/delete') throw rpcError(`"Method not found": ${method}`, -32601);
  throw rpcError(`not implemented: ${method}`, -32601);
}

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.method || !Object.hasOwn(message, 'id')) return;
  handle(message.method, message.params || {}).then(
    result => send({ jsonrpc: '2.0', id: message.id, result }),
    error => send({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message, ...(error.data ? { data: error.data } : {}) } })
  );
});

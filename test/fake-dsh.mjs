// SPDX-License-Identifier: MIT
// Deterministic DeepSeek Harness ACP peer for offline tests. Mirrors the real
// dsh-acp wire surface: grouped model options, session/resume (no session/load,
// no session/delete), one in-flight prompt per session. Never invokes a model.
import fs from 'node:fs';
import { createInterface } from 'node:readline';

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (sessionId, text) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const models = [
  { provider: 'mock', id: 'plain', name: 'Plain', efforts: ['low', 'medium', 'high'] },
  { provider: 'mock', id: 'pro', name: 'Pro', efforts: ['medium', 'high', 'max'] },
  ...(process.env.MOCK_BARE_MODEL === '1' ? [{ provider: 'mock', id: 'bare', name: 'Bare', efforts: null }] : [])
];
const sessions = new Map();
const calls = [];
let counter = 0;
// Persisted sessions outlive the process; reload them as inactive records so
// resume works across restarts and new ids never collide.
if (process.env.MOCK_STATE_FILE && fs.existsSync(process.env.MOCK_STATE_FILE)) {
  const saved = JSON.parse(fs.readFileSync(process.env.MOCK_STATE_FILE, 'utf8'));
  calls.push(...(saved.calls ?? []));
  for (const [id, stored] of saved.sessions ?? []) {
    sessions.set(id, { ...stored, active: false, inflight: false });
    const n = /^dsh-fixture-(\d+)$/.exec(id)?.[1];
    if (n) counter = Math.max(counter, Number(n));
  }
}
const modelValue = model => JSON.stringify([model.provider, model.id]);
const findModel = value => models.find(m => modelValue(m) === value);

function config(session) {
  const model = findModel(session.model);
  const options = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.model, options: [
    { group: 'mock', name: 'Mock Provider', options: models.map(m => ({ value: modelValue(m), name: m.name })) }
  ] }];
  if (model?.efforts) {
    options.push({ id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: session.effort, options: [
      { value: '', name: 'Provider default' }, ...model.efforts.map(value => ({ value, name: value }))
    ] });
  }
  return { configOptions: options };
}

function persist() {
  if (!process.env.MOCK_STATE_FILE) return;
  // Atomic write: test readers must never observe a truncated file.
  const temp = process.env.MOCK_STATE_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ sessions: [...sessions.entries()].map(([id, s]) => [id, { ...s, active: false, inflight: false }]), calls }));
  fs.renameSync(temp, process.env.MOCK_STATE_FILE);
}

function record(method, extra = {}) {
  calls.push({ method, ...extra });
  persist();
}

async function handle(method, params) {
  record(method, { sessionId: params.sessionId });
  if (method === 'initialize') {
    return {
      protocolVersion: 1,
      agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
      agentCapabilities: {
        mcpCapabilities: { http: true },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {}, list: {}, resume: {} }
      },
      authMethods: []
    };
  }
  if (method === 'authenticate') return {};
  if (method === 'session/new') {
    const sessionId = `dsh-fixture-${++counter}`;
    const session = { model: modelValue(models[0]), effort: '', cwd: params.cwd, active: true, inflight: false };
    sessions.set(sessionId, session);
    persist();
    return { sessionId, ...config(session) };
  }
  if (method === 'session/resume') {
    const stored = sessions.get(params.sessionId);
    if (stored?.active) throw Object.assign(new Error(`session is already active: ${params.sessionId}`), { code: -32602 });
    if (!stored) throw Object.assign(new Error(`session is not resumable: ${params.sessionId}`), { code: -32602 });
    if (params.cwd !== stored.cwd) throw Object.assign(new Error(`session cwd does not match: ${params.cwd}`), { code: -32602 });
    stored.active = true;
    stored.inflight = false;
    return config(stored); // Real dsh resume does not echo the sessionId.
  }
  if (method === 'session/close') {
    const stored = sessions.get(params.sessionId);
    if (stored) { stored.active = false; stored.inflight = false; persist(); }
    return {};
  }
  const session = sessions.get(params.sessionId);
  if (!session?.active) throw Object.assign(new Error(`unknown session: ${params.sessionId}`), { code: -32602 });
  if (method === 'session/set_config_option') {
    if (params.configId === 'model') {
      const target = findModel(params.value);
      if (!target) throw Object.assign(new Error(`unknown model option: ${params.value}`), { code: -32602 });
      session.model = params.value;
      session.effort = '';
    } else if (params.configId === 'reasoning_effort') {
      const model = findModel(session.model);
      if (!model?.efforts?.includes(params.value)) throw Object.assign(new Error(`unknown reasoning effort for ${session.model}: ${params.value}`), { code: -32602 });
      session.effort = params.value;
    } else {
      throw Object.assign(new Error(`unknown session config option: ${params.configId}`), { code: -32602 });
    }
    persist();
    return config(session);
  }
  if (method === 'session/prompt') {
    if (session.inflight) throw Object.assign(new Error('a prompt is already in flight for this session'), { code: -32602 });
    session.inflight = true;
    try {
      const text = params.prompt.map(item => item.text || '').join('\n');
      record('prompt-received', { text });
      if (text.includes('base-held')) await new Promise(resolve => setTimeout(resolve, 60));
      notify(params.sessionId, text);
      record('prompt-settled', { text });
      return { stopReason: 'end_turn' };
    } finally { session.inflight = false; }
  }
  throw Object.assign(new Error(`not implemented: ${method}`), { code: -32601 });
}

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.method) return;
  if (!Object.hasOwn(message, 'id')) return;
  handle(message.method, message.params || {}).then(
    result => send({ jsonrpc: '2.0', id: message.id, result }),
    error => send({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } })
  );
});

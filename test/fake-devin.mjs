// SPDX-License-Identifier: MIT
// Deterministic ACP peer for offline tests. Never invokes a model or a tool.
import fs from 'node:fs';
import { createInterface } from 'node:readline';

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (sessionId, text) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const choices = [{ value: 'swe-2-high', name: 'SWE-2' }, { value: 'gpt-lite-none', name: 'GPT Lite' }];
const modes = ['accept-edits', 'smart', 'ask', 'plan', 'bypass'];
const sessions = new Map();
const hostRequests = new Map();
let counter = 0;
function config(session) {
  const efforts = session.model === 'swe-2-high' ? ['medium', 'high', 'max'] : ['none', 'low', 'xhigh'];
  const category = id => process.env.MOCK_NO_CATEGORY === '1' ? {} : { category: id === 'thought_level' ? 'thought_level' : id };
  return { configOptions: [
    { id: 'mode', ...category('mode'), currentValue: session.mode ?? 'accept-edits', options: modes.map(value => ({ value, name: value })) },
    { id: 'model', ...category('model'), currentValue: session.model, options: choices },
    { id: 'thought_level', ...category('thought_level'), currentValue: session.effort, options: efforts.map(value => ({ value, name: value })) }
  ] };
}
function persist() {
  if (process.env.MOCK_STATE_FILE) {
    // Atomic write: test readers must never observe a truncated file.
    const temp = process.env.MOCK_STATE_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify([...sessions]));
    fs.renameSync(temp, process.env.MOCK_STATE_FILE);
  }
}
async function handle(method, params) {
  if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true, _meta: { 'cognition.ai/midTurnPrompts': process.env.MOCK_NO_MID_TURN !== '1' } } };
  if (method === 'authenticate') return {};
  if (method === 'session/new') {
    const sessionId = `fixture-${++counter}`;
    const session = { model: 'swe-2-high', effort: 'high', mode: 'accept-edits' };
    sessions.set(sessionId, session); persist();
    return { sessionId, ...config(session) };
  }
  if (method === 'session/load') {
    const saved = JSON.parse(fs.readFileSync(process.env.MOCK_STATE_FILE, 'utf8'));
    for (const [key, value] of saved) sessions.set(key, value);
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error('Session not found');
    notify(params.sessionId, 'HISTORY_REPLAY_MUST_BE_SUPPRESSED');
    return config(session); // Real Devin can omit sessionId here.
  }
  if (method === 'session/delete' || method === 'session/close') { sessions.delete(params.sessionId); return {}; }
  const session = sessions.get(params.sessionId);
  if (!session) throw new Error('Unknown fixture session');
  if (method === 'session/set_config_option') {
    if (params.configId === 'model') {
      if (!choices.some(model => model.value === params.value)) throw new Error('Unknown model');
      session.model = params.value; session.effort = params.value === 'swe-2-high' ? 'high' : 'none';
    } else if (params.configId === 'thought_level') {
      const efforts = session.model === 'swe-2-high' ? ['medium', 'high', 'max'] : ['none', 'low', 'xhigh'];
      if (!efforts.includes(params.value)) throw new Error(`Unknown thought_level for ${session.model}: ${params.value}`);
      session.effort = params.value;
    }
    else if (params.configId === 'mode') {
      if (!modes.includes(params.value)) throw new Error(`Unknown permission mode: ${params.value}`);
      session.mode = params.value;
    }
    persist(); return config(session);
  }
  if (method === 'session/prompt') {
    const text = params.prompt.map(item => item.text || '').join('\n');
    if (text.includes('permission-test')) {
      const id = 'native-permission';
      await new Promise(resolve => {
        hostRequests.set(id, resolve);
        send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: params.sessionId, options: [{ optionId: 'once', kind: 'allow_once' }] } });
      });
    }
    if (text.includes('base-held')) await new Promise(resolve => setTimeout(resolve, 60));
    if (text.includes('injected-held')) await new Promise(resolve => setTimeout(resolve, 180));
    notify(params.sessionId, text);
    return { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2 } };
  }
  throw new Error(`Unknown native method: ${method}`);
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.method && hostRequests.has(message.id)) { hostRequests.get(message.id)(message.result); hostRequests.delete(message.id); return; }
  if (!Object.hasOwn(message, 'id')) return;
  handle(message.method, message.params || {}).then(
    result => send({ jsonrpc: '2.0', id: message.id, result }),
    error => send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error.message } })
  );
});

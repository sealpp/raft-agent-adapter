// SPDX-License-Identifier: MIT
// Deterministic peer that floods the host with session updates after a prompt
// and reports whether its own stdout ever blocked. Used to prove that host-side
// backpressure reaches the backend instead of being absorbed by the adapter.
import { createInterface } from 'node:readline';

const chunks = Number(process.env.PEER_CHUNKS ?? 120);
const size = Number(process.env.PEER_CHUNK_SIZE ?? 8192);
const sessionId = 'flood-session-1';
const configOptions = [
  { type: 'select', id: 'mode', name: 'Permission Mode', category: 'mode', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'fullAccess', name: 'Full Access' }] },
  { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'flood', options: [{ value: 'flood', name: 'Flood' }] },
  { type: 'select', id: 'thought_level', name: 'Thinking', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }
];
let mode = 'default';

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const waitDrain = () => new Promise(resolve => process.stdout.once('drain', resolve));

async function flood() {
  const startedAt = Date.now();
  let blockedWrites = 0;
  let waitedMs = 0;
  let lastUnblockedAt = null;
  for (let index = 0; index < chunks; index++) {
    const text = `c${index}:${'x'.repeat(size)}`;
    const update = { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } };
    if (!send(update)) {
      blockedWrites++;
      const blockedAt = Date.now();
      await waitDrain();
      waitedMs += Date.now() - blockedAt;
      lastUnblockedAt = Date.now();
    }
  }
  const endedAt = Date.now();
  return { blocked: blockedWrites > 0, blockedWrites, waitedMs, lastUnblockedAt, startedAt, endedAt, elapsedMs: endedAt - startedAt };
}

const config = () => ({
  configOptions: configOptions.map(option => option.id === 'mode' ? { ...option, currentValue: mode } : option)
});

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.method || !Object.hasOwn(message, 'id')) return;
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } } });
  if (message.method === 'session/new') return reply({ sessionId, ...config() });
  if (message.method === 'session/set_config_option') {
    if (message.params.configId === 'mode') mode = message.params.value;
    return reply(config());
  }
  if (message.method === 'session/prompt') {
    return flood().then(
      stats => reply({ stopReason: 'end_turn', _meta: stats }),
      error => send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } })
    );
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `not implemented: ${message.method}` } });
});

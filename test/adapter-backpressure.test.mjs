// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { projectRoot } from '../src/config.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The host stays stalled long enough that even a slow CI runner has forwarded
// the prompt to the backend by the time reading resumes. Windows runners are
// the slowest shard, so they get a wider window; RAFT_BP_STALL_MS overrides it.
const OVERRIDE_MS = Number(process.env.RAFT_BP_STALL_MS);
const STALL_MS = Number.isFinite(OVERRIDE_MS) && OVERRIDE_MS > 0 ? OVERRIDE_MS : (process.platform === 'win32' ? 1500 : 1000);

// On Windows, a piped process.stdout uses blocking writes, so write() does not
// return false under backpressure and the chain this test proves (host pauses
// -> adapter pauses -> backend blocks) cannot be observed. Skip there; the
// behavior is exercised on the Linux shards.
test('host backpressure reaches the backend instead of buffering its flood', {
  timeout: 30000,
  skip: process.platform === 'win32' ? 'Windows piped stdout does not report write backpressure' : false
}, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-backpressure-'));
  const configFile = path.join(temp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    backend: 'codebuddy',
    codebuddyExe: process.execPath,
    codebuddyArgs: [path.join(projectRoot, 'test/fake-flood.mjs')]
  }));
  const env = { ...process.env, RAFT_ADAPTER_CONFIG: configFile, RAFT_ADAPTER_LOCAL: temp, RAFT_ADAPTER_HTTP: '0', PEER_CHUNKS: '160', PEER_CHUNK_SIZE: '8192' };
  const child = spawn(process.execPath, [path.join(projectRoot, 'src/adapter.mjs'), 'agent', 'stdio'], { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(temp, { recursive: true, force: true }); });

  const pending = new Map();
  const notifications = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method) notifications.push(message);
      else pending.get(message.id)?.(message);
    }
  });
  const request = (id, method, params) => new Promise((resolve, reject) => {
    pending.set(id, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  await request(1, 'initialize', { protocolVersion: 1 });
  const session = await request(2, 'session/new', { cwd: temp, mcpServers: [] });

  // Simulate a host that stopped reading: the adapter must stop reading the
  // backend, whose pipe then fills and blocks its writes. Without that, the
  // adapter would absorb the whole flood in its own outbound buffer.
  child.stdout.pause();
  const turn = request(3, 'session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'flood' }] });
  await sleep(STALL_MS);
  const resumedAt = Date.now();
  child.stdout.resume();
  const result = await turn;

  const { blocked, waitedMs, lastUnblockedAt, startedAt } = result._meta;
  assert.equal(blocked, true, 'the backend must see its stdout block while the host is stalled');
  assert.ok(startedAt < resumedAt, `the backend started its flood after the stall ended (${startedAt - resumedAt}ms late)`);
  // Causality, not just wall-clock: the backend's blocked write can only be
  // released by the host resuming, so the final drain must land at/after the
  // resume. Without propagation the adapter keeps draining the backend and the
  // flood finishes while the host is still stalled.
  assert.ok(lastUnblockedAt >= resumedAt - 100, `the backend flood finished ${resumedAt - lastUnblockedAt}ms before the host resumed reading`);
  assert.ok(waitedMs >= STALL_MS * 0.4, `the backend waited only ${waitedMs}ms of a ${STALL_MS}ms stall`);
  const chunks = notifications.filter(message => message.params?.update?.sessionUpdate === 'agent_message_chunk');
  assert.equal(chunks.length, 160);
  const order = chunks.map(message => Number(/^c(\d+):/.exec(message.params.update.content.text)?.[1]));
  assert.deepEqual(order, Array.from({ length: 160 }, (_, index) => index));
});

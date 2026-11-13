// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Rpc, initializeParams } from '../src/rpc.mjs';
import { projectRoot } from '../src/config.mjs';
import { stopDaemon } from '../src/http-shared.mjs';

function fixture(t, extraEnv = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-http-test-'));
  const configFile = path.join(temp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    backend: 'codebuddy',
    codebuddyExe: process.execPath,
    codebuddyArgs: [path.join(projectRoot, 'test/fake-codebuddy-http.mjs'), '--acp']
  }));
  const cliTransport = path.join(temp, 'cli-transport');
  fs.mkdirSync(cliTransport);
  fs.writeFileSync(path.join(cliTransport, 'raft'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = {
    ...process.env,
    RAFT_ADAPTER_CONFIG: configFile,
    RAFT_ADAPTER_LOCAL: temp,
    RAFT_ADAPTER_HTTP: '1',
    SLOCK_CLI_TRANSPORT_DIR: cliTransport,
    MOCK_STATE_FILE: path.join(temp, 'sessions.json'),
    MOCK_SPAWN_LOG: path.join(temp, 'spawns.log'),
    ...extraEnv
  };
  const clients = [];
  const open = () => {
    const rpc = new Rpc(process.execPath, [path.join(projectRoot, 'src/adapter.mjs'), 'agent', 'stdio'], { cwd: temp, env });
    clients.push(rpc);
    return rpc;
  };
  t.after(async () => {
    for (const rpc of clients) await rpc.close();
    stopDaemon(temp);
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const spawns = () => fs.existsSync(env.MOCK_SPAWN_LOG)
    ? fs.readFileSync(env.MOCK_SPAWN_LOG, 'utf8').split('\n').filter(Boolean)
    : [];
  const calls = () => fs.existsSync(env.MOCK_STATE_FILE)
    ? (JSON.parse(fs.readFileSync(env.MOCK_STATE_FILE, 'utf8')).calls ?? [])
    : [];
  const state = () => fs.existsSync(env.MOCK_STATE_FILE)
    ? JSON.parse(fs.readFileSync(env.MOCK_STATE_FILE, 'utf8'))
    : { sessions: [] };
  return { open, temp, cliTransport, spawns, calls, state };
}

function collect(rpc) {
  const updates = [];
  rpc.onNotification = message => {
    if (message.method === 'session/update') updates.push(message);
  };
  return updates;
}

test('HTTP ACP answers the handshake, opens a session, and streams a prompt', { timeout: 60000 }, async t => {
  const { open, temp, cliTransport, spawns, calls, state } = fixture(t);
  const rpc = open();
  const init = await rpc.request('initialize', initializeParams);
  assert.equal(init.agentCapabilities.loadSession, true);
  assert.equal(init._meta['raft-agent-adapter'].backend, 'codebuddy');
  assert.deepEqual(init._meta.modelState.availableModels.map(model => model.modelId), ['codebuddy:default-model', 'codebuddy:gpt-5.5']);

  const updates = collect(rpc);
  const session = await rpc.request('session/new', { cwd: path.join(temp, 'elsewhere'), mcpServers: [] });
  // The shared backend dispatches any raft call made by this session to the
  // adapter's own CLI transport, not the first agent's inherited one.
  assert.equal(fs.readFileSync(path.join(temp, 'session-identities', session.sessionId), 'utf8').trim(), cliTransport);
  assert.ok(fs.existsSync(path.join(temp, 'bin', process.platform === 'win32' ? 'raft.cmd' : 'raft')));
  // The adapter's own cwd wins: the shared CodeBuddy process can only have one.
  assert.equal(state().sessions.find(([id]) => id === session.sessionId)?.[1]?.cwd, temp);
  const result = await rpc.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'from-http' }] });
  assert.equal(result.stopReason, 'end_turn');
  const text = updates
    .filter(message => message.params.update.sessionUpdate === 'agent_message_chunk')
    .map(message => message.params.update.content.text)
    .join('');
  assert.equal(text, '[default-model] from-http');
  // The cold-cache probe and the real session share one backend process.
  assert.equal(spawns().length, 1);
  assert.equal(calls().find(call => call.method === 'initialize')?.clientName, 'codebuddy-web-ui');
  assert.ok(calls().some(call => call.method === 'acp-request' && call.webUi === true));
});

test('two agents get independent HTTP connections and both answer concurrently', { timeout: 60000 }, async t => {
  const { open, temp, spawns } = fixture(t);
  const a = open();
  const b = open();
  const [initA, initB] = await Promise.all([
    a.request('initialize', initializeParams),
    b.request('initialize', initializeParams)
  ]);
  assert.equal(initA.agentCapabilities.loadSession, true);
  assert.equal(initB.agentCapabilities.loadSession, true);

  const seenA = collect(a);
  const seenB = collect(b);
  const sessionA = await a.request('session/new', { cwd: temp, mcpServers: [] });
  const sessionB = await b.request('session/new', { cwd: temp, mcpServers: [] });
  assert.notEqual(sessionA.sessionId, sessionB.sessionId);

  const [resultA, resultB] = await Promise.all([
    a.request('session/prompt', { sessionId: sessionA.sessionId, prompt: [{ type: 'text', text: 'from-a' }] }),
    b.request('session/prompt', { sessionId: sessionB.sessionId, prompt: [{ type: 'text', text: 'from-b' }] })
  ]);
  assert.equal(resultA.stopReason, 'end_turn');
  assert.equal(resultB.stopReason, 'end_turn');
  const textOf = updates => updates
    .filter(message => message.params.update.sessionUpdate === 'agent_message_chunk')
    .map(message => message.params.update.content.text).join('');
  assert.equal(textOf(seenA), '[default-model] from-a');
  assert.equal(textOf(seenB), '[default-model] from-b');
  // Both agents share the per-host backend; each keeps its own connection.
  assert.equal(spawns().length, 1);
});

test('host permission requests travel back over the HTTP connection', { timeout: 60000 }, async t => {
  const { open, temp, calls } = fixture(t);
  const rpc = open();
  rpc.onRequest = message => {
    if (message.method === 'session/request_permission') {
      return { outcome: { optionId: 'allow', name: 'Allow' } };
    }
    throw new Error('unexpected host request: ' + message.method);
  };
  await rpc.request('initialize', initializeParams);
  const updates = collect(rpc);
  const session = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  const result = await rpc.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'needs permission' }] });
  assert.equal(result.stopReason, 'end_turn');
  // The permission-resolution chunk travels on the notification SSE, which can
  // land just after the POST response that carries stopReason.
  for (let attempt = 0; attempt < 25; attempt++) {
    if (updates.some(message => message.params.update.content?.text?.includes('permission-allow'))) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const text = updates
    .filter(message => message.params.update.sessionUpdate === 'agent_message_chunk')
    .map(message => message.params.update.content.text).join('');
  assert.equal(text, '[default-model] needs permission:permission-allow');
  assert.ok(calls().some(call => call.method === 'permission-resolved' && call.outcome === 'allow'));
});

test('an idle backend exits and the next prompt resumes in a fresh process', { timeout: 120000 }, async t => {
  const { open, temp, spawns } = fixture(t, { RAFT_ADAPTER_HTTP_IDLE_MS: '300' });
  const rpc = open();
  const updates = collect(rpc);
  await rpc.request('initialize', initializeParams);
  const session = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  await rpc.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'before-idle' }] });
  const afterFirst = spawns().length;
  assert.ok(afterFirst >= 1);

  const lastPid = Number(spawns().at(-1));
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(lastPid, 0); } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.throws(() => process.kill(lastPid, 0), /ESRCH/, 'the idle backend must exit');

  const result = await rpc.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'after-idle' }] });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(spawns().length, afterFirst + 1, 'the next prompt starts one fresh backend');
  const text = updates
    .filter(message => message.params.update.sessionUpdate === 'agent_message_chunk')
    .map(message => message.params.update.content.text).join('');
  assert.match(text, /after-idle/);
});

test('a cached handshake avoids a second cold probe', { timeout: 60000 }, async t => {
  const { open, temp, spawns } = fixture(t);
  const first = open();
  await first.request('initialize', initializeParams);
  await first.close();
  const before = spawns().length;
  const second = open();
  await second.request('initialize', initializeParams);
  assert.equal(spawns().length, before, 'the cached handshake must not start a probe process');
  await second.request('session/new', { cwd: temp, mcpServers: [] });
  assert.equal(spawns().length, before, 'the second agent joins the existing shared backend');
});
test('five agents share one HTTP backend and answer concurrently', { timeout: 60000 }, async t => {
  const { open, temp, spawns } = fixture(t);
  const clients = Array.from({ length: 5 }, () => open());
  await Promise.all(clients.map(rpc => rpc.request('initialize', initializeParams)));
  const sessions = await Promise.all(clients.map(rpc => rpc.request('session/new', { cwd: temp, mcpServers: [] })));
  assert.equal(new Set(sessions.map(session => session.sessionId)).size, 5);

  const updates = clients.map(collect);
  const results = await Promise.all(clients.map((rpc, index) => rpc.request('session/prompt', {
    sessionId: sessions[index].sessionId,
    prompt: [{ type: 'text', text: 'agent-' + index }]
  })));
  assert.deepEqual(results.map(result => result.stopReason), Array.from({ length: 5 }, () => 'end_turn'));
  assert.deepEqual(updates.map(list => list
    .filter(message => message.params.update.sessionUpdate === 'agent_message_chunk')
    .map(message => message.params.update.content.text)
    .join('')), Array.from({ length: 5 }, (_, index) => '[default-model] agent-' + index));
  assert.equal(spawns().length, 1, 'all five agents must share one CodeBuddy backend process');
});
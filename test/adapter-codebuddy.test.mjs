// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Rpc, initializeParams } from '../src/rpc.mjs';
import { projectRoot } from '../src/config.mjs';
import { option } from '../src/model-config.mjs';

async function fixture(t, extraEnv = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-codebuddy-test-'));
  const configFile = path.join(temp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ backend: 'codebuddy', codebuddyExe: process.execPath, codebuddyArgs: [path.join(projectRoot, 'test/fake-codebuddy.mjs'), '--acp'] }));
  const env = { ...process.env, RAFT_ADAPTER_CONFIG: configFile, RAFT_ADAPTER_LOCAL: temp, RAFT_ADAPTER_HTTP: '0', MOCK_STATE_FILE: path.join(temp, 'sessions.json'), ...extraEnv };
  const start = () => new Rpc(process.execPath, [path.join(projectRoot, 'src/adapter.mjs'), 'agent', 'stdio'], { cwd: temp, env });
  const clients = [];
  const open = () => { const rpc = start(); clients.push(rpc); return rpc; };
  t.after(async () => { for (const rpc of clients) await rpc.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const calls = () => JSON.parse(fs.readFileSync(path.join(temp, 'sessions.json'), 'utf8')).calls;
  return { rpc: open(), open, temp, calls };
}

test('handshake keeps native loadSession and offers CodeBuddy models with Raft-visible thinking levels', async t => {
  const { rpc } = await fixture(t);
  const init = await rpc.request('initialize', initializeParams);
  assert.equal(init.agentCapabilities.loadSession, true);
  assert.equal(init._meta['raft-agent-adapter'].backend, 'codebuddy');
  const models = init._meta.modelState.availableModels;
  assert.deepEqual(models.map(m => m.modelId), ['codebuddy:default-model', 'codebuddy:gpt-5.5']);
  assert.equal(models[0].name, 'CodeBuddy · Auto');
  assert.equal(init._meta.modelState.currentModelId, 'codebuddy:default-model');
  assert.deepEqual(models[0]._meta.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('set_model applies the model and thought_level and rejects unsupported strengths', async t => {
  const { rpc, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  const session = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  const select = (modelId, effort) => rpc.request('session/set_model', { sessionId: session.sessionId, modelId, ...(effort ? { _meta: { reasoningEffort: effort } } : {}) });
  const picked = await select('codebuddy:gpt-5.5', 'xhigh');
  assert.equal(option(picked, 'model').currentValue, 'gpt-5.5');
  assert.equal(option(picked, 'thought_level').currentValue, 'xhigh');
  await assert.rejects(select('codebuddy:gpt-5.5', 'max'), /does not offer requested reasoning effort: max/);
  await assert.rejects(select('devin:swe-2-high', 'high'), /different adapter backend.*current: CodeBuddy/);
});

test('a cached handshake resumes the primed session instead of starting CodeBuddy again', async t => {
  const { rpc, open, calls, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  await rpc.close();
  const second = open();
  await second.request('initialize', initializeParams);
  // The second handshake is answered from initialize-cache.json; no backend.
  assert.equal(calls().filter(c => c.method === 'initialize').length, 1);
  await second.request('session/new', { cwd: temp, mcpServers: [] });
  assert.equal(calls().filter(c => c.method === 'session/new').length, 1);
  assert.equal(calls().filter(c => c.method === 'session/resume').length, 1);
});

test('a large cached handshake still reaches a host that closed stdin', async t => {
  const { rpc, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  await rpc.close();
  // Inflate the cached model surface past the pipe buffer so the reply cannot
  // flush synchronously; the EOF shutdown path must drain it before exiting.
  const cacheFile = path.join(temp, 'initialize-cache.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  cache.codebuddy.configOptions = [{
    id: 'model', type: 'select', name: 'Model', category: 'model', currentValue: 'm0',
    options: Array.from({ length: 3000 }, (_, i) => ({ value: `m${i}`, name: `Model ${i}` }))
  }];
  fs.writeFileSync(cacheFile, JSON.stringify(cache));

  const configFile = path.join(temp, 'config.json');
  const env = { ...process.env, RAFT_ADAPTER_CONFIG: configFile, RAFT_ADAPTER_LOCAL: temp, MOCK_STATE_FILE: path.join(temp, 'sessions.json') };
  const child = spawn(process.execPath, [path.join(projectRoot, 'src/adapter.mjs'), 'agent', 'stdio'], { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const exited = once(child, 'exit');
  const stdoutClosed = once(child.stdout, 'close');
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initializeParams }) + '\n');
  const [[exitCode]] = await Promise.all([exited, stdoutClosed]);
  assert.equal(exitCode, 0);
  const line = out.split('\n').find(l => l.includes('"id":1'));
  assert.ok(line, `expected an initialize response, got: ${out.slice(0, 200)}`);
  const message = JSON.parse(line);
  assert.equal(message.result._meta.modelState.availableModels.length, 3000);
});

test('a live handshake records the model list and thinking options in the catalog', async t => {
  const { rpc, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  const catalog = JSON.parse(fs.readFileSync(path.join(temp, 'model-catalog.json'), 'utf8'));
  assert.equal(catalog.schema, 2);
  assert.equal(catalog.backend, 'codebuddy');
  assert.deepEqual(catalog.entries.map(entry => entry.value), ['default-model', 'gpt-5.5']);
  assert.deepEqual(catalog.models['default-model'].efforts, ['disabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'enabled']);
  assert.equal(catalog.models['default-model'].defaultEffort, 'enabled');
});

test('a live session keeps verified thinking options for models that are still offered', async t => {
  const { rpc, temp } = await fixture(t);
  const file = path.join(temp, 'model-catalog.json');
  fs.writeFileSync(file, JSON.stringify({
    schema: 2,
    backend: 'codebuddy',
    key: 'stale-key',
    entries: [{ value: 'gpt-5.5', name: 'GPT-5.5' }, { value: 'retired', name: 'Retired' }],
    models: {
      'gpt-5.5': { efforts: ['low', 'max'], defaultEffort: 'max' },
      retired: { efforts: ['high'] }
    }
  }));
  const init = await rpc.request('initialize', initializeParams);
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(catalog.entries.map(entry => entry.value), ['default-model', 'gpt-5.5']);
  assert.deepEqual(catalog.models['gpt-5.5'], { efforts: ['low', 'max'], defaultEffort: 'max' });
  assert.equal(catalog.models.retired, undefined);
  assert.equal(catalog.models['default-model'].defaultEffort, 'enabled');
  const gpt = init._meta.modelState.availableModels.find(model => model.modelId === 'codebuddy:gpt-5.5');
  assert.deepEqual(gpt._meta.reasoningEfforts, ['low', 'max']);
  assert.equal(gpt._meta.reasoningEffort, 'max');
});

test('selecting a model records its thinking options for later probes', async t => {
  const { rpc, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  const session = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  await rpc.request('session/set_model', { sessionId: session.sessionId, modelId: 'codebuddy:gpt-5.5', _meta: { reasoningEffort: 'xhigh' } });
  const catalog = JSON.parse(fs.readFileSync(path.join(temp, 'model-catalog.json'), 'utf8'));
  assert.deepEqual(catalog.models['gpt-5.5'].efforts, ['low', 'medium', 'high', 'xhigh', 'enabled']);
  // The selected effort is a user choice, not the model's default.
  assert.equal(catalog.models['gpt-5.5'].defaultEffort, undefined);
});

test('concurrent cold starts share one backend handshake instead of booting one agent each', async t => {
  const { open, calls, temp } = await fixture(t);
  const clients = Array.from({ length: 6 }, () => open());
  const responses = await Promise.all(clients.map(rpc => rpc.request('initialize', initializeParams)));
  for (const init of responses) {
    assert.equal(init._meta['raft-agent-adapter'].backend, 'codebuddy');
    assert.deepEqual(init._meta.modelState.availableModels.map(m => m.modelId), ['codebuddy:default-model', 'codebuddy:gpt-5.5']);
  }
  // One process wins the gate and pays for CodeBuddy startup; the others wait
  // for its cache instead of each spawning a backend.
  assert.equal(calls().filter(c => c.method === 'initialize').length, 1);
  assert.equal(calls().filter(c => c.method === 'session/new').length, 1);
  assert.equal(fs.existsSync(path.join(temp, 'locks', 'codebuddy-initialize')), false);
});

test('a handshake gate left by a dead probe is reclaimed instead of stalling the agent', async t => {
  const { rpc, calls, temp } = await fixture(t);
  const lock = path.join(temp, 'locks', 'codebuddy-initialize');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'pid'), '999999999');
  const started = Date.now();
  const init = await rpc.request('initialize', initializeParams);
  assert.equal(init._meta['raft-agent-adapter'].backend, 'codebuddy');
  assert.ok(Date.now() - started < 5000, 'a dead owner must not cost the full wait');
  assert.equal(calls().filter(c => c.method === 'initialize').length, 1);
  assert.equal(fs.existsSync(lock), false);
});

test('the adapter exits on SIGTERM while the host keeps its stdin open', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-codebuddy-term-'));
  const configFile = path.join(temp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ backend: 'codebuddy', codebuddyExe: process.execPath, codebuddyArgs: [path.join(projectRoot, 'test/fake-codebuddy.mjs'), '--acp'] }));
  const env = { ...process.env, RAFT_ADAPTER_CONFIG: configFile, RAFT_ADAPTER_LOCAL: temp, RAFT_ADAPTER_HTTP: '0', MOCK_STATE_FILE: path.join(temp, 'sessions.json') };
  const child = spawn(process.execPath, [path.join(projectRoot, 'src/adapter.mjs'), 'agent', 'stdio'], { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    // On Windows the adapter is force-terminated without running shutdown, so
    // its backend child is orphaned and holds the temp directory briefly.
    // Retry the cleanup until the orphan releases it.
    for (let attempt = 0; attempt < 20; attempt++) {
      try { fs.rmSync(temp, { recursive: true, force: true }); return; }
      catch (error) {
        if (error.code !== 'EPERM') throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  });

  await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== 1) return;
      lines.close();
      resolve();
    });
    child.once('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initializeParams }) + '\n');
  });

  const started = Date.now();
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('adapter did not exit after SIGTERM')), 6000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  assert.ok(Date.now() - started < 6000);
});

test('session/load resumes a session from another process and answers with its id', async t => {
  const { rpc, open, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  const { sessionId } = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  await rpc.close();
  const resumed = open();
  await resumed.request('initialize', initializeParams);
  const loaded = await resumed.request('session/load', { sessionId, cwd: temp, mcpServers: [] });
  assert.equal(loaded.sessionId, sessionId);
});

test('permission mode fullAccess is applied on session open and resume', async t => {
  const { rpc, open, calls, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  const { sessionId } = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  const modeSets = () => calls().filter(c => c.method === 'session/set_config_option' && c.configId === 'mode');
  assert.deepEqual(modeSets().map(c => c.value), ['fullAccess']);
  await rpc.close();
  const resumed = open();
  await resumed.request('initialize', initializeParams);
  await resumed.request('session/load', { sessionId, cwd: temp, mcpServers: [] });
  assert.deepEqual(modeSets().map(c => c.value), ['fullAccess', 'fullAccess']);
});

test('session/delete only forgets the session because CodeBuddy has no close surface', async t => {
  const { rpc, calls, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  const { sessionId } = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  await rpc.request('session/delete', { sessionId });
  await assert.rejects(rpc.request('session/prompt', { sessionId, prompt: [] }), /Session not opened by this adapter process/);
  assert.equal(calls().filter(c => c.method === 'session/close' || c.method === 'session/delete').length, 0);
});

test('authenticate is refused before reaching CodeBuddy, whose sign-in logs out the current account', async t => {
  const { rpc, calls } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  await assert.rejects(rpc.request('authenticate', { methodId: 'external' }), /sign-in is interactive/);
  assert.equal(calls().filter(c => c.method === 'authenticate').length, 0);
});

test('interject during a busy turn is deferred and delivered as the next prompt', async t => {
  const { rpc, calls, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  const { sessionId } = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  const primary = rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'base-held' }] });
  const interject = await rpc.request('_x.ai/interject', { sessionId, text: 'injected-followup', interjectionId: 'i1' });
  assert.equal(interject.accepted, true);
  await primary;
  await new Promise(resolve => setTimeout(resolve, 150));
  const entries = calls().filter(c => c.method === 'prompt-received' || c.method === 'prompt-settled');
  const baseSettled = entries.findIndex(c => c.method === 'prompt-settled' && c.text === 'base-held');
  const injectedReceived = entries.findIndex(c => c.method === 'prompt-received' && c.text === 'injected-followup');
  assert.ok(baseSettled >= 0 && injectedReceived > baseSettled, `expected deferred delivery after settle, got ${JSON.stringify(entries)}`);
});

test('a deferred interjection settles inside its Raft turn, so the turn result follows the follow-up', async t => {
  const { rpc, calls, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  const { sessionId } = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  const primary = rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'base-held' }] });
  await rpc.request('_x.ai/interject', { sessionId, text: 'injected-held', interjectionId: 'i2' });
  await primary;
  assert.deepEqual(calls().filter(c => c.method === 'prompt-settled').map(c => c.text), ['base-held', 'injected-held']);
});

test('a prompt sent after such a turn is acknowledged only once it has run', async t => {
  const { rpc, calls, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  const { sessionId } = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  const primary = rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'base-held' }] });
  await rpc.request('_x.ai/interject', { sessionId, text: 'injected-held', interjectionId: 'i3' });
  await primary;
  await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'after-followup' }] });
  assert.equal(calls().filter(c => c.method === 'prompt-settled').at(-1).text, 'after-followup');
});

test('usage of a deferred interjection is reported on the Raft turn it interrupted', async t => {
  const { rpc, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  const { sessionId } = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  const primary = rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'base-held' }] });
  await rpc.request('_x.ai/interject', { sessionId, text: 'injected-held usage-two-calls', interjectionId: 'i4' });
  const turn = await primary;
  assert.deepEqual(turn._meta.usage, { inputTokens: 100, outputTokens: 11, totalTokens: 111 });
});

test('per-request usage_update counts are summed into the prompt result as ACP usage', async t => {
  const { rpc, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  const { sessionId } = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  const plain = await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'plain' }] });
  assert.equal(plain._meta.usage, undefined);
  const turn = await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'usage-two-calls' }] });
  assert.deepEqual(turn._meta.usage, { inputTokens: 100, outputTokens: 11, totalTokens: 111 });
  assert.ok(rpc.notifications.some(note => note.params?.update?.sessionUpdate === 'usage_update'));
});

test('session/load of an ID this adapter never created fails as missing before reaching CodeBuddy', async t => {
  const { rpc, calls } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  await assert.rejects(rpc.request('session/load', { sessionId: '00000000-0000-4000-8000-000000000000', cwd: process.cwd(), mcpServers: [] }), /session not found/);
  assert.equal(calls().filter(c => c.method === 'session/load').length, 0);
});

test('other session/load failures from CodeBuddy pass through unchanged instead of becoming missing sessions', async t => {
  const { rpc, open, temp } = await fixture(t, { MOCK_LOAD_FAILS: '1' });
  await rpc.request('initialize', initializeParams);
  const { sessionId } = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  await rpc.close();
  const resumed = open();
  await resumed.request('initialize', initializeParams);
  await assert.rejects(resumed.request('session/load', { sessionId, cwd: temp, mcpServers: [] }), error => /Authentication required/.test(error.message) && !/session not found/.test(error.message));
});

test('session IDs that are not plain identifiers are refused as missing without touching the disk', async t => {
  const { rpc, calls, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  await assert.rejects(rpc.request('session/load', { sessionId: '../escape', cwd: process.cwd(), mcpServers: [] }), /session not found/);
  assert.equal(calls().filter(c => c.method === 'session/load').length, 0);
  assert.equal(fs.existsSync(path.join(temp, 'escape')), false);
});

test('an unauthenticated CodeBuddy fails the handshake with the auth error Raft maps to not-authenticated', async t => {
  const { rpc } = await fixture(t, { MOCK_UNAUTHENTICATED: '1' });
  await assert.rejects(rpc.request('initialize', initializeParams), error => error.rpc?.code === -32000 && /Authentication required/.test(error.message));
});

test('a CodeBuddy build without session loading is refused at launch', async t => {
  const { rpc } = await fixture(t, { MOCK_NO_LOAD: '1' });
  await assert.rejects(rpc.request('initialize', initializeParams), /no longer advertises session loading/);
});
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Rpc, initializeParams } from '../src/rpc.mjs';
import { projectRoot } from '../src/config.mjs';
import { option, reasoningMeta, catalogKey } from '../src/model-config.mjs';

const fakeModels = [{ value: 'swe-2-high', name: 'SWE-2' }, { value: 'gpt-lite-none', name: 'GPT Lite' }];

function writePeerConfig(temp, { catalog = false } = {}) {
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ backend: 'devin', devinExe: process.execPath, devinArgs: [path.join(projectRoot, 'test/fake-devin.mjs')] }));
  if (catalog) {
    fs.writeFileSync(path.join(temp, 'model-catalog.json'), JSON.stringify({
      schema: 1, backend: 'devin',
      key: catalogKey(process.execPath, fakeModels),
      models: {
        'swe-2-high': { efforts: ['medium', 'high', 'max'], defaultEffort: 'high' },
        'gpt-lite-none': { efforts: ['none', 'low', 'xhigh'], defaultEffort: 'none' }
      }
    }));
  }
}

async function fixture(t, extraEnv = {}, { catalog = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-devin-test-'));
  writePeerConfig(temp, { catalog });
  const env = { ...process.env, RAFT_ADAPTER_CONFIG: path.join(temp, 'config.json'), RAFT_ADAPTER_LOCAL: temp, MOCK_STATE_FILE: path.join(temp, 'sessions.json'), ...extraEnv };
  const start = () => new Rpc(process.execPath, [path.join(projectRoot, 'src/adapter.mjs'), 'agent', 'stdio'], { cwd: temp, env });
  const clients = [];
  const open = () => { const rpc = start(); clients.push(rpc); return rpc; };
  t.after(async () => { for (const rpc of clients) await rpc.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const rpc = open();
  return { rpc, open, temp };
}

test('version and help work before Devin or local configuration is installed', () => {
  const env = { ...process.env, RAFT_ADAPTER_CONFIG: 'missing.json' };
  for (const arg of ['--version', '--help']) {
    const output = execFileSync(process.execPath, [path.join(projectRoot, 'src/adapter.mjs'), arg], { encoding: 'utf8', env });
    assert.match(output, /adapter/i);
  }
});

test('reasoning metadata preserves native defaults and filters unsupported Raft vocabulary', () => {
  assert.deepEqual(reasoningMeta({ efforts: ['none', 'low', 'xhigh'], defaultEffort: 'none' }), { reasoningEfforts: ['low', 'xhigh'] });
  assert.notEqual(catalogKey(process.execPath, [{ value: 'one' }]), catalogKey(process.execPath, [{ value: 'two' }]));
});

test('handshake exposes SWE-2 thinking and selection returns the applied Max configuration', async t => {
  const { rpc } = await fixture(t, {}, { catalog: true });
  const init = await rpc.request('initialize', initializeParams);
  const [swe, lite] = init._meta.modelState.availableModels;
  assert.equal(swe.modelId, 'devin:swe-2'); // family id: the level stays a separate choice
  assert.equal(lite.modelId, 'devin:gpt-lite');
  assert.equal(init._meta.modelState.currentModelId, 'devin:swe-2');
  assert.deepEqual(swe._meta.reasoningEfforts, ['medium', 'high', 'max']);
  assert.equal(swe._meta.reasoningEffort, 'high');
  const session = await rpc.request('session/new', { cwd: process.cwd(), mcpServers: [] });
  const select = (modelId, effort) => rpc.request('session/set_model', { sessionId: session.sessionId, modelId, ...(effort ? { _meta: { reasoningEffort: effort } } : {}) });
  const max = await select(swe.modelId, 'max');
  assert.equal(option(max, 'model').currentValue, 'swe-2-high');
  assert.equal(option(max, 'thought_level').currentValue, 'max');
  await assert.rejects(select(swe.modelId, 'low'), /Available: medium, high, max/);
  assert.equal(option(await select(swe.modelId), 'thought_level').currentValue, 'high');
  assert.equal(option(await select('devin:gpt-lite'), 'thought_level').currentValue, 'none');
  assert.equal(option(await select('devin:gpt-lite', 'xhigh'), 'thought_level').currentValue, 'xhigh');
  // Profiles saved before family ids still resolve their raw base ids.
  assert.equal(option(await select('devin:swe-2-high'), 'model').currentValue, 'swe-2-high');
  await assert.rejects(select('grok-model', 'high'), /different adapter backend.*current: Devin/);
  await assert.rejects(select('devin:no-such-model'), /not a model this Devin backend offers/);
  await assert.rejects(rpc.request('unsupported/extension', {}), /Unsupported Raft\/Grok extension/);
  await rpc.request('session/delete', { sessionId: session.sessionId });
  await assert.rejects(rpc.request('session/prompt', { sessionId: session.sessionId, prompt: [] }), /Session not opened/);
});

test('combo ids apply the embedded effort and set_config_option drives model and thinking directly', async t => {
  const { rpc } = await fixture(t, {}, { catalog: true });
  await rpc.request('initialize', initializeParams);
  const session = await rpc.request('session/new', { cwd: process.cwd(), mcpServers: [] });
  const set = (configId, value) => rpc.request('session/set_config_option', { sessionId: session.sessionId, configId, value });
  // devin:swe-2-max is a hand-written combo: family swe-2 + level max.
  const combo = await rpc.request('session/set_model', { sessionId: session.sessionId, modelId: 'devin:swe-2-max' });
  assert.equal(option(combo, 'model').currentValue, 'swe-2-high');
  assert.equal(option(combo, 'thought_level').currentValue, 'max');
  assert.equal(option(await set('thought_level', 'medium'), 'thought_level').currentValue, 'medium');
  assert.equal(option(await set('model', 'devin:gpt-lite'), 'model').currentValue, 'gpt-lite-none');
  assert.equal(option(await set('reasoning_effort', 'xhigh'), 'thought_level').currentValue, 'xhigh'); // alias → thought_level
  await assert.rejects(set('thought_level', 'high'), /invalid|not offer|Unknown|refus/i);
  await rpc.request('session/delete', { sessionId: session.sessionId });
});

test('thinking option category is stamped when the backend omits it', async t => {
  const { rpc } = await fixture(t, { MOCK_NO_CATEGORY: '1' });
  await rpc.request('initialize', initializeParams);
  const session = await rpc.request('session/new', { cwd: process.cwd(), mcpServers: [] });
  assert.equal(option(session, 'thought_level').category, 'thought_level');
  const result = await rpc.request('session/set_config_option', { sessionId: session.sessionId, configId: 'thought_level', value: 'max' });
  assert.equal(option(result, 'thought_level').category, 'thought_level');
  await rpc.request('session/delete', { sessionId: session.sessionId });
});

test('host instructions appear once and injected work completes before the primary turn ends', async t => {
  const { rpc } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  const { sessionId } = await rpc.request('session/new', { cwd: process.cwd(), mcpServers: [], _meta: { systemPromptOverride: 'ROLE_MARKER' } });
  let injectionDone = false;
  const base = rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'base-held' }] });
  const injected = rpc.request('_x.ai/interject', { sessionId, text: 'injected-held', interjectionId: 'injection-1' }).then(value => { injectionDone = true; return value; });
  const primary = await base;
  assert.equal(injectionDone, true);
  assert.deepEqual(primary._meta.usage, { inputTokens: 1, outputTokens: 2 });
  assert.equal((await injected).accepted, true);
  const texts = rpc.notifications.map(note => note.params?.update?.content?.text || '').join('\n');
  assert.equal(texts.split('ROLE_MARKER').length - 1, 1);
  assert.match(texts, /base-held/); assert.match(texts, /injected-held/);
});

test('permission mode bypass is applied on session open and resume', async t => {
  const { rpc, open, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  const { sessionId } = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  const reread = client => client.request('session/set_model', { sessionId, modelId: 'devin:swe-2-high' }).then(result => option(result, 'mode')?.currentValue);
  assert.equal(await reread(rpc), 'bypass');
  await rpc.close();
  const resumed = open();
  await resumed.request('initialize', initializeParams);
  await resumed.request('session/load', { sessionId, cwd: temp, mcpServers: [] });
  assert.equal(await reread(resumed), 'bypass');
});

test('permission requests reach the host and session-load history is suppressed', async t => {
  const { rpc, open, temp } = await fixture(t);
  await rpc.request('initialize', initializeParams);
  const { sessionId } = await rpc.request('session/new', { cwd: temp, mcpServers: [] });
  let permissionRequests = 0;
  rpc.onRequest = message => { assert.equal(message.method, 'session/request_permission'); permissionRequests++; return { outcome: { outcome: 'selected', optionId: 'once' } }; };
  await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'permission-test' }] });
  assert.equal(permissionRequests, 1);
  await rpc.close();
  const resumed = open();
  await resumed.request('initialize', initializeParams);
  const loaded = await resumed.request('session/load', { sessionId, cwd: temp, mcpServers: [] });
  assert.equal(loaded.sessionId, sessionId);
  assert.ok(!resumed.notifications.some(note => JSON.stringify(note).includes('HISTORY_REPLAY')));
});

test('authenticate is forwarded and drops the unauthenticated primed session', async t => {
  const { rpc } = await fixture(t);
  await rpc.request('initialize', initializeParams);   // primes fixture-1 internally
  await rpc.request('authenticate', { methodId: 'devin-browser', _meta: { api_key: 'probe' } });
  const fresh = await rpc.request('session/new', { cwd: process.cwd(), mcpServers: [] });
  assert.equal(fresh.sessionId, 'fixture-2'); // not the released primed session
  await rpc.request('session/delete', { sessionId: fresh.sessionId });
});

test('test-live.mjs passes end-to-end against the deterministic peer', async t => {
  // The live check drives the same family-id model surface (devin:swe-2, not
  // the base devin:swe-2-high); running it offline keeps its lookup honest.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-devin-live-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  writePeerConfig(temp, { catalog: true });
  const env = { ...process.env, RAFT_ADAPTER_CONFIG: path.join(temp, 'config.json'), RAFT_ADAPTER_LOCAL: temp };
  const output = execFileSync(process.execPath, [path.join(projectRoot, 'scripts/test-live.mjs')], { encoding: 'utf8', env });
  assert.match(output, /"passed":\s*true/);
});

test('missing mid-turn capability fails initialization explicitly', async t => {
  const { rpc } = await fixture(t, { MOCK_NO_MID_TURN: '1' });
  await assert.rejects(rpc.request('initialize', initializeParams), /required session resume or mid-turn/);
});

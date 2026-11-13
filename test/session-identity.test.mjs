// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ensureDispatcher,
  recordSessionIdentity,
  clearSessionIdentity,
  identityDir,
  wrapperForSession,
  posixShim,
  windowsShim
} from '../src/session-identity.mjs';
import { projectRoot } from '../src/config.mjs';
import { spawnSync } from 'node:child_process';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-session-identity-'));
  const transport = path.join(dir, 'transport');
  fs.mkdirSync(transport, { recursive: true });
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(path.join(transport, 'raft'), `#!/bin/sh\nprintf '%s' "$*" > '${marker}'\n`, { mode: 0o755 });
  ensureDispatcher(dir);
  return { dir, transport, marker, bin: path.join(dir, 'bin') };
}

const run = (bin, env) => execFileSync(path.join(bin, 'raft'), ['message', 'send', '--target', 'dm:@x'], {
  env: { ...process.env, RAFT_ADAPTER_LOCAL: env.RAFT_ADAPTER_LOCAL, ...env },
  encoding: 'utf8'
});

test('a session dispatches to the CLI transport recorded for it', { skip: process.platform === 'win32' }, () => {
  const { dir, transport, marker, bin } = fixture();
  assert.equal(recordSessionIdentity('session-a', { env: { SLOCK_CLI_TRANSPORT_DIR: transport }, dir }), true);
  assert.equal(wrapperForSession('session-a', { dir }), transport);

  run(bin, { RAFT_ADAPTER_LOCAL: dir, CODEBUDDY_SESSION_ID: 'session-a' });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'message send --target dm:@x');
});

test('two sessions keep different identities in one shared backend', { skip: process.platform === 'win32' }, () => {
  const { dir, bin } = fixture();
  const transports = [];
  for (const id of ['session-a', 'session-b']) {
    const transport = path.join(dir, id);
    fs.mkdirSync(transport);
    fs.writeFileSync(path.join(transport, 'raft'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    transports.push(transport);
    assert.equal(recordSessionIdentity(id, { env: { SLOCK_CLI_TRANSPORT_DIR: transport }, dir }), true);
  }
  assert.equal(wrapperForSession('session-a', { dir }), transports[0]);
  assert.equal(wrapperForSession('session-b', { dir }), transports[1]);
});

test('an unknown session fails instead of using the inherited identity', { skip: process.platform === 'win32' }, () => {
  const { dir, bin } = fixture();
  assert.throws(() => run(bin, { RAFT_ADAPTER_LOCAL: dir, CODEBUDDY_SESSION_ID: 'session-missing' }), error => {
    assert.equal(error.status, 3);
    assert.match(String(error.stderr), /no Raft identity/);
    return true;
  });
});

test('the posix shim is valid shell and forwards every argument', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-shim-'));
  const transport = path.join(dir, 'transport');
  fs.mkdirSync(transport);
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(path.join(transport, 'raft'), '#!/bin/sh\nprintf \'<%s>\\n\' "$@" > \'' + marker + '\'\n', { mode: 0o755 });
  const bin = ensureDispatcher(dir);
  const shim = path.join(bin, 'raft');
  execFileSync('sh', ['-n', shim]);
  recordSessionIdentity('s', { env: { SLOCK_CLI_TRANSPORT_DIR: transport }, dir });
  const args = ['message', 'send', '--target', 'dm:@some one', "it's", ''];
  execFileSync(shim, args, {
    env: { ...process.env, RAFT_ADAPTER_LOCAL: dir, CODEBUDDY_SESSION_ID: 's' }
  });
  const lines = fs.readFileSync(marker, 'utf8').trimEnd().split('\n').map(line => line.slice(1, -1));
  assert.deepEqual(lines, args);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the windows shim quotes its paths and forwards %* like npm shims', () => {
  const content = windowsShim('raft');
  assert.match(content, /@echo off\r\n/);
  assert.ok(content.includes('"' + process.execPath + '"'), 'node path must stay quoted for checkout paths with spaces');
  assert.ok(content.includes('"' + path.join(projectRoot, 'src', 'cli-dispatcher.mjs') + '"'));
  assert.ok(content.endsWith(' raft %*\r\n'));
  assert.ok(!content.includes('RAFT_CLI_DISPATCH_ARGS'), 'no cmd env round-trip that cmd quoting could corrupt');
});

test('cli-dispatcher receives arguments with spaces and apostrophes intact', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-dispatch-'));
  const transport = path.join(dir, 'transport');
  fs.mkdirSync(transport);
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(path.join(transport, 'raft'), '#!/bin/sh\nprintf \'<%s>\\n\' "$@" > \'' + marker + '\'\n', { mode: 0o755 });
  recordSessionIdentity('session-q', { env: { SLOCK_CLI_TRANSPORT_DIR: transport }, dir });
  const result = spawnSync(process.execPath, [
    path.join(projectRoot, 'src', 'cli-dispatcher.mjs'), 'raft',
    'message', 'send', '--target', 'dm:@some one', "it's", 'say "hi"'
  ], {
    env: { ...process.env, RAFT_ADAPTER_LOCAL: dir, CODEBUDDY_SESSION_ID: 'session-q' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = fs.readFileSync(marker, 'utf8').trimEnd().split('\n').map(line => line.slice(1, -1));
  assert.deepEqual(lines, ['message', 'send', '--target', 'dm:@some one', "it's", 'say "hi"']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('closing a session removes its identity', { skip: process.platform === 'win32' }, () => {
  const { dir, transport } = fixture();
  assert.equal(recordSessionIdentity('session-a', { env: { SLOCK_CLI_TRANSPORT_DIR: transport }, dir }), true);
  clearSessionIdentity('session-a', { dir });
  assert.equal(fs.existsSync(path.join(identityDir(dir), 'session-a')), false);
  assert.equal(wrapperForSession('session-a', { dir }), null);
});

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
  wrapperForSession
} from '../src/session-identity.mjs';

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

test('closing a session removes its identity', { skip: process.platform === 'win32' }, () => {
  const { dir, transport } = fixture();
  assert.equal(recordSessionIdentity('session-a', { env: { SLOCK_CLI_TRANSPORT_DIR: transport }, dir }), true);
  clearSessionIdentity('session-a', { dir });
  assert.equal(fs.existsSync(path.join(identityDir(dir), 'session-a')), false);
  assert.equal(wrapperForSession('session-a', { dir }), null);
});

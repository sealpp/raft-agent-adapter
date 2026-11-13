// SPDX-License-Identifier: MIT
// Shared CodeBuddy HTTP backend discovery.
//
// Raft starts one lightweight adapter process per agent. Those processes must
// share a single CodeBuddy server: CodeBuddy is expensive to boot, and Web UI
// clients can drive several ACP connections/sessions concurrently in one
// process. This module owns the cross-process endpoint state and the daemon
// control channel; it never starts a backend itself.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { localDir, projectRoot } from './config.mjs';
import { tryInitializeLock, initializeCacheKey } from './backends.mjs';

const START_TIMEOUT_MS = 60000;
const CONNECT_TIMEOUT_MS = 5000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function backendStatePath(dir = localDir()) {
  return path.join(dir, 'http-backend.json');
}

export function daemonSocketPath(dir = localDir()) {
  if (process.platform === 'win32') {
    const key = createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16);
    return '\\\\.\\pipe\\raft-adapter-http-' + key;
  }
  return path.join(dir, 'run', 'http-daemon.sock');
}

export function daemonLogPath(dir = localDir()) {
  return path.join(dir, 'http-daemon.log');
}

export function readBackendState(dir = localDir()) {
  try {
    const value = JSON.parse(fs.readFileSync(backendStatePath(dir), 'utf8'));
    if (value?.schema !== 1) return null;
    if (typeof value.pid !== 'number' || typeof value.port !== 'number' || typeof value.password !== 'string') return null;
    return value;
  } catch { return null; }
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function parseLines(state, chunk, onMessage) {
  state.buffer += chunk;
  for (let at; (at = state.buffer.indexOf('\n')) >= 0;) {
    const line = state.buffer.slice(0, at).trim();
    state.buffer = state.buffer.slice(at + 1);
    if (!line) continue;
    try { onMessage(JSON.parse(line)); } catch { /* ignore malformed control frames */ }
  }
}

// Attach to the running daemon. The returned socket is this adapter's liveness
// lease: the daemon sees it close when the adapter exits, so no pid file or
// heartbeat is needed.
export function connectDaemon({ timeout = CONNECT_TIMEOUT_MS, dir = localDir() } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(daemonSocketPath(dir));
    const state = { buffer: '' };
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Timed out connecting to the shared CodeBuddy backend')), timeout);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) { socket.destroy(); reject(error); }
      else resolve({ socket, port: attached.port, password: attached.password });
    };
    let attached = null;
    const onData = chunk => parseLines(state, chunk, message => {
      if (message.type === 'attached') { attached = message; finish(); }
      else if (message.type === 'error') finish(new Error(message.message ?? 'The shared CodeBuddy backend refused the connection'));
    });
    const onError = error => finish(error);
    const onClose = () => { if (!settled) finish(new Error('The shared CodeBuddy backend daemon closed before attaching')); };
    socket.once('connect', () => socket.write(JSON.stringify({ type: 'attach', pid: process.pid }) + '\n'));
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

// What a daemon must be running to serve this adapter: the backend and the
// exact executable/arguments. Adapters share one daemon, but only while their
// configuration matches; a daemon started for another executable (or another
// checkout with a different build) must not answer this adapter's initialize
// probes, or its model list would be cached under this adapter's key.
export function httpIdentity(config) {
  const key = initializeCacheKey(config);
  return createHash('sha256').update(JSON.stringify({
    backendId: config.backendId,
    key: key ?? { command: config.spawn.command, args: config.spawn.args }
  })).digest('hex').slice(0, 16);
}

// Attach to the running daemon, but only when it runs the same backend
// configuration as this adapter. The daemon publishes its identity in the
// state file; a mismatch means another adapter started it for a different
// executable. Returns null on mismatch so the caller can replace it. A daemon
// without a published identity (older build) is replaced as well.
async function attachMatching({ identity, timeout, dir }) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let attached;
    try {
      attached = await connectDaemon({ timeout: Math.min(CONNECT_TIMEOUT_MS, Math.max(1, deadline - Date.now())), dir });
    } catch { return null; }
    const state = readBackendState(dir);
    // A daemon that publishes no identity predates this check; keep using it.
    if (state?.port === attached.port && (!state.identity || state.identity === identity)) return { ...attached, state };
    detachDaemon(attached.socket);
    if (Date.now() >= deadline) return null;
    await sleep(100);
  }
}

function spawnDaemon({ env, cwd, identity, dir }) {
  fs.mkdirSync(path.dirname(daemonLogPath(dir)), { recursive: true });
  const log = fs.openSync(daemonLogPath(dir), 'a');
  let child;
  try {
    child = spawn(process.execPath, [path.join(projectRoot, 'src', 'http-daemon.mjs')], {
      cwd: cwd ?? projectRoot,
      // RAFT_ADAPTER_HTTP_LOCAL pins the daemon (and the dispatcher it installs)
      // to this directory even when the spawning adapter used RAFT_ADAPTER_LOCAL.
      env: { ...env, RAFT_ADAPTER_LOCAL: localDir(), RAFT_ADAPTER_HTTP_LOCAL: dir, RAFT_ADAPTER_HTTP_IDENTITY: identity },
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true
    });
  } finally {
    fs.closeSync(log);
  }
  child.unref();
  return child;
}

// Start the daemon once per host, or join the one another adapter already
// started. The short-lived start lock only covers discovery/launch; the daemon
// itself owns the lifetime lock.
export async function ensureDaemon({ env, cwd, dir = localDir(), identity = null, config = null } = {}) {
  const wanted = identity ?? (config ? httpIdentity(config) : null);
  if (wanted) {
    const existing = await attachMatching({ identity: wanted, timeout: CONNECT_TIMEOUT_MS, dir });
    if (existing) return existing;
  } else {
    try { return await connectDaemon({ timeout: CONNECT_TIMEOUT_MS, dir }); } catch { /* not running */ }
  }
  const release = tryInitializeLock(dir, 'http-daemon-start');
  if (!release) {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try { return await connectDaemon({ timeout: 1000, dir }); } catch {}
      await sleep(100);
    }
    throw new Error('The shared CodeBuddy backend did not become available');
  }
  try {
    const attach = () => wanted
      ? attachMatching({ identity: wanted, timeout: 1000, dir })
      : connectDaemon({ timeout: 1000, dir }).catch(() => null);
    const first = await attach();
    if (first) return first;
    const state = readBackendState(dir);
    if (state && processAlive(state.pid)) {
      // The daemon may be finishing a previous idle shutdown, or may be running
      // another backend configuration. Give it a short grace period to release
      // its lifetime lock, then start a fresh one.
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const attached = await attach();
        if (attached) return attached;
        if (!processAlive(state.pid)) break;
        await sleep(100);
      }
      if (processAlive(state.pid)) {
        // A live daemon for a different backend configuration is replaced: its
        // clients reattach and resume their sessions on the new backend. Any
        // other live daemon that refuses attachments is a genuine fault.
        const mismatched = wanted && state.identity && state.identity !== wanted;
        if (!mismatched) throw new Error('The shared CodeBuddy backend daemon is running but not accepting connections');
        try { process.kill(state.pid, 'SIGTERM'); } catch { /* already gone */ }
        const killDeadline = Date.now() + 10000;
        while (processAlive(state.pid) && Date.now() < killDeadline) await sleep(100);
        if (processAlive(state.pid)) throw new Error('The shared CodeBuddy backend daemon for another configuration did not stop');
      }
    }
    try { fs.rmSync(daemonSocketPath(dir), { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(backendStatePath(dir), { force: true }); } catch { /* best effort */ }
    spawnDaemon({ env, cwd, identity: wanted, dir });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const attached = await attach();
      if (attached) return attached;
      await sleep(100);
    }
    throw new Error('The shared CodeBuddy backend did not become healthy');
  } finally {
    release();
  }
}

export function detachDaemon(socket) {
  if (!socket) return;
  try { socket.write(JSON.stringify({ type: 'detach' }) + '\n'); } catch { /* already gone */ }
  try { socket.end(); } catch { /* already gone */ }
}

// Best-effort stop for tests and uninstall paths. Normal operation lets the
// daemon idle out after the last adapter detaches.
export function stopDaemon(dir = localDir()) {
  const state = readBackendState(dir);
  if (state && processAlive(state.pid)) {
    try { process.kill(state.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  try { fs.rmSync(daemonSocketPath(dir), { force: true }); } catch { /* best effort */ }
  try { fs.rmSync(backendStatePath(dir), { force: true }); } catch { /* best effort */ }
}
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
import { tryInitializeLock } from './backends.mjs';

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

function spawnDaemon({ env, cwd }) {
  fs.mkdirSync(path.dirname(daemonLogPath()), { recursive: true });
  const log = fs.openSync(daemonLogPath(), 'a');
  let child;
  try {
    child = spawn(process.execPath, [path.join(projectRoot, 'src', 'http-daemon.mjs')], {
      cwd: cwd ?? projectRoot,
      env: { ...env, RAFT_ADAPTER_LOCAL: localDir() },
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
export async function ensureDaemon({ env, cwd, dir = localDir() } = {}) {
  try { return await connectDaemon({ timeout: CONNECT_TIMEOUT_MS, dir }); } catch { /* not running */ }
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
    try { return await connectDaemon({ timeout: CONNECT_TIMEOUT_MS, dir }); } catch {}
    const state = readBackendState(dir);
    if (state && processAlive(state.pid)) {
      // The daemon may be finishing a previous idle shutdown. Give it a short
      // grace period to release its lifetime lock, then start a fresh one.
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        try { return await connectDaemon({ timeout: 1000, dir }); } catch {}
        if (!processAlive(state.pid)) break;
        await sleep(100);
      }
      if (processAlive(state.pid)) throw new Error('The shared CodeBuddy backend daemon is running but not accepting connections');
    }
    try { fs.rmSync(daemonSocketPath(dir), { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(backendStatePath(dir), { force: true }); } catch { /* best effort */ }
    spawnDaemon({ env, cwd });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try { return await connectDaemon({ timeout: 1000, dir }); } catch {}
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
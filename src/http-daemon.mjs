// SPDX-License-Identifier: MIT
// Shared CodeBuddy HTTP backend daemon.
//
// One daemon per RAFT_ADAPTER_LOCAL directory owns one CodeBuddy server. Each
// adapter process attaches over a Unix socket and receives the loopback
// endpoint. The daemon stops the backend after the last adapter detaches and
// the idle window expires; adapters then restart it on demand and resume their
// sessions with session/load.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadConfig, localDir } from './config.mjs';
import { tryInitializeLock } from './backends.mjs';
import { backendStatePath, daemonSocketPath } from './http-shared.mjs';
import { ensureDispatcher } from './session-identity.mjs';

const START_TIMEOUT_MS = 60000;
const START_POLL_MS = 100;
const CLOSE_TIMEOUT_MS = 3000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Start from the configured command but replace the stdio ACP flags with the
// HTTP server flags. A user-supplied codebuddyArgs keeps its extra flags; only
// the transport selection is rewritten.
export function httpSpawnArgs(config, port) {
  const args = [...config.spawn.args];
  const prefix = [];
  if (path.resolve(config.spawn.command) === path.resolve(process.execPath)
    && args[0] && path.isAbsolute(args[0])) prefix.push(args.shift());
  const kept = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--acp' || arg === 'acp' || arg === '--serve') continue;
    if (arg === '--acp-transport') { index++; continue; }
    if (arg === '--host' || arg === '--port' || arg === '--auth') { index++; continue; }
    kept.push(arg);
  }
  return [
    ...prefix,
    '--serve',
    '--acp',
    '--acp-transport', 'streamable-http',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--auth', 'password',
    ...kept
  ];
}

function readBody(response) {
  return new Promise((resolve, reject) => {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { text += chunk; });
    response.on('end', () => resolve(text));
    response.on('error', reject);
  });
}

async function waitForHealth(port, password, child, deadline) {
  let last = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('The CodeBuddy HTTP backend exited while starting');
    try {
      const response = await new Promise((resolve, reject) => {
        const request = http.get({
          host: '127.0.0.1',
          port,
          path: '/api/v1/health',
          headers: { 'x-codebuddy-request': '1', authorization: 'Bearer ' + password }
        }, resolve);
        request.setTimeout(2000, () => request.destroy(new Error('health timeout')));
        request.on('error', reject);
      });
      await readBody(response).catch(() => '');
      if (response.statusCode === 200) return;
      last = 'HTTP ' + response.statusCode;
    } catch (error) { last = error.message; }
    await sleep(START_POLL_MS);
  }
  throw new Error('CodeBuddy HTTP backend did not become healthy (' + last + ')');
}

async function main() {
  const config = loadConfig();
  if (!config.http || config.backendId !== 'codebuddy') {
    console.error('[raft-adapter-http] This daemon is only used by the CodeBuddy HTTP backend');
    process.exit(2);
  }
  // A replacement daemon can be spawned while the previous one is still tearing
  // down: the adapter reconnects as soon as the backend child exits, which is
  // just before the old daemon releases this lifetime lock. Wait briefly for
  // the old daemon to release the lock instead of exiting immediately, which
  // would otherwise leave the adapter polling for a daemon that never starts.
  let releaseLock = null;
  for (let attempt = 0; attempt < 300 && !releaseLock; attempt++) {
    releaseLock = tryInitializeLock(localDir(), 'http-daemon');
    if (!releaseLock) await sleep(100);
  }
  if (!releaseLock) process.exit(0);
  process.on('exit', () => { try { releaseLock(); } catch { /* already released */ } });

  const dir = localDir();
  const socketPath = daemonSocketPath(dir);
  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  try { fs.rmSync(socketPath, { force: true }); } catch { /* best effort */ }

  const idleSetting = Number(process.env.RAFT_ADAPTER_HTTP_IDLE_MS ?? 5 * 60 * 1000);
  const adapterIdleMs = Number.isFinite(idleSetting) ? idleSetting : 5 * 60 * 1000;
  // The adapter detaches after its own idle window. Once the last client is
  // gone, keep a short grace period for a reattach, then stop the backend.
  const idleMs = adapterIdleMs > 0 ? Math.min(adapterIdleMs, 30000) : 0;
  const port = await freePort();
  const password = randomBytes(24).toString('base64url');
  // Put the per-session CLI dispatcher in front of the inherited PATH. The
  // backend's own environment belongs to the first agent that started it; the
  // dispatcher chooses the right agent wrapper from CODEBUDDY_SESSION_ID.
  const dispatcher = ensureDispatcher(dir);
  const env = {
    ...process.env,
    CODEBUDDY_GATEWAY_AUTH: 'password',
    CODEBUDDY_GATEWAY_PASSWORD: password,
    PATH: [dispatcher, process.env.PATH ?? process.env.Path].filter(Boolean).join(path.delimiter)
  };
  const child = spawn(config.spawn.command, httpSpawnArgs(config, port), {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  let stopping = false;
  const clients = new Set();
  let idleTimer = null;
  let server = null;

  const writeState = () => {
    const file = backendStatePath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schema: 1,
      pid: process.pid,
      backendPid: child.pid,
      port,
      password,
      startedAt: new Date().toISOString()
    }), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  };

  const stop = async (reason, exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (server) { try { server.close(); } catch { /* already closed */ } }
    try { fs.rmSync(socketPath, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(backendStatePath(dir), { force: true }); } catch { /* best effort */ }
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const exited = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
        child.once('exit', () => { clearTimeout(timer); resolve(true); });
      });
      if (!exited) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    }
    console.error('[raft-adapter-http] Stopping shared backend: ' + reason);
    releaseLock();
    process.exit(exitCode);
  };

  const onSignal = () => void stop('signal', 0);
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  const scheduleIdle = () => {
    if (idleMs <= 0 || stopping) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (clients.size === 0) void stop('no adapter clients');
    }, idleMs);
    idleTimer.unref?.();
  };

  const notify = message => {
    const line = JSON.stringify(message) + '\n';
    for (const socket of clients) {
      try { socket.write(line); } catch { /* client already gone */ }
    }
  };

  child.on('exit', (code, signal) => {
    if (stopping) return;
    notify({ type: 'backend-exit', message: 'The shared CodeBuddy backend exited (' + code + ', ' + signal + ')' });
    setTimeout(() => void stop('backend exited', 1), 100).unref?.();
  });

  try {
    writeState();
    try {
      await waitForHealth(port, password, child, Date.now() + START_TIMEOUT_MS);
    } catch (error) {
      await stop(error.message, 1);
      return;
    }

    server = net.createServer(socket => {
    socket.setEncoding('utf8');
    const state = { buffer: '' };
    let attached = false;
    const remove = () => {
      if (!attached) return;
      attached = false;
      clients.delete(socket);
      if (clients.size === 0) scheduleIdle();
    };
    socket.on('data', chunk => {
      state.buffer += chunk;
      for (let at; (at = state.buffer.indexOf('\n')) >= 0;) {
        const line = state.buffer.slice(0, at).trim();
        state.buffer = state.buffer.slice(at + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type === 'attach') {
          if (stopping || child.exitCode !== null) {
            try { socket.write(JSON.stringify({ type: 'error', message: 'The shared CodeBuddy backend is stopping' }) + '\n'); socket.end(); } catch { /* already gone */ }
            return;
          }
          attached = true;
          clients.add(socket);
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
          socket.write(JSON.stringify({ type: 'attached', port, password }) + '\n');
        } else if (message.type === 'detach') {
          remove();
          try { socket.end(); } catch { /* already gone */ }
        }
      }
    });
    socket.on('close', remove);
    socket.on('error', remove);
  });
    server.on('error', error => { void stop('control socket error: ' + error.message, 1); });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        if (process.platform !== 'win32') { try { fs.chmodSync(socketPath, 0o600); } catch { /* best effort */ } }
        resolve();
      });
    });
    scheduleIdle();
    console.error('[raft-adapter-http] Shared CodeBuddy backend ready on 127.0.0.1:' + port);
  } catch (error) {
    await stop('daemon failed: ' + error.message, 1);
  }
}

try {
  await main();
} catch (error) {
  console.error('[raft-adapter-http] Daemon failed: ' + error.message);
  process.exit(1);
}
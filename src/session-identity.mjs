// SPDX-License-Identifier: MIT
// Per-session Raft CLI identity for the shared CodeBuddy backend.
//
// One CodeBuddy process serves several Raft agents. Its Bash tool children
// inherit that process's environment, which belongs to whichever agent happened
// to start the shared backend: PATH, SLOCK_AGENT_ID and the agent proxy token
// all point at that one agent. CodeBuddy does pass CODEBUDDY_SESSION_ID to tool
// children, so each adapter records its own CLI transport for the session and a
// dispatcher on PATH execs the wrapper that session actually belongs to.
import fs from 'node:fs';
import path from 'node:path';
import { localDir, projectRoot } from './config.mjs';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const COMMANDS = ['raft', 'slock', 'cont'];
const dispatcherPath = path.join(projectRoot, 'src', 'cli-dispatcher.mjs');
const nodePath = process.execPath;

export function validSessionId(id) {
  return typeof id === 'string' && SESSION_ID.test(id);
}

export function identityDir(dir = localDir()) {
  return path.join(dir, 'session-identities');
}

export function dispatcherDir(dir = localDir()) {
  return path.join(dir, 'bin');
}

function wrapperCandidates(name) {
  return process.platform === 'win32'
    ? [name + '.cmd', name + '.exe', name + '.bat', name]
    : [name];
}

function findWrapper(transport, name) {
  if (typeof transport !== 'string' || !path.isAbsolute(transport)) return null;
  try { if (!fs.statSync(transport).isDirectory()) return null; } catch { return null; }
  for (const candidate of wrapperCandidates(name)) {
    const file = path.join(transport, candidate);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// The adapter that owns a session writes the CLI transport injected into its own
// process. The shared backend reads this file through CODEBUDDY_SESSION_ID, so a
// session never inherits the first agent's identity.
export function recordSessionIdentity(sessionId, { env = process.env, dir = localDir() } = {}) {
  if (!validSessionId(sessionId)) return false;
  const transport = env.SLOCK_CLI_TRANSPORT_DIR;
  if (!findWrapper(transport, 'raft')) return false;
  try {
    fs.mkdirSync(identityDir(dir), { recursive: true, mode: 0o700 });
    const file = path.join(identityDir(dir), sessionId);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, transport + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  } catch { return false; }
}

export function clearSessionIdentity(sessionId, { dir = localDir() } = {}) {
  if (!validSessionId(sessionId)) return;
  try { fs.rmSync(path.join(identityDir(dir), sessionId), { force: true }); } catch { /* best effort */ }
}

export function wrapperForSession(sessionId, { dir = localDir() } = {}) {
  if (!validSessionId(sessionId)) return null;
  try {
    const transport = fs.readFileSync(path.join(identityDir(dir), sessionId), 'utf8').trim();
    return findWrapper(transport, 'raft') ? transport : null;
  } catch { return null; }
}

const SINGLE_QUOTE = String.fromCharCode(39);
const BACKSLASH = String.fromCharCode(92);

function quote(value) {
  const text = String(value);
  if (process.platform === 'win32') return '"' + text + '"';
  return SINGLE_QUOTE + text.replaceAll(SINGLE_QUOTE, SINGLE_QUOTE + BACKSLASH + SINGLE_QUOTE + SINGLE_QUOTE) + SINGLE_QUOTE;
}

function posixShim(name) {
  return `#!/bin/sh\nexec ${quote(nodePath)} ${quote(dispatcherPath)} ${name} "$@"\n`;
}

function windowsShim(name) {
  return `@echo off\r\n${quote(nodePath)} ${quote(dispatcherPath)} ${name} %*\r\n`;
}

// A tiny PATH entry in front of the shared backend. The script itself only
// forwards; cli-dispatcher.mjs chooses the agent by session id at call time.
export function ensureDispatcher(dir = localDir()) {
  const bin = dispatcherDir(dir);
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const windows = process.platform === 'win32';
  for (const name of COMMANDS) {
    const file = path.join(bin, windows ? `${name}.cmd` : name);
    const content = windows ? windowsShim(name) : posixShim(name);
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch { /* absent */ }
    if (current === content) continue;
    fs.writeFileSync(file, content, { mode: 0o755 });
    try { fs.chmodSync(file, 0o755); } catch { /* windows */ }
  }
  return bin;
}

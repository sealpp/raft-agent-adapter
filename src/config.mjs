// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const version = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
export const launcherPath = path.join(projectRoot, 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');

function existingFile(candidate) {
  try { return candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile(); }
  catch { return false; }
}

function onPath(name) {
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, name);
    if (existingFile(candidate)) return candidate;
  }
  return null;
}

function findDevinExe(explicit) {
  if (explicit && !existingFile(explicit)) throw new Error('The configured Devin executable does not exist.');
  const candidates = explicit ? [explicit] : [];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'devin', 'cli', 'bin', 'devin.exe'));
  } else if (process.env.HOME) {
    // Standalone Devin CLI install locations on macOS/Linux. The .local/bin
    // entry is a PATH-visible symlink; the _versions path is its real target,
    // which keeps discovery working when the daemon's PATH is minimal.
    candidates.push(
      path.join(process.env.HOME, '.local', 'bin', 'devin'),
      path.join(process.env.HOME, '.local', 'share', 'devin', 'cli', '_versions', 'current', 'bin', 'devin')
    );
  }
  if (!explicit) {
    for (const entry of (process.env.PATH || '').split(path.delimiter)) {
      candidates.push(path.join(entry, process.platform === 'win32' ? 'devin.exe' : 'devin'));
    }
  }
  return candidates.find(existingFile) ?? null;
}

function findDshExe(explicit) {
  if (explicit && !existingFile(explicit)) throw new Error('The configured DeepSeek Harness executable does not exist.');
  const candidates = explicit ? [explicit] : [];
  if (!explicit) {
    candidates.push(onPath('dsh'));
    if (process.platform === 'win32') candidates.push(onPath('dsh.exe'));
    // npm-global installs put a bin shim on PATH, but its script is also
    // resolvable directly; either form is accepted, .js entry points are
    // launched through the recorded Node binary.
    const libEntry = ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'];
    for (const root of [
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
      process.env.HOME && path.join(process.env.HOME, '.npm-global'),
      process.env.HOME && path.join(process.env.HOME, '.local', 'share', 'npm'),
      '/usr/local', '/usr', '/opt/homebrew',
    ]) {
      if (root) candidates.push(path.join(root, ...libEntry));
    }
  }
  return candidates.find(existingFile) ?? null;
}

function findCodebuddyExe(explicit) {
  if (explicit && !existingFile(explicit)) throw new Error('The configured CodeBuddy executable does not exist.');
  return explicit || onPath('codebuddy') || (process.platform === 'win32' ? onPath('codebuddy.exe') : null);
}

export function nodeExecutable() {
  try {
    const recorded = fs.readFileSync(path.join(localDir(), 'node-path.txt'), 'utf8').trim();
    if (existingFile(recorded)) return recorded;
  } catch { /* build-time file may not exist yet */ }
  return process.execPath;
}

export function localDir() {
  return process.env.RAFT_ADAPTER_LOCAL || path.join(projectRoot, '.local');
}

export function loadConfig() {
  const configPath = process.env.RAFT_ADAPTER_CONFIG || path.join(projectRoot, 'adapter.config.json');
  let local = {};
  try { local = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('Cannot read adapter configuration; check its JSON syntax.'); }
  const requested = process.env.RAFT_ADAPTER_BACKEND || local.backend || 'auto';

  if (!['auto', 'devin', 'dsh', 'codebuddy'].includes(requested)) throw new Error(`Unknown adapter backend: ${requested} (expected auto, devin, dsh or codebuddy)`);
  const devinExe = ['dsh', 'codebuddy'].includes(requested) ? null : findDevinExe(process.env.DEVIN_EXE || local.devinExe);
  const backendId = requested === 'auto' ? (devinExe ? 'devin' : 'dsh') : requested;
  const executable = backendId === 'devin' ? devinExe
    : backendId === 'dsh' ? findDshExe(process.env.DSH_EXE || local.dshExe)
    : findCodebuddyExe(process.env.CODEBUDDY_EXE || local.codebuddyExe);
  if (!executable) {
    const missing = {
      devin: 'Devin CLI was not found. Install it first, or set DEVIN_EXE / devinExe to its executable path.',
      dsh: 'DeepSeek Harness was not found. Install @deepseek-ai/dsh first, or set DSH_EXE / dshExe to its executable path.',
      codebuddy: 'CodeBuddy was not found. Install @tencent-ai/codebuddy-code first, or set CODEBUDDY_EXE / codebuddyExe to its executable path.'
    };
    throw new Error(requested === 'auto' ? 'Neither Devin CLI nor DeepSeek Harness was found. Install one, or set DEVIN_EXE / DSH_EXE.' : missing[backendId]);
  }

  // Explicit local configuration overrides inherited proxy variables only for
  // the backend child. Empty configuration preserves its normal environment.
  const proxyUrl = process.env.RAFT_ADAPTER_PROXY || local.proxyUrl || '';
  if (proxyUrl) {
    let parsed;
    try { parsed = new URL(proxyUrl); } catch { throw new Error('proxyUrl must be a valid proxy URL.'); }
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) throw new Error('Unsupported proxy protocol.');
  }

  const argOverride = local[`${backendId}Args`];
  const defaultArgs = { devin: ['acp'], dsh: ['acp'], codebuddy: ['--acp'] };
  const args = Array.isArray(argOverride) && argOverride.every(arg => typeof arg === 'string')
    ? argOverride : defaultArgs[backendId];
  // A resolved .js entry (dsh's npm lib/bin.js) runs under the recorded Node.
  const viaNode = executable.endsWith('.js');
  // CodeBuddy's Web UI client path supports several concurrent connections in
  // one server. A per-host daemon owns that one server and each lightweight
  // adapter attaches its own connection/session. RAFT_ADAPTER_HTTP=0 keeps the
  // stdio fallback for debugging.
  const http = backendId === 'codebuddy' && process.env.RAFT_ADAPTER_HTTP !== '0';
  return {
    backendId,
    executable,
    spawn: viaNode ? { command: nodeExecutable(), args: [path.resolve(executable), ...args] } : { command: path.resolve(executable), args },
    proxyUrl,
    http,
    defaultModel: local.defaultModel || null,
    catalogPath: path.join(localDir(), 'model-catalog.json')
  };
}
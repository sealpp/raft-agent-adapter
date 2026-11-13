// SPDX-License-Identifier: MIT
// Per-backend descriptors: the Raft/Grok wire surface stays fixed while each
// native agent protocol differs in capability bits, session lifecycle and
// model catalog shape. adapter.mjs consumes only this contract.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function missingSessionError(sessionId, cause) {
  // Raft's Grok driver only auto-recovers to a fresh session when the resume
  // failure matches /(path|session).*(not found|missing)/i. Translate any
  // backend resume rejection into that shape so switching agents or backends
  // self-heals instead of surfacing a startup error.
  const error = new Error(`session not found: ${sessionId}${cause?.message ? ` (${cause.message})` : ''}`);
  error.cause = cause;
  return error;
}

function modelEntriesOf(options) {
  // ACP model options may be a flat option list (Devin) or provider-grouped
  // (dsh: [{group, name, options:[{value,name}]}]). Always emit flat entries.
  return (options ?? []).flatMap(entry =>
    Array.isArray(entry.options)
      ? entry.options.map(o => ({ value: o.value, name: o.name ?? o.value }))
      : [{ value: entry.value, name: entry.name ?? entry.value }]
  ).filter(entry => typeof entry.value === 'string' && entry.value);
}

const base = {
  agentLabel(name) { return `${this.displayName} · ${name}`; },
  modelEntries(result, option) { return modelEntriesOf(option(result, 'model')?.options); },
  // Backends may need a different client identity than the one Raft sends.
  initializeParams(params) { return params; },
  // Release for the unclaimed primed session and Raft-closed sessions.
  closeMethods: ['session/delete', 'session/close'],
};

async function resumeOrCreatePrimed(rpc, cwd, state) {
  // Every dsh session/new is persisted permanently; probes would otherwise
  // leak one dead session per detection round. Reuse the stored catalog
  // session via session/resume (its response also carries configOptions).
  const stored = state?.primedSessionId;
  if (stored && path.resolve(state.primedCwd ?? '') === path.resolve(cwd)) {
    try {
      const resumed = await rpc.request('session/resume', { sessionId: stored, cwd, mcpServers: [] }, 90000);
      return { ...resumed, sessionId: stored };
    } catch { /* stale or foreign id: fall through to a fresh session */ }
  }
  return rpc.request('session/new', { cwd, mcpServers: [] }, 90000);
}

export const backends = {
  devin: {
    ...base,
    id: 'devin',
    displayName: 'Devin',
    modelPrefix: 'devin:',
    thinkingConfigId: 'thought_level',
    builtinDefaultModel: 'swe-2-high',
    midTurn: true,
    nativeLoad: true,
    loadMethod: 'session/load',
    persistentPrimed: false,
    permissionMode: 'bypass',
    async openPrimed(rpc, cwd) {
      return rpc.request('session/new', { cwd, mcpServers: [] }, 90000);
    },
    checkInit(initialized) {
      const caps = initialized.agentCapabilities;
      if (caps?.loadSession !== true || caps?._meta?.['cognition.ai/midTurnPrompts'] !== true) {
        throw new Error('Devin no longer advertises required session resume or mid-turn prompt capabilities; refusing an incompatible launch');
      }
      return caps;
    },
    resumeParams: params => params,
  },

  dsh: {
    ...base,
    id: 'dsh',
    displayName: 'DSH',
    modelPrefix: 'dsh:',
    thinkingConfigId: 'reasoning_effort',
    midTurn: false,
    nativeLoad: false,
    loadMethod: 'session/resume',
    persistentPrimed: true,
    closeMethods: ['session/close'],
    async openPrimed(rpc, cwd, state) {
      const created = await resumeOrCreatePrimed(rpc, cwd, state);
      if (!created.sessionId) throw new Error('DSH did not return a session ID');
      return created;
    },
    checkInit(initialized) {
      const caps = initialized.agentCapabilities;
      if (caps?.sessionCapabilities?.resume === undefined || caps?.sessionCapabilities?.close === undefined) {
        throw new Error('DeepSeek Harness does not advertise the required session resume/close capabilities; refusing an incompatible launch');
      }
      // Raft's Grok driver requires loadSession=true. session/resume is the
      // semantic equivalent (no replay), so the adapter claims it and maps
      // session/load -> session/resume internally.
      return { ...caps, loadSession: true };
    },
    resumeParams: params => ({ sessionId: params.sessionId, cwd: params.cwd, mcpServers: params.mcpServers ?? [] }),
    missingSessionError,
  },

  codebuddy: {
    ...base,
    id: 'codebuddy',
    displayName: 'CodeBuddy',
    modelPrefix: 'codebuddy:',
    thinkingConfigId: 'thought_level',
    builtinDefaultModel: 'default-model',
    midTurn: false,
    queuesPrompts: true,
    nativeLoad: true,
    loadMethod: 'session/load',
    persistentPrimed: true,
    closeMethods: [],
    interactiveAuth: true,
    knownSessionsOnly: true,
    permissionMode: 'fullAccess',
    missingSessionError,
    openPrimed: resumeOrCreatePrimed,
    checkInit(initialized) {
      const caps = initialized.agentCapabilities;
      if (caps?.loadSession !== true) throw new Error('CodeBuddy no longer advertises session loading; refusing an incompatible launch');
      return caps;
    },
    // CodeBuddy's Web UI client path is the one that routes concurrent
    // connections/sessions. The ordinary ACP client path keeps a single
    // current session per process, which is why the adapter never opens two
    // sessions on one adapter connection.
    initializeParams(params) {
      return {
        ...params,
        clientInfo: { ...(params.clientInfo ?? {}), name: 'codebuddy-web-ui' }
      };
    },
    usageOf(update) {
      const raw = update._meta?.usage;
      const key = update._meta?.['codebuddy.ai/requestId'] ?? update._meta?.['codebuddy.ai/messageId'];
      if (!key || typeof raw?.prompt_tokens !== 'number' || typeof raw.completion_tokens !== 'number') return null;
      const usage = { inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens, totalTokens: raw.total_tokens ?? raw.prompt_tokens + raw.completion_tokens };
      return { key, usage };
    },
    // Suppress history replay: the adapter already has the Raft-side history,
    // and replaying it would duplicate messages after an idle restart.
    resumeParams: params => ({
      ...params,
      _meta: { ...(params._meta ?? {}), 'codebuddy.ai/suppressReplay': true }
    }),
  },
};

function backendStatePath(dir) {
  return path.join(dir, 'backend-state.json');
}

export function readBackendState(dir, backendId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(backendStatePath(dir), 'utf8'));
    const entry = parsed?.[backendId];
    if (entry && typeof entry.primedSessionId === 'string') return entry;
  } catch { /* absent or corrupt state starts fresh */ }
  return null;
}

// Raft starts one adapter process per agent, so writes to the shared state
// files below can land at the same instant. A fixed ".tmp" name made the
// losers of that race fail with ENOENT after the winner renamed it, which
// surfaced as a failed agent handshake. Each writer gets its own temp file;
// rename is the only step that is shared, and it is atomic.
let tempSequence = 0;
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${++tempSequence}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  try { fs.renameSync(temp, file); }
  catch (error) { try { fs.unlinkSync(temp); } catch { /* best effort */ } throw error; }
}

export function writeBackendState(dir, backendId, entry) {
  const file = backendStatePath(dir);
  let parsed = {};
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fresh */ }
  writeJsonAtomic(file, { ...parsed, [backendId]: entry });
}

// Clears the persisted primed session only if it is still the one this process
// consumed. Several agents share one state file; an unconditional clear would
// drop a session another agent just persisted and force an extra resume.
export function clearPrimedSession(dir, backendId, sessionId) {
  const file = backendStatePath(dir);
  let parsed = {};
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fresh */ }
  const entry = parsed?.[backendId];
  if (!entry || entry.primedSessionId !== sessionId) return;
  writeJsonAtomic(file, { ...parsed, [backendId]: { ...entry, primedSessionId: null } });
}

// A successful backend initialize response plus the session config options is
// enough to answer Raft's model detection without starting the backend again.
// Raft probes this slot with initialize on startup, on reconnects and on model
// refreshes; spawning a full coding agent for each probe is the dominant cost.
function initializeCachePath(dir) {
  return path.join(dir, 'initialize-cache.json');
}

function fileFingerprint(file) {
  const resolved = fs.realpathSync(file);
  const stat = fs.statSync(resolved);
  return { path: resolved, size: stat.size, modified: stat.mtimeMs };
}

export function initializeCacheKey(config) {
  try {
    // Resolve aliases (PATH symlinks, npm .bin shims) so the same install
    // shares one cache key; size+mtime still invalidates on an upgrade. The
    // spawn command is fingerprinted as well: .js backends run under a
    // separate Node binary whose upgrades must invalidate the entry too.
    const executable = fileFingerprint(config.executable);
    const spawnCommand = fileFingerprint(config.spawn?.command ?? config.executable);
    return createHash('sha256').update(JSON.stringify({
      backendId: config.backendId,
      executable,
      spawnCommand,
      args: config.spawn?.args ?? []
    })).digest('hex');
  } catch { return null; }
}

export function readInitializeCache(dir, backendId, key) {
  if (!key) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(initializeCachePath(dir), 'utf8'));
    const entry = parsed?.schema === 1 ? parsed?.[backendId] : null;
    if (entry?.key !== key) return null;
    if (!entry.initialize || !Array.isArray(entry.configOptions)) return null;
    return entry;
  } catch { /* absent or corrupt cache falls back to a live handshake */ }
  return null;
}

export function writeInitializeCache(dir, backendId, key, entry) {
  if (!key) return;
  const file = initializeCachePath(dir);
  let parsed = { schema: 1 };
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (current?.schema === 1) parsed = current;
  } catch { /* fresh */ }
  parsed[backendId] = { ...entry, key, writtenAt: new Date().toISOString() };
  writeJsonAtomic(file, parsed);
}

export function invalidateInitializeCache(dir, backendId) {
  const file = initializeCachePath(dir);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.schema !== 1 || !(backendId in parsed)) return;
    delete parsed[backendId];
    fs.writeFileSync(file + '.tmp', JSON.stringify(parsed, null, 2));
    fs.renameSync(file + '.tmp', file);
  } catch { /* absent or corrupt cache needs no invalidation */ }
}

// Cross-process gate around the one live handshake that fills the cache. Probe
// processes that start together (startup, model refresh, after an upgrade
// invalidates every key) would otherwise each spawn a full coding agent.
// Returns a release function when this process owns the gate, null when another
// process is working or the gate timed out.
function initializeLockPath(dir, backendId) {
  return path.join(dir, 'locks', `${backendId}-initialize`);
}

function lockIsStale(lock) {
  let age;
  try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { return true; }
  if (age > 120000) return true;
  // The owner writes its pid right after mkdir; a missing file means the
  // creator is still inside that window, not that the gate is abandoned.
  let raw;
  try { raw = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim(); } catch { return false; }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

export function tryInitializeLock(dir, backendId) {
  const lock = initializeLockPath(dir, backendId);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lock);
      try { fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); } catch { /* liveness check degrades to the age check */ }
      return () => { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* already released */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A probe killed mid-handshake leaves the directory behind.
      if (!lockIsStale(lock)) return null;
      try { fs.rmSync(lock, { recursive: true, force: true }); } catch { return null; }
    }
  }
  return null;
}

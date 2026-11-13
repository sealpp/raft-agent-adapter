// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Values accepted by Raft's Grok model parser. Devin's "none" is represented
// by Raft's Default choice when it is the native model default.
const raftEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const option = (session, id) => session.configOptions?.find(o => o.id === id);

export function thinkingInfo(session, configId) {
  const thinking = option(session, configId);
  return {
    efforts: (thinking?.options ?? []).map(o => o.value).filter(v => typeof v === 'string' && v),
    ...(thinking?.currentValue ? { defaultEffort: thinking.currentValue } : {})
  };
}

export function catalogKey(executable, models) {
  const stat = statSync(executable);
  return createHash('sha256').update(JSON.stringify({
    binary: { size: stat.size, modified: stat.mtimeMs },
    models
  })).digest('hex');
}

// The catalog is maintained from live sessions as well as by models:refresh, so
// a backend upgrade no longer discards thinking metadata for every model. It
// records the offered model list (entries) alongside the options discovered so
// far; refresh is only needed for models no session has selected yet.
let catalogSequence = 0;

export function readCatalog(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function writeCatalog(file, catalog) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${++catalogSequence}.tmp`;
  writeFileSync(temp, JSON.stringify(catalog, null, 2));
  try { renameSync(temp, file); }
  catch (error) { try { unlinkSync(temp); } catch { /* best effort */ } throw error; }
}

// Keeps what earlier sessions discovered for models the backend still offers,
// refreshes the current model's options, and drops models that are gone.
export function mergeCatalog(previous, { backendId, key, entries, current }) {
  const known = previous?.backend === backendId && previous?.models ? previous.models : {};
  const offered = new Set(entries.map(entry => entry.value));
  const models = {};
  for (const [id, info] of Object.entries(known)) {
    if (offered.has(id) && Array.isArray(info?.efforts) && info.efforts.length) models[id] = info;
  }
  if (current?.value && current.efforts?.length) {
    const prior = models[current.value] ?? known[current.value];
    const defaultEffort = current.defaultEffort ?? prior?.defaultEffort;
    models[current.value] = { efforts: current.efforts, ...(defaultEffort ? { defaultEffort } : {}) };
  }
  return { schema: 2, backend: backendId, key, entries, models };
}

export function sameCatalog(a, b) {
  return Boolean(a) && a.schema === 2 && a.backend === b.backend && a.key === b.key
    && JSON.stringify(a.entries) === JSON.stringify(b.entries)
    && JSON.stringify(a.models) === JSON.stringify(b.models);
}

export function reasoningMeta(info) {
  if (!info) return {};
  return {
    reasoningEfforts: info.efforts.filter(e => raftEfforts.has(e)),
    ...(raftEfforts.has(info.defaultEffort) ? { reasoningEffort: info.defaultEffort } : {})
  };
}

// Words that can appear as a thinking-level suffix in a backend model id. Used
// only for resolving hand-written ids; the display split relies on the model's
// own default level, so name parts like kimi-k3-1-pro-max's "max" stay intact
// unless the backend actually reports that level as the model default.
const levelWords = new Set(['none', 'minimal', 'off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

// ACP base ids carry their default thinking level as a suffix: swe-2-high's
// default is high, so the Raft-facing family is swe-2 and the level stays a
// separate choice. Ids whose default is absent or not the trailing word keep
// whole (adaptive, claude-opus-4-6).
export function splitBase(id, defaultEffort) {
  return defaultEffort && id.endsWith(`-${defaultEffort}`) ? id.slice(0, -(defaultEffort.length + 1)) : id;
}

function stripLevelSuffix(id) {
  const at = id.lastIndexOf('-');
  if (at <= 0 || !levelWords.has(id.slice(at + 1))) return null;
  return { stem: id.slice(0, at), level: id.slice(at + 1) };
}

// Maps between Raft-facing model ids (families) and backend base ids.
// entries: flat [{ value, name }]; defaultOf(value) → the base's default level
// or undefined. When two bases share a family (not seen today, but possible
// after a backend catalog change) both keep their raw ids — nothing merges.
export function modelMap(entries, defaultOf) {
  const bases = new Set(entries.map(e => e.value));
  const groups = new Map();
  for (const e of entries) {
    const family = splitBase(e.value, defaultOf(e.value));
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(e.value);
  }
  const single = family => groups.get(family)?.length === 1 ? groups.get(family)[0] : null;
  return {
    toRaftId: value => {
      const family = splitBase(value, defaultOf(value));
      return groups.get(family)?.length === 1 ? family : value;
    },
    // base id | family | family + level suffix (hand-written CLI-style combos
    // like swe-2-max) → { base, effort? } | null. An embedded level rides along
    // as the implied effort when the host sends none explicitly.
    resolve(input) {
      if (bases.has(input)) return { base: input };
      const direct = single(input);
      if (direct) return { base: direct };
      const stripped = stripLevelSuffix(input);
      if (!stripped) return null;
      const base = single(stripped.stem) ?? (bases.has(stripped.stem) ? stripped.stem : null);
      return base ? { base, effort: stripped.level } : null;
    }
  };
}

// Raft's ACP side discovers the thinking option by category — stamp it when a
// backend omits the field so the discovery works for every backend.
export function stampCategories(result, thinkingConfigId) {
  for (const o of result?.configOptions ?? []) {
    if (o.id === thinkingConfigId && o.category === undefined) o.category = 'thought_level';
  }
  return result;
}

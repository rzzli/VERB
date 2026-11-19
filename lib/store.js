import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJSON, saveJSON } from './files.js';

const retention = 30;

export function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Sort by write time, not by run start time (several proofs can run in parallel).
export function recent(dir) {
  return entries(dir).filter(e => e.isFile() && e.name.endsWith('.json')).flatMap(e => {
    const file = path.join(dir, e.name);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return stat ? [{ file, time: stat.mtimeMs }] : [];
  }).sort((a, b) => b.time - a.time || b.file.localeCompare(a.file));
}

export function load(file) {
  try { return readJSON(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function prune(dir) {
  const removed = recent(dir).slice(retention).map(e => e.file);
  for (const file of removed) fs.rmSync(file, { force: true });
  return removed;
}

// Checks share observation history with proofs, but cannot count as required-command reruns.
// Carry each command's last three completed exits forward so check-only traffic cannot
// erase an unresolved conflict when the original execution records are pruned.
function suiteHistory(record, own, history) {
  const windows = [];
  const add = (index, event) => {
    if (!Number.isInteger(event.code)) return;
    const window = windows[index] ??= [];
    if (window.length < 3 && !window.some(prev => prev.run === event.run)) window.push(event);
  };
  if (own) record.suites.forEach((code, index) => add(index, { run: path.basename(own), code }));
  for (const { file, record: prev } of history) {
    (prev.suites ?? []).forEach((code, index) => add(index, { run: path.basename(file), code }));
  }
  const carried = history.find(prev => prev.record.suiteHistory)?.record.suiteHistory ?? [];
  carried.forEach((window, index) => window?.forEach(event => add(index, event)));
  return windows;
}

// Compare only completed observations, and never count a cached baseline as a rerun.
export function detectConflicts(store, claimKey, digest, role, side) {
  if (!side.assertions) return;
  const dir = path.join(store, 'history', 'claims', claimKey);
  const key = JSON.stringify([digest, role, side.kind, side.id, process.platform, process.arch]);
  const record = { key, obs: side.observations,
    suites: side.commands.filter(c => c.phase === 'required').map(c => c.error ? null : c.code) };
  const own = !side.cached && path.join(dir, randomUUID() + '.json');
  if (own) saveJSON(own, record);
  const history = [];
  for (const { file } of recent(dir)) {
    if (file === own) continue;
    const prev = load(file);
    if (prev?.key === key) history.push({ file, record: prev });
  }
  const window = [record, ...history.slice(0, side.cached ? 3 : 2).map(prev => prev.record)];
  record.suiteHistory = suiteHistory(record, own, history);
  if (own) {
    saveJSON(own, record);
    prune(dir);
  }
  const observationConflict = window.some(prev => JSON.stringify(prev.obs) !== JSON.stringify(record.obs));
  const suiteConflict = record.suiteHistory.some(window => window.some(event => event.code !== window[0].code));
  if (observationConflict || suiteConflict) {
    side.verdict = 'inconclusive';
    side.reason = 'conflicting reruns for the same input and frozen claim; rerun until the last three completed runs of this side agree' +
      (suiteConflict ? '; each required command must agree across its last three completed executions (checks and timeouts do not count)' : '');
  }
}

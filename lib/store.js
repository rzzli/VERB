import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { readJSON, saveJSON } from './files.js';
import { readReceipt } from './state.js';

const retention = 30;
const pause = new Int32Array(new SharedArrayBuffer(4));
const lockPath = (store, claimKey) => path.join(store, 'locks', claimKey + '.lock');

const lockHost = os.hostname() + ' (' + process.platform + ')';

function readLock(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? undefined : {}; }
  try { return { owner: JSON.parse(raw), raw }; }
  catch { return { raw }; } // A writer may still be filling the file.
}

function ownerIsGone(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return false;
  // Older versions wrote only a PID and start time and assumed a local checkout.
  const legacy = owner.host === undefined && owner.token === undefined && typeof owner.started === 'string';
  if (owner.host !== lockHost && !legacy) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

function recoverStaleLock(file) {
  const seen = readLock(file);
  if (!seen) return true;
  if (!ownerIsGone(seen.owner)) return false;
  // Serialize retirement of these exact contents. A late contender might win
  // the marker after reacquisition, so compare again while holding the marker.
  const marker = file + '.reap-' + createHash('sha256').update(seen.raw).digest('hex');
  try { fs.closeSync(fs.openSync(marker, 'wx')); }
  catch { return false; }
  try {
    const current = readLock(file);
    if (!current) return true;
    if (current.raw !== seen.raw) return false;
    fs.unlinkSync(file);
    return true;
  } catch { return false; }
  finally {
    // A surviving marker belongs only to this acquisition.
    try { fs.unlinkSync(marker); } catch {}
  }
}

const busy = file => {
  const info = readLock(file)?.owner, owner = Number.isSafeInteger(info?.pid) && info.pid > 0
    ? 'pid ' + info.pid + (typeof info.host === 'string' && info.host !== lockHost ? ' on ' + info.host : '') +
      (typeof info.started === 'string' ? ' since ' + info.started : '')
    : 'an unknown writer';
  return Object.assign(Error('Verification state is locked by ' + owner + ': ' + file +
    '. Wait for that process to finish. If it is gone, remove this lock file and retry; do not remove a live writer\'s lock.'),
  { code: 'history_busy', lock: file });
};

export function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Receipts are ordered by publication. Completed history events have their own sequence.
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

// The prefix survives copying, backup restoration and timestamp ties. Older
// receipts have no recorded sequence and sort below sequenced publications.
const sequencePrefix = /^(\d+)~/;
export const receiptRunId = file => path.basename(file, '.json').replace(sequencePrefix, '');
function receiptSequence(file) {
  const match = sequencePrefix.exec(path.basename(file));
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid receipt sequence: ' + file);
  return value;
}

export function receiptOrder(a, b) {
  return receiptSequence(b.file) - receiptSequence(a.file) || b.time - a.time || b.file.localeCompare(a.file);
}

export function publishReceipt(store, dir, runId, receipt) {
  const root = path.join(store, 'receipts');
  // Reserve and publish in the same critical section across all claims. The
  // newest entry survives retention, so no separate counter can get out of sync.
  withClaimLock(store, 'receipt-order', () => {
    let last = 0;
    for (const claim of entries(root).filter(e => e.isDirectory())) {
      for (const entry of entries(path.join(root, claim.name))) {
        if (entry.isFile() && entry.name.endsWith('.json')) last = Math.max(last, receiptSequence(entry.name));
      }
    }
    if (!Number.isSafeInteger(last + 1)) throw Error('Receipt sequence exhausted');
    receipt.sequence = last + 1;
    receipt.receipt = path.join(dir, receipt.sequence + '~' + runId + '.json');
    saveJSON(receipt.receipt, receipt);
  });
}

export function prune(dir, baseline) {
  const files = recent(dir).sort(receiptOrder).map(entry => entry.file);
  if (files.length <= retention) return [];
  const protectedFiles = new Set([baseline?.receipt]);
  if (baseline?.verdict === 'verified') {
    // Use the same publication order as status, including failed attempts. Derive
    // ownership from the published receipts so a stopped writer cannot leave a stale pin.
    const latestProof = files.find(file => {
      if (file === baseline.receipt || receiptRunId(file).startsWith('check-')) return false;
      const attempt = readReceipt(file); // also handles earlier, unprefixed check receipts
        return attempt.action === 'prove' && (attempt.targetKind ?? attempt.target?.kind ?? attempt.sides.candidate?.kind) === 'working';
    });
    protectedFiles.add(latestProof);
  }
  const ordinary = files.filter(file => !protectedFiles.has(file));
  const protectedCount = files.length - ordinary.length;
  const removed = ordinary.slice(retention - protectedCount);
  for (const file of removed) fs.rmSync(file, { force: true });
  return removed;
}

// History and receipt publication use separate per-claim locks. Neither covers a
// project command. A hard-killed writer leaves a lock that names its owner and can
// be recovered automatically once that PID is gone.
export function withClaimLock(store, claimKey, work) {
  const file = lockPath(store, claimKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 5000;
  const own = JSON.stringify({ pid: process.pid, started: new Date().toISOString(), host: lockHost, token: randomUUID() }) + '\n';
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(file, 'wx'); }
    catch (error) {
      const pending = process.platform === 'win32' && ['EACCES', 'EBUSY', 'EPERM'].includes(error.code);
      if (error.code !== 'EEXIST' && !pending) throw error;
      if (Date.now() >= deadline) throw busy(file);
      if (!pending && recoverStaleLock(file)) continue;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  try {
    fs.writeFileSync(fd, own);
    return work();
  } finally {
    fs.closeSync(fd);
    if (readLock(file)?.raw === own) fs.unlinkSync(file);
  }
}

function records(store, claimKey, locked = false) {
  const lock = lockPath(store, claimKey);
  if (!locked) {
    while (fs.existsSync(lock)) {
      if (recoverStaleLock(lock)) continue;
      throw busy(lock);
    }
  }
  const dir = path.join(store, 'history', 'claims', claimKey);
  const before = recent(dir);
  const result = before.flatMap(entry => {
    const record = load(entry.file);
    if (!record) return [];
    if ((record.schemaVersion !== undefined && record.schemaVersion !== 1) ||
        typeof record.key !== 'string' || !record.obs || typeof record.obs !== 'object' ||
        Array.isArray(record.obs) || !Array.isArray(record.suites) ||
        !record.suites.every(code => code === null || Number.isInteger(code)) ||
        (record.sequence !== undefined && (!Number.isSafeInteger(record.sequence) || record.sequence < 1))) {
      throw Object.assign(Error('Invalid or unsupported verification history record: ' + entry.file), { code: 'state_invalid' });
    }
    return [{ ...entry, record }];
  });
  // A status read must not write an execution or consume a partially updated window.
  if (!locked) {
    if (fs.existsSync(lock) && !recoverStaleLock(lock)) throw busy(lock);
    if (JSON.stringify(before) !== JSON.stringify(recent(dir))) throw busy(lock);
  }
  return result.sort((a, b) => (b.record.sequence ?? 0) - (a.record.sequence ?? 0) || b.time - a.time || b.file.localeCompare(a.file));
}

// Concurrent proofs hold the history lock only for a short append. Wait for that
// window rather than turning another writer's millisecond-sized transaction into a
// spurious inconclusive result; a genuinely stale lock still fails closed.
function settledRecords(store, claimKey) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { return records(store, claimKey); }
    catch (error) {
      if (error.code !== 'history_busy' || Date.now() >= deadline) throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}

const keyFor = (digest, role, side) => JSON.stringify([digest, role, side.kind, side.id, process.platform, process.arch]);

// Checks carry each required command's last three actual completed executions forward.
// Immutable event IDs deduplicate carried history; receipt/status reads never add events.
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

function conflict(record, history, suites, count) {
  const observations = history.slice(0, count).some(prev => JSON.stringify(prev.record.obs) !== JSON.stringify(record.obs));
  const commands = suites.some(window => window.some(event => event.code !== window[0].code));
  if (observations || commands) {
    return 'conflicting reruns for the same input and frozen claim; rerun until the last three completed runs of this side agree' +
      (commands ? '; each required command must agree across its last three completed executions (checks and timeouts do not count)' : '');
  }
}

// Register one completed side, with a stable ordering and sticky invalidation revision.
// A later check can invalidate a proof, but cannot produce a new proof after recovery.
export function detectConflicts(store, claimKey, digest, role, side) {
  if (!side.assertions) return;
  const key = keyFor(digest, role, side);
  const record = { schemaVersion: 1, key, obs: side.observations,
    suites: side.commands.filter(c => c.phase === 'required').map(c => c.error ? null : c.code) };
  const apply = (reason, revision) => {
    side.historyRevision = revision;
    if (reason) Object.assign(side, { verdict: 'inconclusive', reason });
  };
  if (side.cached) {
    const history = settledRecords(store, claimKey).filter(prev => prev.record.key === key);
    apply(conflict(record, history, suiteHistory(record, false, history), 3), history[0]?.record.invalidated ?? null);
    return;
  }
  withClaimLock(store, claimKey, () => {
    const all = records(store, claimKey, true);
    const history = all.filter(prev => prev.record.key === key);
    const own = path.join(store, 'history', 'claims', claimKey, randomUUID() + '.json');
    record.sequence = (all[0]?.record.sequence ?? 0) + 1;
    record.suiteHistory = suiteHistory(record, own, history);
    const reason = conflict(record, history, record.suiteHistory, 2);
    record.invalidated = reason ? path.basename(own) : history[0]?.record.invalidated ?? null;
    saveJSON(own, record);
    // Sequence, not mutable filesystem time, decides which completed events survive.
    for (const { file } of all.slice(retention - 1)) fs.rmSync(file, { force: true });
    apply(reason, record.invalidated);
  });
}

// Pure eligibility query over retained completed history. A missing candidate window
// cannot resurrect an old proof; cached baselines may outlive ordinary event retention.
export function currentConflict(store, claimKey, digest, role, side) {
  const history = settledRecords(store, claimKey).filter(prev => prev.record.key === keyFor(digest, role, side));
  if (!history.length) return role === 'candidate' ? 'Candidate history expired; run prove again.' : undefined;
  const record = { obs: side.observations, suites: [] };
  const reason = conflict(record, history, suiteHistory(record, false, history), 3);
  if (reason) return reason;
  if ((history[0].record.invalidated ?? null) !== (side.historyRevision ?? null)) {
    return 'A later completed run invalidated this proof; run prove again after resolving the conflict.';
  }
}

/** Read-only approval rule, also rechecked after slow cleanup before publication. */
export function proofProblem(store, claimKey, receipt) {
  if (receipt.verdict !== 'verified') return receipt.reason ?? 'Matching proof was not verified.';
  for (const role of ['base', 'candidate']) {
    const side = receipt.sides?.[role];
    if (!side || side.verdict !== 'verified' || !side.assertions) return 'Proof is incomplete; run prove again.';
    const reason = currentConflict(store, claimKey, receipt.digest, role, side);
    if (reason) return reason;
  }
}

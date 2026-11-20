#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkout, copyFixtures, freeze, git, hash, resolveRef, saveJSON, windowsRootAlias, working } from '../lib/files.js';
import { interrupt, runSide } from '../lib/run.js';
import { baselineFormat, readBaseline, readReceipt, receiptFormat } from '../lib/state.js';
import { currentConflict, detectConflicts, entries, load, proofProblem, prune, publishReceipt, receiptOrder, receiptRunId, recent, withClaimLock } from '../lib/store.js';

const usage = 'VERB — Verify Expected Runtime Behavior\n\nverb baseline CLAIM --base REF\nverb check CLAIM\nverb prove CLAIM --base REF [--candidate REF]\nverb status [RECEIPT | --active]\nverb summary RECEIPT\nverb deactivate CLAIM\nAdd --json for machine-readable output. Run from the target Git repository.';
const codes = { verified: 0, failed: 1, inconclusive: 2 };
let interrupted = false;
const invocation = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  invocation.abort();
  interrupt();
});

function argumentsFor(argv) {
  const [action, ...args] = argv;
  if (!['baseline', 'check', 'prove', 'status', 'summary', 'deactivate'].includes(action)) throw Error(usage);
  const file = args[0] && !args[0].startsWith('--') ? args.shift() : undefined;
  if (!file && action !== 'status') throw Error(usage);
  const opts = { action, file: file && path.resolve(file), json: false };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--json' && action !== 'summary') opts.json = true;
    else if (key === '--active' && action === 'status' && !file && !opts.active) opts.active = true;
    else if (['--base', '--candidate'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--') &&
      !Object.hasOwn(opts, key.slice(2))) opts[key.slice(2)] = args[++i];
    else throw Error(usage);
  }
  if (Boolean(opts.base) !== ['baseline', 'prove'].includes(action) || (opts.candidate && action !== 'prove')) throw Error(usage);
  return opts;
}

function textReport(r) {
  const lines = [r.verdict.toUpperCase() + ' (' + r.action + ') ' + (r.claim ?? '')];
  for (const [role, side] of Object.entries(r.sides ?? {})) {
    lines.push(role + ' ' + side.id + (side.cached ? ' (saved baseline)' : ''));
    for (const a of side.assertions ?? []) {
      lines.push('  ' + (a.pass ? 'PASS ' : 'MISS ') + a.key + (a.control ? ' [control]' : '') +
        ' expected ' + JSON.stringify(a.expected) + ', observed ' + JSON.stringify(a.actual));
    }
    if (side.reason) lines.push('  ' + side.reason);
    if (role === 'candidate') {
      const executed = side.commands.filter(c => c.phase === 'required');
      lines.push('  Required commands executed: ' + executed.length + '/' + r.required.length);
      for (const c of executed) lines.push('    ' + JSON.stringify(c.argv) + ' exit ' + (c.code ?? 'unavailable'));
    }
  }
  if (r.reason) lines.push(r.reason);
  for (const warning of r.warnings ?? []) lines.push('Scope: ' + warning.message);
  for (const error of r.cleanupErrors ?? []) lines.push('Cleanup: ' + error.message);
  if (r.replay) lines.push('Replay argv: ' + JSON.stringify(r.replay));
  if (r.receipt) lines.push('Receipt: ' + r.receipt);
  return lines.join('\n');
}

function canonicalClaim(file) {
  try { return fs.realpathSync.native(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Deactivation also works after the claim file has been removed.
    try { return path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file)); }
    catch (parentError) { if (parentError.code !== 'ENOENT') throw parentError; return file; }
  }
}

function missingClaim(repo, file) {
  const shown = path.relative(repo, file) || file;
  return { reason: 'Claim file is missing: ' + shown + '. Run "verb deactivate ' + shown +
    '" to retire its saved baseline, or restore the file.' };
}

function* proofs(repo, store, file, matches = () => true) {
  const dir = path.join(store, 'receipts');
  const files = file ? [file] : recent(dir).concat(entries(dir).filter(e => e.isDirectory())
    .flatMap(e => recent(path.join(dir, e.name))))
    .sort(receiptOrder).map(e => e.file);
  let id;
  for (const stored of files) {
    const r = readReceipt(file ?? stored);
    const target = r.sides?.candidate ?? r.target;
    if (r.action !== 'prove' || r.repo !== repo || !matches(r)) continue;
    if (r.targetUnavailable) { yield { r, file: stored }; continue; }
    if (target?.kind !== 'working') continue;
    id ??= working(repo).id;
    if (target.id === id) yield { r, file: stored };
  }
}

function status(repo, store, { file, active }) {
  const result = { action: 'status', verdict: 'inconclusive' };
  if (active) {
    const dir = path.join(store, 'baselines');
    const claims = entries(dir).filter(e => e.isDirectory())
      .map(e => readBaseline(path.join(dir, e.name, 'current.json')))
      .filter(saved => saved && (saved.verdict === 'verified' || saved.active));
    if (!claims.length) return { ...result, active: 0, verdict: 'verified', reason: 'No active VERB claims.' };
    result.active = claims.length;
    const pending = new Map(), noted = new Set();
    for (const saved of claims) {
      const baseline = saved.claimPath ? saved : readReceipt(saved.receipt);
      const claimPath = canonicalClaim(baseline.claimPath ?? baseline.replay[2]);
      if (!fs.existsSync(claimPath)) return { ...result, ...missingClaim(repo, claimPath) };
      let digest;
      try { digest = freeze(claimPath).digest; }
      catch (error) {
        if (error.code === 'ENOENT') return { ...result, ...missingClaim(repo, claimPath) };
        throw error;
      }
      if (digest !== saved.digest || saved.verdict !== 'verified') {
        return { ...result, reason: 'Run baseline again for ' + path.relative(repo, claimPath) + '.' };
      }
      pending.set(claimPath, { digest: saved.digest, base: (baseline.base ?? baseline.sides.base).id,
        baselineReceipt: saved.receipt });
    }
    const receiptClaim = r => (r.claimPath ?? r.replay?.[2]) && canonicalClaim(r.claimPath ?? r.replay[2]);
    for (const { r } of proofs(repo, store, undefined, r => pending.has(receiptClaim(r)))) {
      const claimPath = receiptClaim(r);
      if (r.format !== receiptFormat) return { ...result, reason: 'Legacy proof has no publication sequence. Run prove for ' + claimPath + '.' };
      const { digest, base, baselineReceipt } = pending.get(claimPath);
      if (r.verdict !== 'verified' || r.digest !== digest || r.sides.base.id !== base ||
          r.baselineReceipt !== baselineReceipt) break;
      const problem = proofProblem(store, hash(claimPath), r);
      if (problem) return { ...result, reason: problem };
      for (const warning of r.warnings ?? []) noted.add(warning.message);
      pending.delete(claimPath);
      if (!pending.size) return { ...result, verdict: 'verified', workingDigest: r.sides.candidate.id,
        warnings: [...noted].map(message => ({ code: 'scope', message })),
        reason: 'All active claims have a fresh verified proof.' };
    }
    return { ...result, reason: 'Run prove for ' + [...pending.keys()].map(p => path.relative(repo, p)).join(', ') + '.' };
  }
  const latest = proofs(repo, store, file).next().value;
  if (!latest) return { ...result, reason: 'No proof receipt matches the current working tree.' };
  result.receipt = latest.file;
  if (!file && latest.r.format !== receiptFormat) return { ...result, reason: 'Legacy proof has no publication sequence. Run prove again.' };
  if (latest.r.verdict !== 'verified') return { ...result, reason: 'Matching proof was not verified.' };
  const claimPath = latest.r.claimPath ?? latest.r.replay?.[2];
  if (typeof claimPath !== 'string') return { ...result, reason: 'Proof lacks claim identity; run prove again.' };
  const problem = proofProblem(store, hash(canonicalClaim(claimPath)), latest.r);
  if (problem) return { ...result, reason: problem };
  return { ...result, verdict: 'verified', warnings: latest.r.warnings ?? [], reason: 'Working files match a verified proof.' };
}

function absoluteArgument(arg, paths) {
  if (paths.isAbsolute(arg)) return arg;
  const equals = arg.indexOf('=');
  if (equals > 0 && paths.isAbsolute(arg.slice(equals + 1))) return arg.slice(equals + 1);
}

function summary(r) {
  const claimPath = r.claimPath ?? r.replay?.[2];
  const lines = [`VERB ${r.verdict.toUpperCase()} (${r.action}): ${r.claim ?? '(unavailable)'}`];
  // Stored paths belong to the receipt's OS, not necessarily the reviewer's host.
  const paths = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(r.repo) ? path.win32 : path.posix;
  const relative = file => {
    const root = r.repoAliases?.find(alias => {
      const rel = paths.relative(alias, file);
      return rel !== '..' && !rel.startsWith('..' + paths.sep) && !paths.isAbsolute(rel);
    }) ?? r.repo;
    const rel = paths.relative(root, file);
    return paths.isAbsolute(rel) ? '(outside repository volume)' : rel.split(paths.sep).join('/');
  };
  if (claimPath) lines.push('Claim: ' + relative(claimPath));
  lines.push('Claim digest (SHA-256): ' + (r.digest ?? '(unavailable)'));
  const excerpt = value => JSON.stringify(value.length > 320 ? value.slice(0, 319) + '…' : value);
  if (r.reason) lines.push('Reason: ' + excerpt(r.reason));
  for (const role of ['base', 'candidate']) {
    const side = r.sides[role];
    lines.push(role + ': ' + (side ? `${side.kind} ${side.id}` : 'not run'));
    if (!side && role === 'candidate' && r.target) lines.push('  Intended target: ' + r.target.kind + ' ' + r.target.id);
    if (side?.origin) lines.push('  Origin: ' + side.origin.split(paths.sep).join('/'));
    if (side?.reason) {
      const command = side.commands.at(-1);
      lines.push('  ' + role + '/' + (command?.phase ?? 'snapshot') + ': ' + excerpt(side.reason));
      const detail = command?.stderr?.trim() || command?.error || (command?.code !== 0 && command?.stdout?.trim());
      if (detail) lines.push('  Diagnostic: ' + excerpt(detail));
    }
    for (const a of side?.assertions ?? []) {
      lines.push(`  ${a.pass ? 'PASS' : 'MISS'} ${a.key}${a.control ? ' [control]' : ''}: expected ${JSON.stringify(a.expected)}, observed ${JSON.stringify(a.actual)}`);
    }
  }
  for (const error of r.cleanupErrors ?? []) lines.push('Cleanup: ' + excerpt(error.message));
  const executed = r.sides.candidate?.commands.filter(c => c.phase === 'required') ?? [];
  const relativeArg = arg => {
    const absolute = absoluteArgument(arg, paths);
    return absolute ? arg.slice(0, arg.length - absolute.length) + relative(absolute) : arg;
  };
  for (const [i, argv] of (r.required ?? []).entries()) {
    const args = argv.map(relativeArg);
    lines.push(`Required ${JSON.stringify(args)}: ${executed[i] ? 'exit ' + (executed[i].code ?? 'unavailable') : 'not run'}`);
  }
  for (const warning of r.warnings ?? []) lines.push('Scope: ' + warning.message);
  return lines.join('\n');
}

// Cleanup is evidence too: failed deletion must never bypass the attempt's receipt.
function cleanupSnapshot(dir, receipt) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  } catch (error) {
    (receipt.cleanupErrors ??= []).push({ path: dir, message: error.message });
    receipt.verdict = 'inconclusive';
    receipt.reason ??= 'snapshot cleanup failed';
    return false;
  }
}

async function main() {
  const opts = argumentsFor(process.argv.slice(2));
  if (opts.action === 'summary') {
    console.log(summary(readReceipt(opts.file)));
    return 0;
  }
  const repo = fs.realpathSync.native(git(process.cwd(), ['rev-parse', '--show-toplevel']).trim());
  const store = path.join(git(repo, ['rev-parse', '--absolute-git-dir']).trim(), 'verb');
  if (opts.action === 'status') {
    const result = status(repo, store, opts);
    console.log(opts.json ? JSON.stringify(result) : textReport(result));
    return codes[result.verdict];
  }
  opts.file = canonicalClaim(opts.file);
  const claimKey = hash(opts.file);
  const slot = path.join(store, 'baselines', claimKey, 'current.json');
  if (opts.action === 'deactivate') {
    const slots = new Set([slot]);
    // Also retire old alias-keyed slots, including differently cased names of deleted Windows files.
    const baselines = path.join(store, 'baselines');
    for (const entry of entries(baselines).filter(e => e.isDirectory())) {
      const current = path.join(baselines, entry.name, 'current.json');
      const saved = load(current);
      const baseline = saved?.claimPath ? saved : saved?.receipt && load(saved.receipt);
      const claimPath = baseline?.claimPath ?? baseline?.replay?.[2];
      if (claimPath && path.relative(opts.file, canonicalClaim(claimPath)) === '') slots.add(current);
    }
    for (const current of slots) {
      const key = path.basename(path.dirname(current));
      withClaimLock(store, 'publish-' + key, () => fs.rmSync(current, { force: true }));
    }
    const result = { action: 'deactivate', verdict: 'verified', reason: 'Claim is no longer active.' };
    console.log(opts.json ? JSON.stringify(result) : textReport(result));
    return 0;
  }
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'verb-')));
  // Frequent focused checks can rotate without reading their command output.
  const runId = (opts.action === 'check' ? 'check-' : '') + randomUUID();
  const receipts = path.join(store, 'receipts', claimKey);
  const r = { action: opts.action, format: receiptFormat, repo, claimPath: opts.file,
    timestamp: new Date().toISOString(), verdict: 'inconclusive', sides: {}, replay: ['verb', opts.action, opts.file] };
  try {
    // Git's ceiling list cannot encode a temporary path containing its separator.
    // An invalid gitfile at our private scratch root stops the same upward search.
    if (temp.includes(path.delimiter)) fs.writeFileSync(path.join(temp, '.git'), 'VERB source archive\n', { flag: 'wx' });
    if (opts.action === 'prove') {
      r.targetKind = opts.candidate ? 'commit' : 'working';
      // Keep failed attempts visible to status even if baseline/setup aborts before the candidate runs.
      if (!opts.candidate) r.target = working(repo);
      r.baselineReceipt = readBaseline(slot)?.receipt;
    }
    const bundle = path.join(temp, 'frozen');
    const { spec, digest, contents, scope, warnings } = freeze(opts.file, bundle);
    Object.assign(r, { claim: spec.claim, digest, required: spec.required, scope, warnings });
    if (process.platform === 'win32') {
      const aliases = new Set();
      for (const arg of spec.required.flat()) {
        const file = absoluteArgument(arg, path);
        const alias = file && windowsRootAlias(repo, file);
        if (alias) aliases.add(alias);
      }
      if (aliases.size) r.repoAliases = [...aliases];
    }
    const base = opts.base && resolveRef(repo, opts.base);
    if (base) r.replay.push('--base', base);
    const candidate = opts.candidate && resolveRef(repo, opts.candidate);
    if (candidate) r.replay.push('--candidate', candidate);
    const perform = async (role, commit, suites) => {
      if (interrupted) throw Error('interrupted');
      const sideDir = path.join(temp, randomUUID());
      try {
        const tree = path.join(sideDir, 'tree');
        fs.mkdirSync(tree, { recursive: true });
        const index = path.join(sideDir, 'index');
        const identity = commit ? checkout(repo, commit, tree, index, spec.link ?? []) : working(repo, tree, spec.link ?? []);
        if (role === 'candidate') r.target = identity;
        if (commit) fs.rmSync(index, { force: true });
        const side = { ...identity, commands: [] };
        r.sides[role] = side;
        const privateBundle = path.join(sideDir, 'bundle');
        copyFixtures(spec.fixtures, bundle, privateBundle);
        await runSide(side, spec, privateBundle, tree, path.join(sideDir, 'profile'), role, suites, invocation.signal);
        detectConflicts(store, claimKey, digest, role, side);
        return side;
      } finally {
        // A surviving sibling would disclose which side is running, even with random names.
        if (!cleanupSnapshot(sideDir, r)) {
          throw Object.assign(Error('snapshot cleanup failed'), { cause: r.sides[role]?.reason });
        }
      }
    };
    if (opts.action === 'check') {
      if (!fs.existsSync(slot)) throw Error('Run baseline first.');
      const saved = readBaseline(slot);
      if (saved.digest !== digest || saved.verdict !== 'verified') throw Error('Baseline invalid or claim changed. Run baseline again.');
      r.sides.base = { ...(saved.base ?? readReceipt(saved.receipt).sides.base), cached: true };
      // Check history too: an intervening prove may have contradicted this saved observation.
      detectConflicts(store, claimKey, digest, 'base', r.sides.base);
    } else {
      await perform('base', base, false);
    }
    let last = r.sides.base;
    if (last.verdict === 'verified' && opts.action !== 'baseline') {
      last = await perform('candidate', candidate, opts.action === 'prove');
    }
    r.verdict = last.verdict;
    r.reason = last.reason;
    if (opts.action === 'baseline' && r.verdict === 'verified') {
      const saved = path.join(store, 'baselines', hash(opts.file), runId);
      copyFixtures(spec.fixtures, bundle, path.join(saved, 'fixtures'));
      fs.writeFileSync(path.join(saved, 'claim.json'), contents);
      r.frozen = saved;
    }
  } catch (error) {
    r.verdict = 'inconclusive';
    r.reason = error.cause ? error.cause + '; ' + error.message : error.message;
    if (error.field) r.field = error.field;
  } finally {
    cleanupSnapshot(temp, r);
  }
  if (interrupted) Object.assign(r, { verdict: 'inconclusive', reason: 'interrupted' });
  for (const side of Object.values(r.sides)) {
    if (!side.verdict) Object.assign(side, { verdict: 'inconclusive', reason: r.reason });
  }
  if (r.targetKind === 'working' && !r.target) r.targetUnavailable = true;
  return finalize({ r, opts, store, claimKey, slot, receipts, runId, interrupted });
}

// The single approval rule after execution: recheck the read-only eligibility of the
// decision against completed history (cleanup is slow, so another run may have won),
// then persist the attempt, save baseline state, and prune only old receipts.
function finalize({ r, opts, store, claimKey, slot, receipts, runId, interrupted: stopped }) {
  // Cleanup may be slow: another completed execution can invalidate this decision.
  // Status repeats this read-only revision check, including after receipt publication.
  if (r.verdict === 'verified') {
    try {
      for (const [role, side] of Object.entries(r.sides)) {
        const problem = currentConflict(store, claimKey, r.digest, role, side);
        if (problem) { Object.assign(r, { verdict: 'inconclusive', reason: problem }); break; }
      }
    } catch (error) { Object.assign(r, { verdict: 'inconclusive', reason: error.message }); }
  }
  withClaimLock(store, 'publish-' + claimKey, () => {
    let saved;
    try { saved = readBaseline(slot); }
    catch (error) {
      // Preserve the attempt and all evidence until baseline ownership is readable.
      Object.assign(r, { verdict: 'inconclusive', reason: error.message });
      publishReceipt(store, receipts, runId, r);
      return;
    }
    publishReceipt(store, receipts, runId, r);
    if (opts.action === 'baseline' && !stopped) {
      saved = { format: baselineFormat, receipt: r.receipt, claimPath: opts.file, verdict: r.verdict, digest: r.digest,
        base: r.sides.base, active: Boolean(r.verdict === 'verified' || saved?.verdict === 'verified' || saved?.active) };
      saveJSON(slot, saved);
    }
    for (const file of prune(receipts, saved)) {
      const archiveId = receiptRunId(file);
      if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(archiveId)) {
        fs.rmSync(path.join(path.dirname(slot), archiveId), { recursive: true, force: true });
      }
    }
  });
  console.log(opts.json ? JSON.stringify(r) : textReport(r));
  return codes[r.verdict];
}

if (process.argv.includes('--help') || process.argv.includes('-h')) console.log(usage);
else {
  try { process.exitCode = await main(); }
  catch (error) {
    const result = { action: 'verb', verdict: 'inconclusive', reason: error.message };
    console.error(process.argv.includes('--json') ? JSON.stringify(result) : textReport(result));
    process.exitCode = 2;
  }
}

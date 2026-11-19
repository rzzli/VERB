#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkout, copyFixtures, freeze, git, hash, readJSON, resolveRef, saveJSON, working } from '../lib/files.js';
import { interrupt, runSide } from '../lib/run.js';

const usage = 'VERB — Verify Expected Runtime Behavior\n\nverb baseline CLAIM --base REF\nverb check CLAIM\nverb prove CLAIM --base REF [--candidate REF]\nverb status RECEIPT\nAdd --json for machine-readable output. Run from the target Git repository.';
const codes = { verified: 0, failed: 1, inconclusive: 2 };
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; interrupt(); });

function argumentsFor(argv) {
  const [action, file, ...args] = argv;
  if (!['baseline', 'check', 'prove', 'status'].includes(action) || !file || file.startsWith('--')) throw Error(usage);
  const opts = { action, file: path.resolve(file), json: false };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--json') opts.json = true;
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
      for (const c of executed) lines.push('    ' + JSON.stringify(c.argv) + ' exit ' + c.code);
    }
  }
  if (r.reason) lines.push(r.reason);
  if (r.replay) lines.push('Replay argv: ' + JSON.stringify(r.replay));
  if (r.receipt) lines.push('Receipt: ' + r.receipt);
  return lines.join('\n');
}

// Only compare completed observations. A setup failure carries no behavioral evidence.
function detectConflicts(store, digest, side) {
  if (!side.assertions) return;
  const dir = path.join(store, 'history', hash(JSON.stringify([digest, side.kind, side.id, process.platform, process.arch])));
  const file = path.join(dir, randomUUID() + '.json');
  const record = { obs: side.observations, suites: side.commands.filter(c => c.phase === 'required' && !c.error).map(c => c.code) };
  if (!side.cached) saveJSON(file, record);
  for (const entry of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const prev = readJSON(path.join(dir, entry));
    if (JSON.stringify(prev.obs) !== JSON.stringify(record.obs) ||
        prev.suites.some((code, i) => i < record.suites.length && record.suites[i] !== code)) {
      side.verdict = 'inconclusive';
      side.reason = 'conflicting reruns for the same input and frozen claim';
      break;
    }
  }
}

async function main() {
  const opts = argumentsFor(process.argv.slice(2));
  const repo = fs.realpathSync(git(process.cwd(), ['rev-parse', '--show-toplevel']).trim());
  const store = path.join(git(repo, ['rev-parse', '--absolute-git-dir']).trim(), 'verb');
  if (opts.action === 'status') {
    const old = readJSON(opts.file);
    const same = old.repo === repo && old.sides?.candidate?.kind === 'working' &&
      old.sides.candidate.id === working(repo).id;
    const result = { action: 'status', verdict: same ? 'verified' : 'inconclusive',
      reason: same ? 'Working files match this receipt.' : 'Working files changed or receipt is not for this working tree.' };
    console.log(opts.json ? JSON.stringify(result) : textReport(result));
    return codes[result.verdict];
  }
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verb-')));
  const runId = randomUUID();
  const receipt = path.join(store, 'receipts', runId + '.json');
  const slot = path.join(store, 'baselines', hash(opts.file), 'current.json');
  const r = { action: opts.action, repo, receipt, timestamp: new Date().toISOString(), verdict: 'inconclusive',
    sides: {}, replay: ['verb', opts.action, opts.file] };
  try {
    const bundle = path.join(temp, 'frozen');
    const { spec, digest } = freeze(opts.file, bundle);
    Object.assign(r, { claim: spec.claim, digest, required: spec.required });
    const base = opts.base && resolveRef(repo, opts.base);
    if (base) r.replay.push('--base', base);
    const candidate = opts.candidate && resolveRef(repo, opts.candidate);
    if (candidate) r.replay.push('--candidate', candidate);
    const perform = async (role, commit, suites) => {
      if (interrupted) throw Error('interrupted');
      const tree = path.join(temp, role, 'tree');
      fs.mkdirSync(tree, { recursive: true });
      const identity = commit ? checkout(repo, commit, tree, path.join(temp, role + '.index')) : working(repo, tree);
      const side = { ...identity, commands: [] };
      r.sides[role] = side;
      const privateBundle = path.join(temp, role, 'bundle');
      copyFixtures(spec.fixtures, bundle, privateBundle);
      await runSide(side, spec, privateBundle, tree, path.join(temp, role, 'profile'), role, suites);
      detectConflicts(store, digest, side);
      return side;
    };
    if (opts.action === 'check') {
      if (!fs.existsSync(slot)) throw Error('Run baseline first.');
      const saved = readJSON(slot);
      if (saved.digest !== digest || saved.verdict !== 'verified') throw Error('Baseline invalid or claim changed. Run baseline again.');
      const baseline = readJSON(saved.receipt);
      r.sides.base = { ...baseline.sides.base, cached: true };
      // Check history too: an intervening prove may have contradicted this saved observation.
      detectConflicts(store, digest, r.sides.base);
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
      saveJSON(path.join(saved, 'claim.json'), spec);
      r.frozen = saved;
    }
  } catch (error) {
    r.verdict = 'inconclusive';
    r.reason = error.message;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  if (interrupted) Object.assign(r, { verdict: 'inconclusive', reason: 'interrupted' });
  saveJSON(receipt, r);
  if (opts.action === 'baseline') saveJSON(slot, { receipt, verdict: r.verdict, digest: r.digest });
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

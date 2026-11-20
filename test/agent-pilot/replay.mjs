// Development evidence only; excluded from the published package.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../git-environment.mjs';

const evidence = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(evidence, '../..');
const args = process.argv.slice(2);
const currentRunner = args.includes('--current');
const integrated = args.includes('--integrated');
const selected = args.includes('--case') ? args[args.indexOf('--case') + 1] : undefined;
const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : undefined;
const cases = [
  { id: '01-attributes', platforms: ['win32', 'linux', 'darwin'] },
  { id: '02-env-case', platforms: ['win32'] },
  { id: '03-fixture-modes', platforms: ['linux', 'darwin'] },
  { id: '04-portable-summary', platforms: ['linux'] },
  { id: '05-timeout-pipes', platforms: ['win32', 'linux', 'darwin'] }
];
if (selected && !cases.some(c => c.id === selected)) throw Error('Unknown trial: ' + selected);
const tempRoot = fs.realpathSync(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(tempRoot, 'verb-pilot-replay-'));
const seed = path.join(scratch, 'seed');
const results = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function run(cwd, exe, argv) {
  const p = spawnSync(exe, argv, { cwd, encoding: 'utf8', windowsHide: true,
    timeout: 240000, maxBuffer: 32 * 1024 * 1024 });
  assert.ifError(p.error);
  return p;
}
function git(cwd, ...argv) {
  const p = run(cwd, 'git', argv);
  assert.equal(p.status, 0, p.stderr + p.stdout);
  return p.stdout.trim();
}
function clone(source, dest) {
  git(scratch, '-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-hardlinks', source, dest);
  git(dest, 'config', 'core.autocrlf', 'false');
}
function verify(repo, cli, claim, base, action) {
  const start = Date.now();
  const p = run(repo, process.execPath, [cli, action, claim, '--base', base, '--json']);
  const receipt = JSON.parse(p.stdout || p.stderr);
  return { code: p.status, receipt, ms: Date.now() - start };
}
try {
  clone(path.join(evidence, 'baseline.bundle'), seed);
  const cli = path.join(currentRunner ? project : seed, 'bin/verb.js');
  for (const trial of cases.filter(c => !selected || c.id === selected)) {
    if (!trial.platforms.includes(process.platform)) {
      results.push({ id: trial.id, skipped: 'requires ' + trial.platforms.join('/') });
      continue;
    }
    const dir = path.join(evidence, trial.id);
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'trial.json'), 'utf8'));
    const review = JSON.parse(fs.readFileSync(path.join(dir, 'review.json'), 'utf8'));
    assert.ok(Date.parse(record.setupStartedAt) <= Date.parse(record.baseline.finishedAt));
    assert.ok(Date.parse(record.baseline.finishedAt) < Date.parse(record.firstCandidate.capturedAt));
    const reviewAt = review.recordedAt ?? review.reviewedAt;
    assert.ok(Date.parse(record.firstCandidate.capturedAt) <= Date.parse(reviewAt));
    assert.ok(Date.parse(reviewAt) < Date.parse(record['first-candidate'].startedAt));
    const patch = fs.readFileSync(path.join(dir, 'first-candidate.patch'));
    assert.equal(hash(patch), record.firstCandidate.patchSha256, 'Original first patch changed');
    const repo = path.join(scratch, trial.id);
    clone(seed, repo);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), record.baselineCommit);
    if (integrated) {
      // Include current source/docs/tests, but not this historical evidence bundle or ignored tools.
      const names = git(project, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
      for (const name of new Set(names)) {
        if (name.startsWith('test/agent-pilot/')) continue;
        const source = path.join(project, name);
        if (!fs.existsSync(source)) continue;
        const dest = path.join(repo, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(source, dest);
      }
    } else git(repo, 'apply', '--whitespace=nowarn', path.join(dir, 'first-candidate.patch'));
    const claim = path.join(dir, 'claim.json');
    const baseline = verify(repo, cli, claim, record.baselineCommit, 'baseline');
    assert.equal(baseline.code, 0, JSON.stringify(baseline.receipt));
    const proof = verify(repo, cli, claim, record.baselineCommit, 'prove');
    const expected = integrated ? 0 : record['first-candidate'].code;
    assert.equal(proof.code, expected, JSON.stringify(proof.receipt));
    if (!currentRunner) {
      const expectedDigest = record.normalizedReplayDigest ?? record.baseline.digest;
      assert.equal(proof.receipt.digest, expectedDigest, 'Frozen input bytes changed');
    }
    if (proof.code === 0) {
      const required = proof.receipt.sides.candidate.commands.filter(c => c.phase === 'required');
      assert.equal(required.length, proof.receipt.required.length);
      assert.ok(required.every(c => c.code === 0 && !c.error));
    }
    const result = { id: trial.id, verdict: proof.receipt.verdict, code: proof.code,
      baselineMs: baseline.ms, proofMs: proof.ms, digest: proof.receipt.digest };
    results.push(result);
    console.error(JSON.stringify(result));
  }
  const report = JSON.stringify({ recordedAt: new Date().toISOString(), platform: process.platform, node: process.version,
    runner: currentRunner ? 'current' : 'frozen seed', candidate: integrated ? 'integrated current source' : 'original first patches', results }, null, 2);
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, report + '\n');
  }
  console.log(report);
} finally {
  // Delete only the exact temporary tree allocated above, never caller/project paths.
  assert.equal(path.dirname(path.resolve(scratch)), tempRoot);
  assert.ok(path.basename(scratch).startsWith('verb-pilot-replay-'));
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

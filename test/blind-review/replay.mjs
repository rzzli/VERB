// Usage: node replay.mjs CLICK_CLONE REGEXP_CLONE NEW_OUTPUT [--case ID] [--phase freeze|score|report]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { trials, challengeSource } from './challenges.mjs';
import { freeze, saveJSON, working } from '../../lib/files.js';
import '../git-environment.mjs';

// The frozen PCRE probe distinguishes compile errors by Git's diagnostic.
process.env.LC_ALL = 'C';
process.env.LANGUAGE = 'C';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../../bin/verb.js');
const { positionals, values } = parseArgs({
  allowPositionals: true, options: { case: { type: 'string' }, phase: { type: 'string' } }
});
const phase = values.phase ?? 'both';
if (positionals.length !== 3 || !['freeze', 'score', 'report', 'both'].includes(phase)) {
  throw Error('Supply local Click and escape-string-regexp clones and a new output directory; optionally --case ID --phase freeze|score|report.');
}
const [click, regexp, output] = positionals.map(p => path.resolve(p));
const selected = trials.filter(t => !values.case || t.id === values.case);
assert.ok(selected.length, 'Unknown case');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const challengeFile = path.join(here, 'challenges.mjs');
const challengeDigest = sha(fs.readFileSync(challengeFile));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});

function run(cwd, exe, args, env = process.env) {
  const p = spawnSync(exe, args, {cwd, env, timeout: 180000, maxBuffer: 16 * 1024 * 1024,
    windowsHide: true, encoding: 'utf8'});
  assert.ifError(p.error);
  assert.notEqual(p.status, null, p.stderr);
  return p;
}
function git(cwd, ...args) {
  const result = run(cwd, 'git', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd();
}

function execute({repo, claim, dir}, stage, args) {
  const start = performance.now();
  const result = run(repo, process.execPath, [cli, args[0], claim, ...args.slice(1), '--json']);
  const ms = Math.round(performance.now() - start);
  const receipt = JSON.parse(result.stdout || result.stderr);
  assert.equal(result.status, {verified: 0, failed: 1, inconclusive: 2}[receipt.verdict]);
  assert.ok(receipt.receipt, JSON.stringify(receipt));
  const bytes = fs.readFileSync(receipt.receipt);
  fs.writeFileSync(path.join(dir, stage + '.receipt.json'), bytes, {flag: 'wx'});
  return {receipt, ms, receiptSha256: sha(bytes)};
}

function freezeCase(job) {
  const {trial, dir, repo, source} = job;
  fs.mkdirSync(dir); // Require a fresh case. Preserve earlier attempts.
  fs.mkdirSync(repo);
  const base = git(source, 'rev-parse', trial.fix + '^1');
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false');
  // Fetch exactly the broken commit. The review repository has no candidate ref yet.
  git(repo, 'fetch', '-q', '--no-tags', source, base);
  git(repo, 'checkout', '-q', '--detach', base);
  const baseline = execute(job, 'baseline', ['baseline', '--base', base]);
  const {receipt} = baseline;
  assert.equal(receipt.verdict, 'verified', receipt.reason);
  assert.equal(receipt.sides.base.id, base);
  const frozen = {id: trial.id, base, digest: receipt.digest, challengeDigest,
    frozenAt: new Date().toISOString(), baselineMs: baseline.ms, baselineReceiptSha256: baseline.receiptSha256,
    baselineObservations: receipt.sides.base.observations};
  save(path.join(dir, 'freeze.json'), frozen);
  console.log('Frozen', trial.id, base, receipt.digest, frozen.frozenAt);
}

function runAuthor({trial, repo}, testFile) {
  const start = performance.now();
  let checks;
  if (trial.upstream === 'click') {
    const python = process.env.VERB_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const result = run(repo, python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...trial.author], {
      ...process.env, PYTHONPATH: path.join(repo, 'src'), PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1', PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1'
    });
    const passed = result.status === 0 && /\b1 passed\b/.test(result.stdout);
    const failed = result.status === 1 && /\b1 failed\b/.test(result.stdout);
    assert.ok(passed || failed, result.stdout + result.stderr);
    checks = [{name: trial.author[0], verdict: passed ? 'passed' : 'failed'}];
  } else {
    const p = run(repo, process.execPath, [path.join(here, 'author-regexp.cjs'), testFile, ...trial.author]);
    assert.equal(p.status, 0, p.stderr);
    checks = JSON.parse(p.stdout);
  }
  return {verdict: checks.every(c => c.verdict === 'passed') ? 'passed' : 'failed',
    ms: Math.round(performance.now() - start), checks};
}

function scoreCase(job) {
  const {trial, dir, repo, source} = job;
  const frozen = read(path.join(dir, 'freeze.json'));
  const baseline = read(path.join(dir, 'baseline.receipt.json'));
  assert.equal(frozen.challengeDigest, challengeDigest, 'Challenge definitions changed after freeze');
  assert.equal(freeze(job.claim).digest, frozen.digest, 'Blind inputs changed before candidate release');
  assert.equal(sha(fs.readFileSync(baseline.receipt)), frozen.baselineReceiptSha256);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), frozen.base, 'Use the untouched freeze checkout');
  assert.equal(git(repo, 'status', '--porcelain'), '', 'Unrelated changes in freeze checkout');
  assert.equal(frozen.base, git(source, 'rev-parse', trial.fix + '^1'));

  const revealedAt = new Date().toISOString();
  const fix = git(source, 'rev-parse', trial.fix + '^{commit}');
  git(repo, 'fetch', '-q', '--no-tags', source, fix);
  const testName = trial.upstream === 'click' ? trial.author[0].split('::')[0] : 'test.js';
  const testFile = path.join(repo, testName);
  // Apply the author's test to the parent, without taking implementation files
  // from the fix. The candidate checkout later restores the complete fixed tree.
  git(repo, 'restore', '--source', fix, '--', testName);
  const authorTestSha256 = sha(fs.readFileSync(testFile));
  const authorOnBase = runAuthor(job, testFile);
  assert.equal(authorOnBase.verdict, 'failed', 'Original regression test must distinguish the parent');
  git(repo, 'restore', '--', testName);
  git(repo, 'checkout', '-q', '--detach', fix);
  assert.equal(sha(fs.readFileSync(testFile)), authorTestSha256);

  function compare(stage, candidateArgs) {
    const proof = execute(job, stage, ['prove', '--base', frozen.base, ...candidateArgs]);
    const r = proof.receipt;
    assert.equal(r.digest, frozen.digest, 'Blind claim or fixtures changed after freeze');
    assert.equal(r.sides.base?.id, frozen.base);
    assert.equal(r.baselineReceipt, baseline.receipt, 'Proof does not use the frozen baseline slot');
    if (r.sides.candidate) {
      if (candidateArgs.length) {
        assert.equal(r.sides.candidate.id, git(repo, 'rev-parse', 'HEAD'));
        assert.equal(git(repo, 'status', '--porcelain'), '');
      } else assert.equal(r.sides.candidate.id, working(repo).id, 'Working files changed before author test');
    }
    assert.equal(sha(fs.readFileSync(testFile)), authorTestSha256, 'The author test was edited');
    const author = runAuthor(job, testFile);
    const candidate = r.sides.candidate;
    const misses = (candidate?.assertions ?? []).filter(a => !a.pass).map(a => a.key);
    const blindBehavior = !candidate?.assertions ? 'inconclusive' : misses.length ? 'failed' : 'passed';
    return {stage, author, blindBehavior, blindProof: r.verdict, blindMs: proof.ms, misses,
      observed: candidate?.observations, testedId: candidate?.id, required: candidate?.commands
        .filter(c => c.phase === 'required').map(c => ({code: c.code, ms: c.ms})),
      receiptSha256: proof.receiptSha256};
  }
  const genuine = compare('genuine', ['--candidate', fix]);
  assert.equal(genuine.author.verdict, 'passed');
  const production = path.join(repo, trial.source);
  const good = fs.readFileSync(production, 'utf8');
  const challenges = [];
  try {
    for (const [i, edit] of trial.challenges.entries()) {
      fs.writeFileSync(production, challengeSource(good, edit));
      challenges.push({label: edit[0], ...compare('challenge-' + (i + 1), [])});
    }
  } finally { fs.writeFileSync(production, good); }
  const result = {...frozen, fix, revealedAt, authorTestSha256, authorOnBase, genuine, challenges};
  save(path.join(dir, 'result.json'), result);
  console.log(trial.id, genuine.blindProof, challenges.map(c => c.author.verdict + '/' + c.blindBehavior).join(' '));
}

function report() {
  const cases = selected.map(({id}) => {
    const dir = path.join(output, id);
    const result = read(path.join(dir, 'result.json'));
    assert.equal(result.challengeDigest, challengeDigest);
    for (const [stage, digest] of [['baseline', result.baselineReceiptSha256],
      ...[result.genuine, ...result.challenges].map(r => [r.stage, r.receiptSha256])]) {
      assert.equal(sha(fs.readFileSync(path.join(dir, stage + '.receipt.json'))), digest);
    }
    for (const c of result.challenges) {
      c.newMisses = c.misses.filter(key => Object.hasOwn(result.genuine.observed ?? {}, key) &&
        !result.genuine.misses.includes(key));
      c.incrementalCatch = result.genuine.blindProof !== 'inconclusive' && c.blindProof === 'failed' &&
        result.genuine.author.verdict === 'passed' &&
        c.author.verdict === 'passed' && c.newMisses.length > 0;
      c.decisionCatch = c.incrementalCatch && result.genuine.blindProof === 'verified';
    }
    return result;
  });
  const all = cases.flatMap(c => c.challenges);
  const results = {challengeDigest, cases, counts: {
    challenges: all.length,
    authorAccepted: all.filter(c => c.author.verdict === 'passed').length,
    incrementalCatches: all.filter(c => c.incrementalCatch).length,
    decisionCatches: all.filter(c => c.decisionCatch).length,
    genuineBlindVerified: cases.filter(c => c.genuine.blindProof === 'verified').length
  }};
  // The aggregate can be regenerated from the immutable per-case captures.
  saveJSON(path.join(output, 'results.json'), results);
  console.log(JSON.stringify(results.counts));
}

fs.mkdirSync(output, {recursive: true});
if (phase !== 'report') for (const trial of selected) {
  const dir = path.join(output, trial.id);
  const job = {trial, dir, repo: path.join(dir, 'repo'), source: trial.upstream === 'click' ? click : regexp,
    claim: path.join(here, 'cases', trial.id, 'claim.json')};
  if (phase !== 'score') freezeCase(job);
  if (phase !== 'freeze') scoreCase(job);
}
if (phase === 'report' || (phase === 'both' && !values.case)) report();

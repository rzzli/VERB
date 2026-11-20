import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fixture, project, verb, write } from './helpers.js';

const hook = path.join(project, 'hooks/verify.mjs');
const cli = path.join(project, 'bin/verb.js');

function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  return result;
}

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.ifError(child.error);
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(child.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return child.pid; throw error; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw Error('Could not observe an exited helper process');
}

function lockFile(f) {
  const key = createHash('sha256').update(fs.realpathSync.native(f.claim)).digest('hex');
  return path.join(f.repo, '.git', 'verb', 'locks', key + '.lock');
}

function proven(t, claimName) {
  const f = fixture(t);
  if (claimName) {
    const renamed = path.join(f.dir, claimName);
    fs.renameSync(f.claim, renamed);
    f.claim = renamed;
  }
  run([cli, 'baseline', f.claim, '--base', 'HEAD', '--json'], f.repo);
  write(path.join(f.repo, 'value'), 'new');
  const proof = run([cli, 'prove', f.claim, '--base', 'HEAD', '--json'], f.repo);
  assert.equal(proof.status, 0, proof.stdout + proof.stderr);
  return f;
}

test('a deleted claim names the deactivation path instead of a raw ENOENT', t => {
  const f = fixture(t);
  run([cli, 'baseline', f.claim, '--base', 'HEAD', '--json'], f.repo);
  fs.rmSync(f.claim);
  const status = run([cli, 'status', '--active', '--json'], f.repo);
  assert.equal(status.status, 2);
  const parsed = JSON.parse(status.stdout);
  assert.match(parsed.reason, /Claim file is missing/);
  assert.match(parsed.reason, /verb deactivate/);
  assert.doesNotMatch(parsed.reason, /^ENOENT:/);
  const stopped = run([hook, '--stop'], f.repo);
  assert.equal(stopped.status, 2);
  assert.match(stopped.stderr, /Claim file is missing/);
  assert.match(stopped.stderr, /verb deactivate/);
  const checked = run([cli, 'check', f.claim, '--json'], f.repo);
  assert.equal(checked.status, 2);
  assert.match(JSON.parse(checked.stdout).reason, /verb deactivate/);
});

test('a stale lock from a dead writer is recovered without waiting or manual cleanup', t => {
  const f = proven(t);
  const lock = lockFile(f);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid(), started: new Date(Date.now() - 60000).toISOString() }) + '\n');
  const started = performance.now();
  const status = run([cli, 'status', '--active', '--json'], f.repo);
  const elapsed = performance.now() - started;
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.ok(elapsed < 2000, 'stale lock should not wait for the retry window: ' + elapsed + 'ms');
  assert.equal(fs.existsSync(lock), false, 'stale lock file should be removed');
  const again = run([cli, 'prove', f.claim, '--base', 'HEAD', '--json'], f.repo);
  assert.equal(again.status, 0, again.stdout + again.stderr);
});

test('a live lock still fails closed but names the file, owner and recovery step', t => {
  const f = proven(t);
  const lock = lockFile(f);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }) + '\n');
  const started = performance.now();
  const status = run([cli, 'status', '--active', '--json'], f.repo);
  const elapsed = performance.now() - started;
  assert.equal(status.status, 2);
  const parsed = JSON.parse(status.stdout || status.stderr);
  assert.ok(elapsed >= 4500, 'a live lock should use the bounded wait: ' + elapsed + 'ms');
  assert.match(parsed.reason, /pid /);
  assert.ok(parsed.reason.includes(lock), parsed.reason);
  assert.match(parsed.reason, /remove this lock file/);
  assert.equal(fs.existsSync(lock), true, 'a live lock must not be removed');
});

test('hooks allow work outside a Git repository instead of surfacing Git discovery', t => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verb outside ')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  for (const mode of ['--stop', '--pre-commit']) {
    const result = run([hook, mode], outside);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /not inside a Git repository/);
    assert.doesNotMatch(result.stderr, /fatal:/);
  }
});

test('the missing claim hint identifies a usable absolute path from a subdirectory', t => {
  const f = proven(t, "someone's $claim! with ‘quotes’.json");
  fs.unlinkSync(f.claim);
  const sub = path.join(f.repo, 'nested');
  fs.mkdirSync(sub);
  const stopped = run([hook, '--stop'], sub);
  assert.equal(stopped.status, 2);
  const command = stopped.stderr.trimEnd().match(/with: (verb deactivate [\s\S]+)$/)?.[1];
  assert.ok(command, stopped.stderr);
  // Exercise copy/paste of the whole printed command with the documented shell.
  const windows = process.platform === 'win32';
  const ps = 'function verb { & $env:VERB_TEST_NODE $env:VERB_TEST_CLI @args --json }\n' + command + '\nexit $LASTEXITCODE';
  const args = windows ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')]
    : ['-c', 'verb() { "$VERB_TEST_NODE" "$VERB_TEST_CLI" "$@" --json; }\n' + command];
  const retired = spawnSync(windows ? 'powershell.exe' : 'sh', args, {
    cwd: sub, timeout: 30000, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, VERB_TEST_NODE: process.execPath, VERB_TEST_CLI: cli }
  });
  assert.ifError(retired.error);
  assert.equal(retired.status, 0, retired.stdout + retired.stderr);
  assert.equal(JSON.parse(retired.stdout).removed, 1);
  assert.equal(verb(sub, 0, 'status', '--active').active, 0);
});

test('deactivate reports a path mismatch and leaves the active claim in place', t => {
  const f = proven(t);
  const missed = verb(f.repo, 0, 'deactivate', 'claim.json');
  assert.equal(missed.removed, 0);
  assert.ok(missed.reason.includes(path.join(f.repo, 'claim.json')));
  assert.ok(missed.reason.includes('Still active: ' + f.claim));
  assert.equal(verb(f.repo, 0, 'status', '--active').active, 1);
  assert.equal(verb(f.repo, 0, 'deactivate', f.claim).removed, 1);
  assert.equal(verb(f.repo, 0, 'deactivate', f.claim).removed, 0);
});

test('a missing probe is reported as a fixture by both the hook and check', t => {
  const f = proven(t);
  fs.unlinkSync(f.probe);
  const stopped = run([hook, '--stop'], f.repo);
  assert.equal(stopped.status, 2);
  for (const reason of [stopped.stderr, verb(f.repo, 2, 'check', f.claim).reason]) {
    assert.ok(reason.includes('Fixture is missing: ' + f.probe), reason);
    assert.ok(reason.includes('(listed in ' + f.claim + ')'), reason);
    assert.match(reason, /verb deactivate /);
    assert.doesNotMatch(reason, /Claim file is missing/);
  }
});

for (const foreign of [false, true]) {
  test('keeps a lock with ' + (foreign ? 'a foreign host' : 'no readable owner'), t => {
    const f = proven(t);
    const lock = lockFile(f);
    const data = foreign ? { pid: deadPid(), host: 'other-host', token: 'other' } : {};
    write(lock, data);
    fs.utimesSync(lock, 100, 100);
    const status = verb(f.repo, 2, 'status', '--active');
    assert.ok(status.reason.includes(lock), status.reason);
    assert.ok(status.reason.includes(foreign ? 'other-host' : 'unknown writer'));
    assert.deepEqual(JSON.parse(fs.readFileSync(lock)), data);
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fixture, project, write } from './helpers.js';

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

function proven(t) {
  const f = fixture(t);
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

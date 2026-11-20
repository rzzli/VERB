import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withClaimLock } from '../lib/store.js';
import { clean, fixture, scratch, verb } from './helpers.js';

const worker = fileURLToPath(new URL('./lock-contender.mjs', import.meta.url));
const exec = promisify(execFile);
const storeFor = t => {
  const dir = scratch();
  t.after(() => clean(dir));
  return dir;
};

test('six contenders recover a killed writer without overlapping or leaking locks', async t => {
  const store = storeFor(t);
  const locks = path.join(store, 'locks');
  for (let i = 0; i < 8; i++) {
    const dead = spawnSync(process.execPath, [worker, 'leave-lock', store], { timeout: 15000 });
    assert.ifError(dead.error);
    assert.equal(JSON.parse(fs.readFileSync(path.join(locks, 'claim.lock'))).pid, dead.pid);
    const round = path.join(store, String(i));
    fs.mkdirSync(round);
    const workers = Array.from({ length: 6 }, (_, index) =>
      exec(process.execPath, [worker, 'contend', store, round, String(index)], { timeout: 25000 }));
    const results = await Promise.allSettled(workers);
    for (const result of results) assert.equal(result.status, 'fulfilled', String(result.reason));
    assert.deepEqual(fs.readdirSync(locks), []);
  }
});

test('releasing a lock preserves a replacement owner', t => {
  const store = storeFor(t);
  const lock = path.join(store, 'locks', 'claim.lock');
  const replacement = JSON.stringify({ pid: process.pid, token: 'replacement' });
  withClaimLock(store, 'claim', () => {
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, replacement);
  });
  assert.equal(fs.readFileSync(lock, 'utf8'), replacement);
});

test('a throwing critical section releases its lock', t => {
  const store = storeFor(t);
  assert.throws(() => withClaimLock(store, 'claim', () => { throw Error('failed work'); }), /failed work/);
  assert.deepEqual(fs.readdirSync(path.join(store, 'locks')), []);
  assert.equal(withClaimLock(store, 'claim', () => 42), 42);
});

for (const length of [0, 12]) {
  test('a failed owner write after ' + length + ' bytes releases its lock', t => {
    const store = storeFor(t);
    const write = fs.writeFileSync;
    const failure = Object.assign(Error('injected out of space'), { code: 'ENOSPC' });
    const injected = t.mock.method(fs, 'writeFileSync', (fd, owner) => {
      assert.equal(typeof fd, 'number');
      write(fd, owner.slice(0, length));
      throw failure;
    });
    assert.throws(() => withClaimLock(store, 'claim', () => assert.fail('unexpected work')), failure);
    injected.mock.restore();
    assert.deepEqual(fs.readdirSync(path.join(store, 'locks')), []);
    assert.equal(withClaimLock(store, 'claim', () => 42), 42);
  });
}

test('owner write failure preserves a different file installed at the lock path', t => {
  const store = storeFor(t);
  const lock = path.join(store, 'locks', 'claim.lock');
  const write = fs.writeFileSync;
  const replacement = 'a different owner';
  t.mock.method(fs, 'writeFileSync', (fd, owner) => {
    write(fd, owner.slice(0, 12));
    fs.unlinkSync(lock);
    write(lock, replacement);
    throw Error('injected write failure');
  });
  assert.throws(() => withClaimLock(store, 'claim', () => assert.fail('unexpected work')), /injected write failure/);
  assert.equal(fs.readFileSync(lock, 'utf8'), replacement);
});

for (const point of ['before-unlink', 'after-unlink']) {
  test('retires an abandoned takeover marker when its owner lock is gone (' + point + ')', t => {
    const f = fixture(t), store = path.join(f.repo, '.git', 'verb');
    const locks = path.join(store, 'locks');
    const lock = path.join(locks, 'claim.lock');
    const killed = spawnSync(process.execPath, [worker, 'leave-lock', store], { timeout: 15000 });
    assert.ifError(killed.error);
    const owner = fs.readFileSync(lock);
    const takeover = lock + '.reap-' + createHash('sha256').update(owner).digest('hex');
    const reaper = spawnSync(process.execPath, [worker, 'interrupt-recovery', store, point], { timeout: 15000 });
    assert.ifError(reaper.error);
    assert.ok(fs.existsSync(takeover));
    if (point === 'before-unlink') {
      // Older takeover markers have no owner identity. Preserve the marker while
      // its lock is still present, until the operator removes that exact lock.
      assert.throws(() => withClaimLock(store, 'claim', () => assert.fail('unexpected work')),
        error => error.code === 'history_busy' && error.lock === lock);
      assert.deepEqual(fs.readFileSync(lock), owner);
      fs.unlinkSync(lock);
      verb(f.repo, 0, 'status', '--active');
      assert.equal(fs.existsSync(takeover), false);
    }
    const other = path.join(locks, 'different.lock.reap-' + 'a'.repeat(64));
    fs.writeFileSync(other, '');
    assert.equal(withClaimLock(store, 'claim', () => 42), 42);
    assert.deepEqual(fs.readdirSync(locks), [path.basename(other)]);
  });
}

test('status preserves an active reaper between its last owner check and unlink', t => {
  const f = fixture(t), store = path.join(f.repo, '.git', 'verb');
  const lock = path.join(store, 'locks', 'claim.lock');
  const killed = spawnSync(process.execPath, [worker, 'leave-lock', store], { timeout: 15000 });
  assert.ifError(killed.error);
  const marker = lock + '.reap-' + createHash('sha256').update(fs.readFileSync(lock)).digest('hex');
  const unlink = fs.unlinkSync;
  let inspected = false;
  t.mock.method(fs, 'unlinkSync', file => {
    if (file === lock && !inspected) {
      inspected = true;
      verb(f.repo, 0, 'status', '--active');
      assert.ok(fs.existsSync(marker), 'active reaper must retain exclusive ownership');
    }
    return unlink(file);
  });
  withClaimLock(store, 'claim', () => assert.ok(inspected));
  assert.deepEqual(fs.readdirSync(path.dirname(lock)), []);
});

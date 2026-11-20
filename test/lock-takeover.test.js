import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withClaimLock } from '../lib/store.js';
import { clean, scratch } from './helpers.js';

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

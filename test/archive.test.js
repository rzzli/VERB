import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, write, verb } from './helpers.js';
import { copyFixtures, freeze } from '../lib/files.js';

function reconstruct(f, receipt) {
  const restored = path.join(f.dir, 'restored');
  fs.mkdirSync(restored);
  fs.copyFileSync(path.join(receipt.frozen, 'claim.json'), path.join(restored, 'claim.json'));
  const spec = JSON.parse(fs.readFileSync(path.join(restored, 'claim.json'), 'utf8').replace(/^\uFEFF/, ''));
  copyFixtures(spec.fixtures, path.join(receipt.frozen, 'fixtures'), restored);
  assert.equal(freeze(path.join(restored, 'claim.json')).digest, receipt.digest);
  return restored;
}

for (const format of ['compact', 'pretty', 'bom', 'lf', 'crlf']) {
  test(`archived ${format} claims reconstruct their exact original digest`, t => {
    const f = fixture(t);
    let bytes = JSON.stringify(f.spec, null, format === 'compact' ? undefined : 2);
    if (format === 'bom') bytes = '\uFEFF' + bytes;
    if (format === 'lf') bytes += '\n';
    if (format === 'crlf') bytes = bytes.replaceAll('\n', '\r\n') + '\r\n';
    write(f.claim, bytes);
    const initial = fs.readFileSync(f.claim), digest = freeze(f.claim).digest;
    const r = verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
    assert.equal(r.digest, digest);
    assert.deepEqual(fs.readFileSync(path.join(r.frozen, 'claim.json')), initial);
    reconstruct(f, r);
  });
}

test('archival uses captured claim bytes, not a reread after execution', t => {
  const f = fixture(t);
  write(f.claim, { ...f.spec, setup: [['{node}', '-e', `require('node:fs').appendFileSync(${JSON.stringify(f.claim)},'\\n')`]] });
  const initial = fs.readFileSync(f.claim);
  const r = verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  assert.notDeepEqual(fs.readFileSync(f.claim), initial);
  assert.deepEqual(fs.readFileSync(path.join(r.frozen, 'claim.json')), initial);
  reconstruct(f, r);
  assert.match(verb(f.repo, 2, 'status', '--active').reason, /baseline again/);
});

test('archive reconstruction retains POSIX executable identity', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), helper = path.join(f.dir, 'helper.sh');
  write(helper, '#!/bin/sh\nprintf frozen\n');fs.chmodSync(helper, 0o740);
  write(f.claim, { ...f.spec, fixtures: [...f.spec.fixtures, 'helper.sh'] });
  const r = verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  const restored = reconstruct(f, r);
  assert.equal(fs.statSync(path.join(restored, 'helper.sh')).mode & 0o111, 0o100);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { freeze, copyFixtures } from '../lib/files.js';
import { fixture, write } from './helpers.js';

test('frozen fixtures preserve executable bits and bind them into the digest', {skip: process.platform === 'win32'}, t => {
  const f = fixture(t);
  const helper = path.join(f.dir, 'helper.sh');
  write(helper, '#!/bin/sh\nprintf hello\n');
  fs.chmodSync(helper, 0o740);
  write(f.claim, {...f.spec, fixtures:[...f.spec.fixtures, 'helper.sh']});
  const bundle = path.join(f.dir, 'bundle'), privateBundle = path.join(f.dir, 'private');
  const first = freeze(f.claim, bundle);
  assert.equal(fs.statSync(path.join(bundle, 'helper.sh')).mode & 0o111, 0o100);
  copyFixtures(['helper.sh'], bundle, privateBundle);
  assert.equal(fs.statSync(path.join(privateBundle, 'helper.sh')).mode & 0o111, 0o100);
  fs.chmodSync(helper, 0o640);
  assert.notEqual(freeze(f.claim).digest, first.digest);
  freeze(f.claim, bundle);
  copyFixtures(['helper.sh'], bundle, privateBundle);
  assert.equal(fs.statSync(path.join(bundle, 'helper.sh')).mode & 0o111, 0);
  assert.equal(fs.statSync(path.join(privateBundle, 'helper.sh')).mode & 0o111, 0);
});

test('read-only fixtures retain execution under a restrictive umask without copying source write restrictions', {skip: process.platform === 'win32'}, t => {
  const f = fixture(t), helper = path.join(f.dir, 'helper.sh');
  write(helper, '#!/bin/sh\nprintf hello\n');
  fs.chmodSync(helper, 0o551);
  write(f.claim, {...f.spec, fixtures:[...f.spec.fixtures, 'helper.sh']});
  const bundle = path.join(f.dir, 'bundle'), privateBundle = path.join(f.dir, 'private');
  const previous = process.umask(0o077);
  try {
    freeze(f.claim, bundle);
    copyFixtures(['helper.sh'], bundle, privateBundle);
    for (const dir of [bundle, privateBundle]) {
      assert.equal(fs.statSync(path.join(dir, 'helper.sh')).mode & 0o777, 0o711);
    }
  } finally { process.umask(previous); }
});

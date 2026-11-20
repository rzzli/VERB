import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { freeze, copyFixtures, working } from '../lib/files.js';
import { fixture, write } from './helpers.js';

test('working snapshot executable bits match the recorded inputs under both umasks', {skip: process.platform === 'win32'}, t => {
  const f = fixture(t);
  for (const [name, mode] of [['owner', 0o700], ['all', 0o755], ['group', 0o650], ['data', 0o644]]) {
    write(path.join(f.repo, name), 'content');
    fs.chmodSync(path.join(f.repo, name), mode);
  }
  const id = working(f.repo).id;
  for (const mask of [0o022, 0o077]) {
    const dest = path.join(f.dir, String(mask));
    const previous = process.umask(mask);
    try { assert.equal(working(f.repo, dest).id, id); } finally { process.umask(previous); }
    for (const name of ['owner','all','group','data']) {
      assert.equal(fs.statSync(path.join(dest, name)).mode & 0o111, fs.statSync(path.join(f.repo, name)).mode & 0o111);
    }
  }
});

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

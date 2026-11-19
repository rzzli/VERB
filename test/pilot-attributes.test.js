import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { checkout } from '../lib/files.js';
import { fixture, write } from './helpers.js';

test('commit snapshots use historical root and nested attributes, not candidate policies', t => {
  const f = fixture(t);
  f.git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(f.repo, 'nested'));
  write(path.join(f.repo, '.gitattributes'), '*.txt text eol=lf\n');
  write(path.join(f.repo, 'nested/.gitattributes'), '*.txt text eol=crlf\n');
  write(path.join(f.repo, 'asset.txt'), 'alpha\nbeta\n');
  write(path.join(f.repo, 'nested/asset.txt'), 'alpha\nbeta\n');
  f.git('add', '.'); f.git('commit', '-qm', 'historical policies');
  const base = f.git('rev-parse', 'HEAD');
  write(path.join(f.repo, '.gitattributes'), '*.txt text eol=crlf\n');
  write(path.join(f.repo, 'nested/.gitattributes'), '*.txt text eol=lf\n');
  const dest = path.join(f.dir, 'snapshot');
  fs.mkdirSync(dest);
  checkout(f.repo, base, dest, path.join(f.dir, 'snapshot.index'));
  assert.equal(fs.readFileSync(path.join(dest, 'asset.txt'), 'utf8'), 'alpha\nbeta\n');
  assert.equal(fs.readFileSync(path.join(dest, 'nested/asset.txt'), 'utf8'), 'alpha\r\nbeta\r\n');
  assert.equal(fs.readFileSync(path.join(f.repo, '.gitattributes'), 'utf8'), '*.txt text eol=crlf\n');
});

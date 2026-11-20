import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { checkout, working } from '../lib/files.js';
import { clean, cmd, fixture, project, scratch, verb } from './helpers.js';

test('prove exercises the selected checkout when its sibling differs only by trailing whitespace',
  { skip: process.platform === 'win32' }, t => {
    const f = fixture(t);
    const sibling = f.repo + ' ';
    const metadata = path.join(f.dir, 'checkout metadata ');
    cmd(f.dir, 'git', ['clone', '--quiet', '--separate-git-dir', metadata, f.repo, sibling]);
    fs.writeFileSync(path.join(f.repo, 'value'), 'new');
    const failed = verb(sibling, 1, 'prove', f.claim, '--base', 'HEAD');
    assert.equal(failed.repo, sibling);
    assert.equal(failed.sides.candidate.assertions[0].actual, 'old');
    assert.ok(failed.receipt.startsWith(path.join(metadata, 'verb') + path.sep));
    assert.equal(fs.existsSync(metadata.trimEnd()), false);
    assert.equal(fs.existsSync(path.join(f.repo, '.git', 'verb')), false);
  });

test('commit snapshots preserve a literal backslash in a POSIX scratch path',
  { skip: process.platform === 'win32' }, t => {
    const f = fixture(t);
    const dest = path.join(f.dir, 'literal\\scratch', 'tree');
    fs.mkdirSync(dest, { recursive: true });
    checkout(f.repo, 'HEAD', dest, path.join(f.dir, 'index'));
    assert.equal(fs.readFileSync(path.join(dest, 'value'), 'utf8'), 'old');
    assert.equal(fs.existsSync(path.join(f.dir, 'literal')), false);
  });

test('working and commit snapshots reject unrepresentable Git path bytes', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const raw = Buffer.concat([Buffer.from(f.repo + '/name-'), Buffer.from([0xff])]);
  const neighbor = path.join(f.repo, 'name-\uFFFD');
  fs.writeFileSync(neighbor, 'valid UTF-8 name');
  const original = working(f.repo).id;
  fs.writeFileSync(raw, 'distinct file');
  assert.throws(() => working(f.repo), /UTF-8/);
  f.git('add', '--all');
  f.git('commit', '-qm', 'byte-oriented filenames');
  const dest = path.join(f.dir, 'snapshot');
  fs.mkdirSync(dest);
  assert.throws(() => checkout(f.repo, 'HEAD', dest, path.join(f.dir, 'index')), /UTF-8/);
  f.git('reset', '--quiet', 'HEAD^', '--', '.');
  fs.unlinkSync(raw);
  assert.equal(working(f.repo).id, original);
});

test('hook discovery handles translated Git installations and still blocks other Git errors',
  { skip: process.platform === 'win32' }, t => {
    const dir = scratch();
    t.after(() => clean(dir));
    // Emulate gettext for the one diagnostic the hook interprets. Keep the
    // regression independent of the language catalogs installed on a CI runner.
    const git = path.join(dir, 'git');
    fs.writeFileSync(git, `#!/bin/sh
if [ "$VERB_TEST_DISCOVERY" = "broken" ]; then
  echo 'fatal: bad config line' >&2
elif [ "$LC_ALL" = C ]; then
  echo 'fatal: not a git repository' >&2
else
  echo 'fatal: kein Git-Repository' >&2
fi
exit 128
`, { mode: 0o755 });
    const run = mode => spawnSync(process.execPath, [path.join(project, 'hooks/verify.mjs'), '--stop'], {
      cwd: dir, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, LC_ALL: 'C.UTF-8', LANGUAGE: 'de', VERB_TEST_DISCOVERY: mode }
    });
    const outside = run('outside');
    assert.equal(outside.status, 0, outside.stderr);
    assert.match(outside.stderr, /not inside a Git repository/);
    const broken = run('broken');
    assert.equal(broken.status, 2, broken.stderr);
    assert.match(broken.stderr, /bad config line/);
  });

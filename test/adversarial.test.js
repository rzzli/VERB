import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cmd, fixture, project, write, verb } from './helpers.js';
import { hash } from '../lib/files.js';

const hook = (repo, ...args) => spawnSync(process.execPath, [path.join(project, 'hooks/verify.mjs'), ...args],
  { cwd: repo, encoding: 'utf8', timeout: 30000 });

test('snapshot sibling layout cannot distinguish base from candidate on unchanged code', t => {
  const { repo, claim, probe } = fixture(t);
  write(probe, `import fs from 'node:fs'; import path from 'node:path';
const run = path.dirname(path.dirname(process.cwd()));
const sides = fs.readdirSync(run).filter(name => fs.existsSync(path.join(run, name, 'tree')));
console.log(JSON.stringify({origin:path.resolve('value'),observations:{value:sides.length > 1 ? 'new' : 'old',neighbor:'same'}}));`);
  const r = verb(repo, 1, 'prove', claim, '--base', 'HEAD');
  assert.equal(r.sides.candidate.assertions[0].actual, 'old');
});

test('a newer inconclusive proof without a candidate invalidates an earlier verified proof', t => {
  const { repo, dir, claim, probe } = fixture(t);
  const toggle = path.join(dir, 'break-baseline');
  fs.appendFileSync(probe, `\nif (fs.existsSync(${JSON.stringify(toggle)})) process.exit(1);`);
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  write(path.join(repo, 'value'), 'new');
  verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  assert.equal(hook(repo).status, 0);
  write(toggle, 'fail');
  const latest = verb(repo, 2, 'prove', claim, '--base', 'HEAD');
  assert.equal(latest.sides.candidate, undefined);
  assert.equal(verb(repo, 2, 'status').receipt, latest.receipt);
  assert.notEqual(hook(repo).status, 0);
});

test('a fresh baseline needs a subsequent proof, not a proof from the previous activation', t => {
  const { repo, claim } = fixture(t);
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  write(path.join(repo, 'value'), 'new');
  verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  assert.equal(hook(repo).status, 0);
  verb(repo, 0, 'deactivate', claim);
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  assert.notEqual(hook(repo).status, 0);
  verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  assert.equal(hook(repo).status, 0);
});

test('Windows claim aliases share a baseline, proof and deactivation slot', { skip: process.platform !== 'win32' }, t => {
  const { repo, claim } = fixture(t);
  const alias = path.join(path.dirname(claim), 'CLAIM.JSON');
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  write(path.join(repo, 'value'), 'new');
  verb(repo, 0, 'prove', alias, '--base', 'HEAD');
  assert.equal(hook(repo).status, 0);
  verb(repo, 0, 'deactivate', alias);
  assert.equal(verb(repo, 0, 'status', '--active').active, 0);
});

test('Windows deactivation handles deleted claims and legacy case-alias slots', { skip: process.platform !== 'win32' }, t => {
  const { repo, claim } = fixture(t);
  const alias = path.join(path.dirname(claim), 'CLAIM.JSON');
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  const baselines = path.join(repo, '.git', 'verb', 'baselines');
  const saved = JSON.parse(fs.readFileSync(path.join(baselines, hash(claim), 'current.json'), 'utf8'));
  const legacy = path.join(baselines, hash(alias));
  fs.mkdirSync(legacy);
  write(path.join(legacy, 'current.json'), { ...saved, claimPath: alias });
  fs.unlinkSync(claim);
  verb(repo, 0, 'deactivate', alias);
  assert.equal(verb(repo, 0, 'status', '--active').active, 0);
});

test('pre-commit rejects index flags that conceal unstaged files', t => {
  const { repo, claim, git } = fixture(t);
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  git('update-index', '--assume-unchanged', 'value');
  write(path.join(repo, 'value'), 'new');
  verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  assert.equal(git('show', ':value'), 'old');
  assert.equal(git('diff', '--name-only'), '');
  assert.equal(hook(repo, '--pre-commit').status, 1);
  git('update-index', '--no-assume-unchanged', 'value');
  git('update-index', '--skip-worktree', 'value');
  assert.equal(hook(repo, '--pre-commit').status, 1);
  git('update-index', '--no-skip-worktree', 'value');
  git('add', 'value');
  assert.equal(hook(repo, '--pre-commit').status, 0);
});

test('pre-commit rejects clean filters that conceal different staged behavior', t => {
  const { repo, claim, git } = fixture(t);
  write(path.join(repo, '.gitattributes'), 'value filter=rewrite\n');
  write(path.join(repo, 'filter.mjs'), `import fs from 'node:fs';
const data = fs.readFileSync(0, 'utf8');
process.stdout.write(process.argv[2] === 'clean' ? data.replaceAll('new', 'old') : data);`);
  git('config', 'filter.rewrite.clean', 'node filter.mjs clean');
  git('config', 'filter.rewrite.smudge', 'node filter.mjs smudge');
  git('add', '.');
  git('commit', '-qm', 'content filter');
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  write(path.join(repo, 'value'), 'new');
  git('add', 'value');
  assert.equal(git('show', ':value'), 'old');
  assert.equal(git('diff', '--name-only'), '');
  verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  const result = hook(repo, '--pre-commit');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /filter/);
});

test('summary keeps flag paths relative and distinguishes failed and unrun commands', t => {
  const { repo, claim, spec } = fixture(t);
  write(claim, { ...spec, required: [
    ['{node}', '-e', 'process.exit(0)', '--', '--config=' + path.join(repo, 'config.json')],
    ['{node}', '-e', 'process.exit(7)'],
    ['{node}', '-e', 'process.exit(0)']
  ] });
  write(path.join(repo, 'value'), 'new');
  const receipt = verb(repo, 1, 'prove', claim, '--base', 'HEAD');
  const text = cmd(repo, process.execPath, [path.join(project, 'bin/verb.js'), 'summary', receipt.receipt]);
  assert.ok(text.includes('VERB FAILED (prove)'));
  assert.ok(text.includes(receipt.digest));
  assert.ok(text.includes(receipt.sides.base.id) && text.includes(receipt.sides.candidate.id));
  assert.ok(text.includes('--config=config.json'));
  assert.ok(!text.includes(repo.replaceAll('\\', '\\\\')));
  assert.match(text, /exit 0/);
  assert.match(text, /exit 7/);
  assert.match(text, /not run/);
});

test('Windows batch launch failures are recorded instead of appearing unrun', { skip: process.platform !== 'win32' }, t => {
  const { repo, claim, spec } = fixture(t);
  write(path.join(repo, 'build.cmd'), '@exit /b 0\r\n');
  write(path.join(repo, 'value'), 'new');
  write(claim, { ...spec, required: [['{root}/build.cmd']] });
  const r = verb(repo, 2, 'prove', claim, '--base', 'HEAD');
  const command = r.sides.candidate.commands.find(c => c.phase === 'required');
  assert.ok(command, 'The attempted command must be recorded even when spawn throws synchronously');
  assert.equal(command.code, null);
  assert.match(command.error, /cmd\.exe|EINVAL/);
});

test('inactive hooks do not inspect an unsupported working tree', t => {
  const { repo, git } = fixture(t);
  git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},submodule`);
  assert.equal(verb(repo, 0, 'status', '--active').active, 0);
  assert.equal(hook(repo, '--pre-commit').status, 0);
});

test('every active claim needs its own proof and failed rebaselines stay active', t => {
  const { repo, dir, claim, spec } = fixture(t);
  const other = path.join(dir, 'other.json');
  write(other, spec);
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  verb(repo, 0, 'baseline', other, '--base', 'HEAD');
  write(path.join(repo, 'value'), 'new');
  verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  assert.equal(verb(repo, 2, 'status', '--active').active, 2);
  verb(repo, 0, 'prove', other, '--base', 'HEAD');
  verb(repo, 0, 'status', '--active');
  write(other, { ...spec, assertions: [{ key: 'value', base: 'missing', fixed: 'new' }] });
  verb(repo, 2, 'baseline', other, '--base', 'HEAD');
  assert.equal(verb(repo, 2, 'status', '--active').active, 2);
  assert.equal(hook(repo, '--stop').status, 2);
  verb(repo, 0, 'deactivate', other);
  verb(repo, 0, 'status', '--active');
});

test('the documented Git hook blocks a real commit until the staged tree is proved', t => {
  const { repo, dir, claim, git } = fixture(t);
  const hooks = path.join(dir, 'hooks');
  fs.mkdirSync(hooks);
  const quote = arg => "'" + arg.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
  const script = path.join(hooks, 'pre-commit');
  write(script, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(path.join(project, 'hooks/verify.mjs')) + ' --pre-commit\n');
  fs.chmodSync(script, 0o755);
  git('config', 'core.hooksPath', hooks);
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  write(path.join(repo, 'value'), 'new');
  git('add', 'value');
  const blocked = spawnSync('git', ['commit', '-qm', 'must block'], { cwd: repo, encoding: 'utf8' });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /VERB blocked/);
  verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  git('commit', '-qm', 'proved fix');
  assert.equal(git('show', 'HEAD:value'), 'new');
});

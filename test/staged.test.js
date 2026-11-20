import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './git-environment.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const stagedModule = new URL('../lib/staged.js', import.meta.url).href;
const filesModule = new URL('../lib/files.js', import.meta.url).href;
const hook = path.join(project, 'hooks/verify.mjs');

function repository(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'verb staged test ')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const env = { ...process.env };
  const run = (exe, args, extra = {}) => {
    const result = spawnSync(exe, args, { cwd: repo, env, encoding: 'utf8', windowsHide: true,
      timeout: 20000, maxBuffer: 4 * 1024 * 1024, ...extra });
    assert.ifError(result.error);
    return result;
  };
  const git = (...args) => {
    const result = run('git', args);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.email', 'staged@localhost');
  git('config', 'user.name', 'Staged test');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.eol', 'lf');
  const put = (name, bytes) => fs.writeFileSync(path.join(repo, name), bytes);
  const verify = (extra = {}) => run(process.execPath, ['--input-type=module', '-e',
    `import { assertStagedCheckout } from ${JSON.stringify(stagedModule)};
import { working } from ${JSON.stringify(filesModule)};
try { console.log(assertStagedCheckout(process.cwd(), working(process.cwd()).id)); }
catch (error) { console.error(error.message); process.exitCode = 1; }`], extra);
  const snapshot = ref => {
    const dest = fs.mkdtempSync(path.join(dir, 'checkout-'));
    const result = run(process.execPath, ['--input-type=module', '-e',
      `import { checkout } from ${JSON.stringify(filesModule)};
checkout(process.cwd(), ${JSON.stringify(ref)}, ${JSON.stringify(dest)}, ${JSON.stringify(dest + '.index')});`]);
    assert.equal(result.status, 0, result.stderr);
    return dest;
  };
  return { dir, repo, env, run, git, put, verify, snapshot };
}

const cases = [
  { name: 'text eol=lf', attrs: 'text eol=lf', seed: 'record\n', divergent: 'record\r\n', canonical: 'record\n' },
  { name: 'text eol=crlf', attrs: 'text eol=crlf', seed: 'record\r\n', divergent: 'record\n', canonical: 'record\r\n', converted: true },
  { name: 'core.autocrlf=true', config: 'true', seed: 'record\r\n', divergent: 'record\n', canonical: 'record\r\n', converted: true },
  { name: 'core.autocrlf=input', config: 'input', seed: 'record\n', divergent: 'record\r\n', canonical: 'record\n' },
  { name: 'ident', attrs: 'ident text eol=lf', seed: '$Id$\n', divergent: '$Id$\n', converted: true },
  { name: 'working-tree-encoding', attrs: 'working-tree-encoding=UTF-16LE text eol=lf',
    seed: Buffer.from('record\n', 'utf16le'), divergent: Buffer.from('record\r\n', 'utf16le'),
    canonical: Buffer.from('record\n', 'utf16le'), converted: true }
];

for (const sample of cases) {
  test(`staged checkout ${sample.name}: accept consistent bytes and reject normalized divergence`, t => {
    const f = repository(t);
    if (sample.config) f.git('config', 'core.autocrlf', sample.config);
    if (sample.attrs) f.put('.gitattributes', '.gitattributes -text\nvalue.txt ' + sample.attrs + '\n');
    f.put('value.txt', sample.seed);
    f.git('add', '.');
    f.git('commit', '-qm', 'representation');
    const expected = fs.readFileSync(path.join(f.snapshot('HEAD'), 'value.txt'));
    if (sample.canonical !== undefined) assert.deepEqual(expected, Buffer.from(sample.canonical));
    else assert.match(expected.toString(), /^\$Id: [a-f0-9]{40,64} \$\n$/);
    if (sample.converted) assert.notDeepEqual(expected, Buffer.from(f.git('show', 'HEAD:value.txt') + '\n'));
    f.put('value.txt', expected);
    f.git('add', '.');
    assert.equal(f.git('diff', '--name-only'), '');
    const accepted = f.verify();
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout.trim(), f.git('rev-parse', 'HEAD^{tree}'));

    f.put('value.txt', sample.divergent);
    f.git('add', '.');
    assert.equal(f.git('diff', '--name-only'), '', 'normalized Git diff conceals the byte difference');
    const rejected = f.verify();
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /Staged checkout differs.*value\.txt/);
    const staged = fs.readFileSync(path.join(f.snapshot(f.git('write-tree')), 'value.txt'));
    assert.deepEqual(staged, expected, 'staged tree extraction matches the committed checkout, not the working bytes');
    assert.notDeepEqual(staged, Buffer.from(sample.divergent));
  });
}

test('staged attributes, including nested overrides, determine the candidate checkout', t => {
  const f = repository(t);
  fs.mkdirSync(path.join(f.repo, 'nested'));
  f.put('.gitattributes', '*.txt text eol=lf\n');
  f.put('nested/.gitattributes', '*.txt text eol=lf\n');
  f.put('root.txt', 'record\n');
  f.put('nested/value.txt', 'record\n');
  f.git('add', '.'); f.git('commit', '-qm', 'LF attributes');
  f.put('.gitattributes', '*.txt text eol=crlf\n');
  f.git('add', '.');
  assert.equal(f.git('diff', '--name-only'), '');
  const mismatch = f.verify();
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /root\.txt/);
  f.put('root.txt', 'record\r\n');
  const accepted = f.verify();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.notEqual(accepted.stdout.trim(), f.git('rev-parse', 'HEAD^{tree}'));
  f.git('commit', '-qm', 'candidate attributes');
  const dest = f.snapshot('HEAD');
  assert.equal(fs.readFileSync(path.join(dest, 'root.txt'), 'utf8'), 'record\r\n');
  assert.equal(fs.readFileSync(path.join(dest, 'nested/value.txt'), 'utf8'), 'record\n');
});

function proof(f, baseBytes, fixedBytes) {
  const claim = path.join(f.dir, 'claim.json');
  fs.writeFileSync(path.join(f.dir, 'probe.mjs'), `import fs from 'node:fs'; import path from 'node:path';
const origin = path.resolve('value.txt');
console.log(JSON.stringify({origin, observations:{value:fs.readFileSync(origin).toString('hex')}}));`);
  fs.writeFileSync(claim, JSON.stringify({ claim: 'preserve exact bytes', probe: ['{node}', '{bundle}/probe.mjs'],
    fixtures: ['probe.mjs'], assertions: [{ key: 'value', base: Buffer.from(baseBytes).toString('hex'),
      fixed: Buffer.from(fixedBytes).toString('hex') }], required: [], timeoutMs: 5000 }));
  const verb = (code, ...args) => {
    const result = f.run(process.execPath, [path.join(project, 'bin/verb.js'), ...args, '--json']);
    assert.equal(result.status, code, result.stderr + result.stdout);
    return JSON.parse(result.stdout || result.stderr);
  };
  verb(0, 'baseline', claim, '--base', 'HEAD');
  return { claim, verb, prove: () => verb(0, 'prove', claim, '--base', 'HEAD') };
}

function installHook(f) {
  const hooks = path.join(f.dir, 'hooks');
  fs.mkdirSync(hooks);
  const indexRecord = path.join(f.dir, 'hook-index.json');
  const wrapper = path.join(f.dir, 'hook-wrapper.mjs');
  fs.writeFileSync(wrapper, `import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
fs.writeFileSync(${JSON.stringify(indexRecord)}, JSON.stringify({ index: process.env.GIT_INDEX_FILE, cwd: process.cwd() }));
const result = spawnSync(process.execPath, [${JSON.stringify(hook)}, '--pre-commit'], { stdio: 'inherit', timeout: 20000 });
process.exit(result.status ?? 1);`);
  const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(wrapper) + '\n');
  fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755);
  f.git('config', 'core.hooksPath', hooks);
  return indexRecord;
}

test('actual pre-commit blocks the EOL false proof; the committed candidate fails that same probe', t => {
  const f = repository(t);
  f.put('.gitattributes', 'value.txt text eol=lf\n');
  f.put('value.txt', 'record\n');
  f.git('add', '.'); f.git('commit', '-qm', 'broken LF wire format');
  const base = f.git('rev-parse', 'HEAD');
  const p = proof(f, 'record\n', 'record\r\n');
  f.put('value.txt', 'record\r\n');
  f.git('add', '.');
  assert.equal(f.git('diff', '--name-only'), '');
  p.prove();
  p.verb(0, 'status', '--active');
  installHook(f);
  const blocked = f.run('git', ['commit', '--allow-empty', '-qm', 'must block']);
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stderr, /VERB blocked: Staged checkout differs/);
  assert.equal(f.git('rev-parse', 'HEAD'), base);
  // Bypass only this temporary repo's hook to demonstrate the actual committed outcome.
  f.git('-c', 'core.hooksPath=' + path.join(f.dir, 'no-hooks'), 'commit', '--allow-empty', '-qm', 'demonstrate lost fix');
  const result = p.verb(1, 'prove', p.claim, '--base', base, '--candidate', 'HEAD');
  assert.equal(result.sides.candidate.assertions[0].actual, Buffer.from('record\n').toString('hex'));
});

test('real Git hooks accept consistent CRLF checkout bytes but reject a partial-commit index', t => {
  const f = repository(t);
  f.put('.gitattributes', 'value.txt text eol=crlf\n');
  f.put('value.txt', 'old\r\n');
  f.put('other', 'old');
  f.git('add', '.'); f.git('commit', '-qm', 'broken');
  const base = f.git('rev-parse', 'HEAD');
  const p = proof(f, 'old\r\n', 'new\r\n');
  f.put('value.txt', 'new\r\n'); f.put('other', 'new');
  f.git('add', '.');
  p.prove();
  const indexRecord = installHook(f);
  const before = f.git('write-tree');
  const partial = f.run('git', ['commit', '--only', 'value.txt', '-qm', 'partial must block']);
  assert.equal(partial.status, 1, partial.stderr);
  assert.match(partial.stderr, /stage the verified tree/);
  const context = JSON.parse(fs.readFileSync(indexRecord, 'utf8'));
  assert.ok(context.index, 'Git supplied an index to the pre-commit hook');
  assert.notEqual(path.resolve(context.cwd, context.index), path.join(f.repo, '.git', 'index'));
  assert.equal(f.git('write-tree'), before, 'temporary checkout did not replace the real index');
  assert.equal(f.git('rev-parse', 'HEAD'), base);
  f.git('commit', '-qm', 'complete proved fix');
  assert.equal(fs.readFileSync(path.join(f.snapshot('HEAD'), 'value.txt'), 'utf8'), 'new\r\n');
  p.verb(0, 'prove', p.claim, '--base', base, '--candidate', 'HEAD');
});

test('relative GIT_INDEX_FILE survives a hook invocation from a subdirectory', t => {
  const f = repository(t);
  f.put('value.txt', 'old');
  f.git('add', '.'); f.git('commit', '-qm', 'broken');
  const p = proof(f, 'old', 'new');
  f.put('value.txt', 'new');
  const alternate = path.join(f.repo, '.git', 'alternate-index');
  fs.copyFileSync(path.join(f.repo, '.git', 'index'), alternate);
  const staged = f.run('git', ['add', '.'], { env: { ...f.env, GIT_INDEX_FILE: alternate } });
  assert.equal(staged.status, 0, staged.stderr);
  p.prove();
  const defaultIndex = f.git('write-tree');
  const rejected = f.run(process.execPath, [hook, '--pre-commit']);
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /stage the verified tree/);
  const cwd = path.join(f.repo, 'nested');
  fs.mkdirSync(cwd);
  const accepted = f.run(process.execPath, [hook, '--pre-commit'], {
    cwd, env: { ...f.env, GIT_INDEX_FILE: path.join('..', '.git', 'alternate-index') }
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(f.git('write-tree'), defaultIndex);
  assert.equal(f.git('show', ':value.txt'), 'old', 'the default index was not substituted or modified');
});

test('pre-commit binds the staged checkout to the proof across a concurrent formatting edit', t => {
  const f = repository(t);
  f.put('value.txt', 'old');
  f.git('add', '.'); f.git('commit', '-qm', 'broken');
  const p = proof(f, 'old', 'new');
  f.put('value.txt', 'new');
  f.git('add', '.');
  const proved = p.prove();
  assert.equal(p.verb(0, 'status', '--active').workingDigest, proved.sides.candidate.id);
  assert.equal(f.run(process.execPath, [hook, '--pre-commit']).status, 0);

  // Synchronize the formatter exactly after the real status subprocess returns.
  const wrapper = path.join(f.dir, 'format-after-status.cjs');
  fs.writeFileSync(wrapper, `const cp = require('node:child_process'), fs = require('node:fs');
const spawn = cp.spawnSync;
cp.spawnSync = function(exe, args, opts) {
  const result = spawn(exe, args, opts);
  if (args.includes('--active') && result.status === 0) {
    fs.writeFileSync('format.css', 'body { color: blue; }');
    cp.execFileSync('git', ['add', 'format.css']);
  }
  return result;
};
require('node:module').syncBuiltinESMExports();`);
  const raced = f.run(process.execPath, ['--require', wrapper, hook, '--pre-commit']);
  assert.equal(f.git('show', ':format.css'), 'body { color: blue; }');
  assert.equal(raced.status, 1, raced.stderr);
  assert.match(raced.stderr, /Staged checkout differs from the proof/);
  p.prove();
  assert.equal(f.run(process.execPath, [hook, '--pre-commit']).status, 0);
});

test('owner-only execute bits match Git\'s executable identity', { skip: process.platform === 'win32' }, t => {
  const f = repository(t);
  f.put('value.txt', 'record\n');
  fs.chmodSync(path.join(f.repo, 'value.txt'), 0o744);
  f.git('add', '.'); f.git('commit', '-qm', 'owner execute');
  assert.equal(f.git('ls-files', '-s', 'value.txt').split(' ')[0], '100755');
  const ownerOnly = f.verify();
  assert.equal(ownerOnly.status, 0, ownerOnly.stderr);
  // The owner bit is the identity: losing it must still be rejected.
  fs.chmodSync(path.join(f.repo, 'value.txt'), 0o644);
  assert.equal(f.verify().status, 1);
  fs.chmodSync(path.join(f.repo, 'value.txt'), 0o755);
  assert.equal(f.verify().status, 0);
});

test('staged executable-mode divergence is rejected even with core.filemode=false', { skip: process.platform === 'win32' }, t => {
  const f = repository(t);
  f.put('value.txt', 'record\n');
  fs.chmodSync(path.join(f.repo, 'value.txt'), 0o644);
  f.git('add', '.'); f.git('commit', '-qm', 'non-executable');
  f.git('config', 'core.filemode', 'false');
  f.git('update-index', '--chmod=+x', 'value.txt');
  assert.equal(f.git('diff', '--name-only'), '');
  assert.equal(f.verify().status, 1);
  fs.chmodSync(path.join(f.repo, 'value.txt'), 0o755);
  const accepted = f.verify();
  assert.equal(accepted.status, 0, accepted.stderr);
});

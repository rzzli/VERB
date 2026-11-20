import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { project, scratch, clean, write, cmd, verb } from './helpers.js';

function fixture(t) {
  const dir = scratch();
  t.after(() => clean(dir));
  const repo = path.join(dir, 'repository'), claim = path.join(dir, 'claim.json');
  fs.mkdirSync(repo);
  const git = (...args) => cmd(repo, 'git', args);
  git('init', '-q');
  git('config', 'user.email', 'fixture@localhost');
  git('config', 'user.name', 'Fixture');
  write(path.join(repo, 'value'), 'old');
  git('add', '.');
  git('commit', '-qm', 'broken');
  write(path.join(dir, 'probe.mjs'), `import fs from 'node:fs';
import path from 'node:path';
const origin = path.resolve('value');
console.log(JSON.stringify({origin,observations:{value:fs.readFileSync(origin,'utf8'),neighbor:'same'}}));`);
  const spec = { claim: 'read saved value', probe: ['{node}', '{bundle}/probe.mjs'], fixtures: ['probe.mjs'],
    assertions: [{ key: 'value', base: 'old', fixed: 'new' }, { key: 'neighbor', base: 'same', fixed: 'same' }],
    required: [['{node}', '-e', 'process.exit(0)']] };
  write(claim, spec);
  return { dir, repo, claim, spec, git, probe: path.join(dir, 'probe.mjs') };
}

test('frozen baseline, uncommitted snapshot, receipt freshness and replay', t => {
  const {repo, claim, probe, git} = fixture(t);
  verb(repo, 2, 'check', claim);
  const base = verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  assert.equal(path.dirname(path.dirname(base.receipt)), path.join(repo, '.git', 'verb', 'receipts'));
  assert.ok(fs.existsSync(path.join(base.frozen, 'fixtures/probe.mjs')));
  verb(repo, 1, 'check', claim);
  write(path.join(repo, 'value'), 'staged');
  git('add', 'value');
  write(path.join(repo, 'value'), 'new');
  const r = verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  assert.equal(r.replay[0], 'verb');
  verb(repo, 0, 'status', r.receipt);
  assert.equal(verb(repo, 0, 'status').receipt, r.receipt);
  write(path.join(repo, 'new.txt'), 'new source');
  verb(repo, 2, 'status', r.receipt);
  verb(repo, 2, 'status');
  verb(repo, 0, 'check', claim);
  git('add', '.');
  git('commit', '-qm', 'fixed');
  const committed = verb(repo, 0, 'prove', claim, '--base', 'HEAD^', '--candidate', 'HEAD');
  verb(repo, 2, 'status', committed.receipt);
  verb(repo, 2, 'baseline', claim, '--base', 'HEAD');
  verb(repo, 2, 'check', claim);
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD^');
  fs.appendFileSync(probe, '\n');
  assert.match(verb(repo, 2, 'check', claim).reason, /claim changed/);
});

test('status requires the newest matching working-tree proof to be verified', t => {
  const {repo, claim, spec, dir} = fixture(t);
  verb(repo, 2, 'status');
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  write(path.join(repo, 'value'), 'new');
  const checked = verb(repo, 0, 'check', claim);
  verb(repo, 2, 'status', checked.receipt);
  verb(repo, 2, 'status');
  const verified = verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  write(path.join(repo, 'extra'), 'different tree');
  verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  fs.unlinkSync(path.join(repo, 'extra'));
  assert.equal(verb(repo, 0, 'status').receipt, verified.receipt);

  const badClaim = path.join(dir, 'failing.json');
  write(badClaim, {...spec, required: [['{node}', '-e', 'process.exit(1)']]});
  const failed = verb(repo, 1, 'prove', badClaim, '--base', 'HEAD');
  assert.equal(verb(repo, 2, 'status', failed.receipt).receipt, failed.receipt);
  assert.equal(verb(repo, 2, 'status').receipt, failed.receipt);
});

test('setup failure, missing observation, outside origin and timeout are inconclusive', t => {
  const {repo, spec, claim, probe} = fixture(t);
  const baseline = () => verb(repo, 2, 'baseline', claim, '--base', 'HEAD').sides.base;
  write(claim, {...spec, setup: [['{node}', '-e', 'process.exit(1)']]});
  assert.match(baseline().reason, /setup/);
  write(claim, spec);
  write(probe, "import path from 'node:path'; console.log(JSON.stringify({origin:path.resolve('value'), observations:{}}))");
  assert.match(baseline().reason, /missing.*value/);
  write(probe, "console.log(JSON.stringify({origin:process.execPath, observations:{value:'old',neighbor:'same'}}))");
  assert.match(baseline().reason, /origin/);
  write(claim, {...spec, timeoutMs: 500});
  write(probe, "import {spawn} from 'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000);");
  assert.match(baseline().reason, /timed out/);
});

test('conflicting observations recover after three consistent runs, and missing history is empty', t => {
  const {repo, claim, probe, dir} = fixture(t);
  const toggle = path.join(dir, 'setting');
  write(probe, `import fs from 'node:fs'; import path from 'node:path';
console.log(JSON.stringify({origin:path.resolve('value'), observations:{value:fs.readFileSync(${JSON.stringify(toggle)},'utf8'),neighbor:'same'}}));`);
  write(toggle, 'old');
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  write(toggle, 'new');
  const r = verb(repo, 2, 'baseline', claim, '--base', 'HEAD');
  assert.match(r.reason, /last three completed runs/);
  write(toggle, 'old');
  verb(repo, 2, 'baseline', claim, '--base', 'HEAD');
  verb(repo, 2, 'baseline', claim, '--base', 'HEAD');
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  fs.rmSync(path.join(repo, '.git', 'verb', 'history'), { recursive: true });
  write(toggle, 'new');
  verb(repo, 0, 'check', claim);
});

test('parallel proofs run new files, omit deleted files and isolate profiles without labeling snapshot paths', async t => {
  const {repo, claim, probe} = fixture(t);
  write(probe, `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
import {fileURLToPath} from 'node:url';
const sideDir = path.dirname(process.cwd());
assert.match(path.basename(sideDir), /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
assert.equal(fs.existsSync(path.join(sideDir, 'index')), false);
assert.equal(path.dirname(process.env.VERB_ROOT), sideDir);
assert.equal(path.dirname(process.env.VERB_PROFILE), sideDir);
assert.equal(path.dirname(path.dirname(fileURLToPath(import.meta.url))), sideDir);
const origin = path.resolve(process.env.VERB_ROOT, fs.existsSync('value') ? 'value' : 'new-source');
fs.writeFileSync(path.join(process.env.VERB_PROFILE,'marker'),'',{flag:'wx'});
console.log(JSON.stringify({origin, observations:{value:fs.readFileSync(origin,'utf8'),neighbor:'same'}}));`);
  fs.unlinkSync(path.join(repo, 'value'));
  write(path.join(repo, 'new-source'), 'new');
  const run = async () => JSON.parse((await promisify(execFile)(process.execPath,
    [path.join(project, 'bin/verb.js'), 'prove', claim, '--base', 'HEAD', '--json'],
    {cwd:repo, timeout:30000})).stdout);
  const [a,b] = await Promise.all([run(),run()]);
  assert.equal(a.verdict, 'verified');
  assert.equal(b.verdict, 'verified');
  assert.equal(a.sides.candidate.origin, 'new-source');
  assert.equal(a.sides.candidate.id, b.sides.candidate.id);
  assert.notEqual(a.receipt, b.receipt);
});

test('hooks only gate active claims and pre-commit refuses a partial tree', t => {
  const {repo, dir, claim, spec, git} = fixture(t);
  const hook = (...args) => spawnSync(process.execPath, [path.join(project, 'hooks/verify.mjs'), ...args],
    { cwd: repo, encoding: 'utf8' });
  assert.equal(hook().status, 0);
  assert.equal(hook('--pre-commit').status, 0);
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  const stopped = hook('--stop');
  assert.equal(stopped.status, 2);
  assert.match(stopped.stderr, /Run prove/);
  write(path.join(repo, 'value'), 'new');
  const other = path.join(dir, 'other.json');
  write(other, spec);
  verb(repo, 0, 'prove', other, '--base', 'HEAD');
  assert.equal(hook().status, 1);
  verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  assert.equal(hook().status, 0);
  assert.equal(hook('--pre-commit').status, 1);
  git('add', 'value');
  assert.equal(hook('--pre-commit').status, 0);
  write(claim, {...spec, claim: 'changed claim'});
  assert.match(hook().stderr, /Run baseline again/);
  verb(repo, 0, 'deactivate', claim);
  assert.equal(hook().status, 0);
});

test('pruning keeps 30 receipts and history records without invalidating the saved baseline', t => {
  const {repo, claim} = fixture(t);
  const baseline = verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  fs.utimesSync(baseline.receipt, 1, 1);
  const receipts = path.dirname(baseline.receipt);
  const history = path.join(repo, '.git', 'verb', 'history', 'claims', path.basename(receipts));
  const record = fs.readFileSync(path.join(history, fs.readdirSync(history)[0]), 'utf8');
  for (let i = 0; i < 31; i++) {
    write(path.join(receipts, `prev-${i}.json`), { action: 'check', verdict: 'verified' });
    write(path.join(history, `prev-${i}.json`), record);
  }
  write(path.join(repo, 'value'), 'new');
  verb(repo, 0, 'check', claim);
  assert.equal(fs.readdirSync(receipts).length, 30);
  assert.equal(fs.readdirSync(history).length, 30);
  assert.equal(fs.existsSync(baseline.receipt), true);
  verb(repo, 0, 'check', claim);
});

test('build setup can read shared ignored dependencies; required checks get a separate timeout', t => {
  const {repo, claim, spec, probe, git} = fixture(t);
  write(path.join(repo, '.gitignore'), '/deps/\n');
  git('add', '.gitignore');
  git('commit', '-qm', 'ignore dependencies');
  fs.mkdirSync(path.join(repo, 'deps'));
  write(path.join(repo, 'deps', 'prefix'), 'prefix:');
  write(probe, `import fs from 'node:fs'; import path from 'node:path';
const origin = path.resolve('built');
console.log(JSON.stringify({origin, observations:{value:fs.readFileSync(origin,'utf8'),neighbor:'same'}}));`);
  const built = {...spec, link: ['deps'], timeoutMs: 1200, requiredTimeoutMs: 5000,
    setup: [['{node}', '-e', "const fs=require('node:fs');fs.writeFileSync('built',fs.readFileSync('deps/prefix','utf8')+fs.readFileSync('value','utf8'))"]],
    assertions: [{key: 'value', base: 'prefix:old', fixed: 'prefix:new'}, spec.assertions[1]],
    required: [['{node}', '-e', 'setTimeout(() => {}, 1500)']] };
  write(claim, built);
  write(path.join(repo, 'value'), 'new');
  const r = verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  assert.equal(fs.existsSync(path.join(repo, 'built')), false);
  const report = cmd(repo, process.execPath, [path.join(project, 'bin/verb.js'), 'summary', r.receipt]);
  assert.ok(report.includes('Claim: ../claim.json'));
  assert.ok(report.includes(r.digest));
  assert.ok(report.includes('prefix:old') && report.includes('prefix:new') && report.includes('exit 0'));
  assert.ok(!report.includes(repo));
  write(claim, {...built, requiredTimeoutMs: 100});
  assert.match(verb(repo, 2, 'prove', claim, '--base', 'HEAD').reason, /required: command timed out/);
  write(path.join(repo, '.gitignore'), '');
  assert.match(verb(repo, 2, 'prove', claim, '--base', 'HEAD').reason, /ignored, untracked/);
});

test('commit and working snapshots preserve internal symlinks but reject escaping targets', t => {
  const {dir, repo, claim, probe, git} = fixture(t);
  const link = path.join(repo, 'alias');
  try { fs.symlinkSync('value', link, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('Windows symlink permission unavailable');
    throw error;
  }
  git('config', 'core.symlinks', 'true');
  git('add', 'alias');
  git('commit', '-qm', 'internal link');
  write(probe, `import fs from 'node:fs'; import path from 'node:path';
const origin = path.resolve('alias');
if (!fs.lstatSync(origin).isSymbolicLink()) throw Error('not a symlink');
console.log(JSON.stringify({origin, observations:{value:fs.readFileSync(origin,'utf8'),neighbor:'same'}}));`);
  write(path.join(repo, 'value'), 'new');
  verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  fs.unlinkSync(link);
  // Git can retain an absolute DOS-spelled target even when VERB opens the long root.
  const absoluteRoot = process.platform === 'win32'
    ? cmd(repo, 'cmd.exe', ['/d', '/c', 'for %I in (.) do @echo %~fsI']) : repo;
  fs.symlinkSync(path.join(absoluteRoot, 'value'), link, 'file');
  git('add', 'alias');
  git('commit', '-qm', 'absolute internal link');
  verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  write(path.join(dir, 'outside'), 'new');
  fs.unlinkSync(link);
  fs.symlinkSync('../outside', link, 'file');
  assert.match(verb(repo, 2, 'prove', claim, '--base', 'HEAD').reason, /Symlink target is outside the snapshot/);
  git('add', 'alias');
  git('commit', '-qm', 'escaping link');
  assert.match(verb(repo, 2, 'baseline', claim, '--base', 'HEAD').reason, /Symlink target is outside the snapshot/);
});

test('submodules remain unsupported in commit and working snapshots', t => {
  const {repo, claim, git} = fixture(t);
  const base = git('rev-parse', 'HEAD');
  git('update-index', '--add', '--cacheinfo', `160000,${base},submodule`);
  git('commit', '-qm', 'gitlink');
  assert.match(verb(repo, 2, 'baseline', claim, '--base', 'HEAD').reason, /Commit submodules/);
  assert.match(verb(repo, 2, 'prove', claim, '--base', base).reason, /Working-tree submodules/);
});

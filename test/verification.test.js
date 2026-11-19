import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
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
  assert.equal(path.dirname(base.receipt), path.join(repo, '.git', 'verb', 'receipts'));
  assert.ok(fs.existsSync(path.join(base.frozen, 'fixtures/probe.mjs')));
  verb(repo, 1, 'check', claim);
  write(path.join(repo, 'value'), 'staged');
  git('add', 'value');
  write(path.join(repo, 'value'), 'new');
  const r = verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  assert.equal(r.replay[0], 'verb');
  verb(repo, 0, 'status', r.receipt);
  write(path.join(repo, 'new.txt'), 'new source');
  verb(repo, 2, 'status', r.receipt);
  verb(repo, 0, 'check', claim);
  git('add', '.');
  git('commit', '-qm', 'fixed');
  verb(repo, 0, 'prove', claim, '--base', 'HEAD^', '--candidate', 'HEAD');
  verb(repo, 2, 'baseline', claim, '--base', 'HEAD');
  verb(repo, 2, 'check', claim);
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD^');
  fs.appendFileSync(probe, '\n');
  assert.match(verb(repo, 2, 'check', claim).reason, /claim changed/);
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

test('conflicting observations on repeated identical inputs stay inconclusive', t => {
  const {repo, claim, probe, dir} = fixture(t);
  const toggle = path.join(dir, 'setting');
  write(probe, `import fs from 'node:fs'; import path from 'node:path';
console.log(JSON.stringify({origin:path.resolve('value'), observations:{value:fs.readFileSync(${JSON.stringify(toggle)},'utf8'),neighbor:'same'}}));`);
  write(toggle, 'old');
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  write(toggle, 'new');
  const r = verb(repo, 2, 'baseline', claim, '--base', 'HEAD');
  assert.match(r.reason, /conflicting reruns/);
});

test('parallel proofs run new files, omit deleted files and isolate profiles', async t => {
  const {repo, claim, probe} = fixture(t);
  write(probe, `import fs from 'node:fs'; import path from 'node:path';
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

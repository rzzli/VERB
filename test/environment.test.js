import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSide } from '../lib/run.js';
import { scratch, clean, fixture, project, write } from './helpers.js';

const upper = 'VERB_ENV_CASE_TEST';
const lower = upper.toLowerCase();

test('setup, probe and required commands use snapshot-local Git discovery', t => {
  const f = fixture(t);
  const tmp = path.join(f.repo, 'scratch');
  fs.mkdirSync(tmp);
  write(path.join(f.repo, '.gitignore'), '/scratch/\n');
  f.git('add', '.gitignore'); f.git('commit', '-qm', 'ignore project temporary directory');
  write(f.probe, `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
const git = (...args) => spawnSync('git', args, {encoding:'utf8'});
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) assert.equal(process.env[key], undefined);
const discovery = git('rev-parse','--show-toplevel'); assert.ifError(discovery.error); assert.notEqual(discovery.status,0);
const nested = fs.mkdtempSync(path.join(process.env.VERB_PROFILE,'local-git-'));
assert.equal(git('init','-q',nested).status,0);
assert.equal(fs.realpathSync.native(git('-C',nested,'rev-parse','--show-toplevel').stdout.trim()),nested);
const origin=path.resolve('value');
console.log(JSON.stringify({origin,observations:{value:fs.readFileSync(origin,'utf8'),neighbor:'same'}}));`);
  write(f.claim, { ...f.spec, setup: [f.spec.probe], required: [f.spec.probe] });
  write(path.join(f.repo, 'value'), 'new');
  const repoGit = path.join(f.repo, '.git');
  const run = spawnSync(process.execPath, [path.join(project, 'bin/verb.js'), 'prove', f.claim, '--base', 'HEAD', '--json'], {
    cwd: f.repo, encoding: 'utf8', timeout: 30000, env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
      GIT_DIR: repoGit, GIT_COMMON_DIR: repoGit, GIT_WORK_TREE: f.repo, GIT_INDEX_FILE: path.join(repoGit, 'index') }
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const { sides } = JSON.parse(run.stdout);
  assert.deepEqual(sides.base.commands.map(c => c.phase), ['setup','probe']);
  assert.deepEqual(sides.candidate.commands.map(c => c.phase), ['setup','probe','required']);
});

test('claim env overrides use Windows identity without folding POSIX variable names', async t => {
  const dir = scratch();
  const before = { [upper]: process.env[upper], [lower]: process.env[lower] };
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clean(dir);
  });
  delete process.env[lower];
  process.env[upper] = 'ambient';
  fs.writeFileSync(path.join(dir, 'source'), 'environment-reporting application');
  const probe = [process.execPath, '-e', `
    const path = require('node:path');
    console.log(JSON.stringify({origin: path.resolve('source'), observations: {
      upper: process.env.${upper} ?? 'missing',
      lower: process.env.${lower} ?? 'missing'
    }}));
  `];
  for (const key of [lower, upper]) {
    const expected = process.platform === 'win32' ? { upper: 'configured', lower: 'configured' } :
      key === lower ? { upper: 'ambient', lower: 'configured' } : { upper: 'configured', lower: 'missing' };
    const side = { commands: [] };
    await runSide(side, {
      env: { [key]: 'configured' }, probe, required: [],
      assertions: Object.entries(expected).map(([key, value]) => ({ key, base: value, fixed: value }))
    }, dir, dir, path.join(dir, 'profile-' + (key === lower ? 'lower' : 'upper')), 'base', false);
    assert.equal(side.verdict, 'verified', JSON.stringify(side));
    assert.deepEqual(side.observations, expected, key);
    assert.equal(side.commands[0].code, 0);
  }
});

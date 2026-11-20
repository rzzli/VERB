import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { freeze } from '../lib/files.js';
import { cmd, fixture, verb, write } from './helpers.js';

test('changing only a checkout observer cannot verify a broken CLI', t => {
  const f = fixture(t);
  const app = path.join(f.repo, 'app.cjs');
  const broken = "console.log(process.argv[2] === 'feature' ? 'old' : 'same');";
  write(app, broken);
  const observer = `const path = require('node:path');
const { execFileSync } = require('node:child_process');
const origin = path.resolve('app.cjs');
const inputs = JSON.parse(require('node:fs').readFileSync(process.argv[2]));
const read = input => execFileSync(process.execPath, [origin, input], {encoding: 'utf8'}).trim();
console.log(JSON.stringify({origin, observations: {value: read(inputs[0]), neighbor: read(inputs[1])}}));`;
  const localObserver = path.join(f.repo, 'observe.cjs');
  write(localObserver, observer);
  write(path.join(f.repo, 'suite.cjs'), `require('node:assert/strict').equal(
    require('node:child_process').execFileSync(process.execPath,['app.cjs','neighbor'],{encoding:'utf8'}).trim(), 'same');`);
  f.git('add', '.');
  f.git('commit', '-qm', 'application and checkout-local observer');
  write(path.join(f.dir, 'inputs.json'), ['feature', 'neighbor']);
  const spec = { ...f.spec, fixtures: ['inputs.json'], required: [['{node}', 'suite.cjs']],
    probe: ['{node}', 'observe.cjs', '{bundle}/inputs.json'] };
  write(f.claim, spec);
  write(localObserver, observer.replace('value: read(inputs[0])', "value: read(inputs[0]).replace('old', 'new')"));
  assert.equal(f.git('diff', '--name-only'), 'observe.cjs');
  assert.equal(cmd(f.repo, process.execPath, ['app.cjs', 'feature']), 'old');
  assert.equal(verb(f.repo, 2, 'prove', f.claim, '--base', 'HEAD').field, 'probe');

  write(path.join(f.dir, 'observe.cjs'), observer);
  write(f.claim, { ...spec, fixtures: ['observe.cjs', 'inputs.json'],
    probe: ['{node}', '{bundle}/observe.cjs', '{bundle}/inputs.json'] });
  const baseline = verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  const missed = verb(f.repo, 1, 'prove', f.claim, '--base', 'HEAD');
  assert.deepEqual(missed.sides.candidate.observations, { value: 'old', neighbor: 'same' });
  write(app, broken.replace("'old'", "'new'"));
  const fixed = verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  assert.equal(fixed.digest, baseline.digest);
  assert.deepEqual(fixed.sides.candidate.observations, { value: 'new', neighbor: 'same' });
  assert.equal(fixed.sides.candidate.commands.at(-1).phase, 'required');
});

test('undeclared scripts, checkout launchers and interpreter switches do not bind an observer', t => {
  const f = fixture(t);
  const frozen = '{bundle}/probe.mjs';
  for (const probe of [
    ['{node}', '{bundle}/undeclared.mjs', frozen],
    ['./node', frozen], ['{root}/python', frozen], ['node_modules/.bin/driver', frozen],
    ['{node}', '-e', '0', frozen], ['{node}', '--require', './changed.cjs', frozen],
    ['{python}', '-c', 'pass', frozen], ['sh', '-c', 'true', frozen]
  ]) {
    write(f.claim, { ...f.spec, probe });
    assert.throws(() => freeze(f.claim), { field: 'probe' });
  }
});

test('setup cannot rewrite a frozen result parser before the observer runs', t => {
  const f = fixture(t);
  write(path.join(f.dir, 'parser.cjs'), "module.exports = v => v;");
  fs.appendFileSync(f.probe, "\nimport './parser.cjs';\n");
  write(f.claim, { ...f.spec, fixtures: [...f.spec.fixtures, 'parser.cjs'],
    setup: [['{node}', '-e', "require('node:fs').appendFileSync(process.argv[1],'// changed')", '{bundle}/parser.cjs']] });
  const result = verb(f.repo, 2, 'prove', f.claim, '--base', 'HEAD');
  assert.match(result.reason, /frozen observer input changed.*parser\.cjs/i);
  assert.deepEqual(result.sides.base.commands.map(c => c.phase), ['setup']);
});

test('script names containing placeholder text address the exact frozen bytes', t => {
  const f = fixture(t);
  const name = 'observer-{root}-{node}.mjs';
  fs.renameSync(f.probe, path.join(f.dir, name));
  write(f.claim, { ...f.spec, fixtures: [name], probe: ['node', '{bundle}/' + name], env: { PATH: '{root}' } });
  write(path.join(f.repo, 'value'), 'new');
  const proof = verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  assert.equal(path.basename(proof.sides.candidate.commands[0].argv[1]), name);
  assert.equal(proof.sides.candidate.commands[0].argv[0], process.execPath);
});

test('a cached baseline from before observer validation needs a new baseline', t => {
  const f = fixture(t);
  const baseline = verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  const slot = path.join(path.dirname(baseline.frozen), 'current.json');
  const saved = JSON.parse(fs.readFileSync(slot, 'utf8'));
  delete saved.base.historyGeneration;
  write(slot, saved);
  write(path.join(f.repo, 'value'), 'new');
  assert.match(verb(f.repo, 2, 'check', f.claim).reason, /run baseline again/i);
  verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  verb(f.repo, 0, 'check', f.claim);
});

test('Windows cannot launch an unfrozen .exe sibling of a direct observer fixture',
  { skip: process.platform !== 'win32' }, t => {
    const f = fixture(t);
    write(path.join(f.dir, 'observer'), 'a data file with no extension');
    write(path.join(f.repo, 'value'), 'new');
    write(f.claim, { ...f.spec, fixtures: ['observer', 'probe.mjs'],
      setup: [['{node}', '-e', "require('node:fs').copyFileSync(process.execPath, process.argv[1])", '{bundle}/observer.exe']],
      probe: ['{bundle}/observer', '{bundle}/probe.mjs'] });
    const proof = verb(f.repo, 2, 'prove', f.claim, '--base', 'HEAD');
    assert.equal(proof.field, 'probe');
    assert.match(proof.reason, /\.exe or \.com/);
    assert.deepEqual(proof.sides, {});
    write(f.claim, { ...f.spec, probe: ['{bundle}/probe.mjs'] });
    assert.throws(() => freeze(f.claim), { field: 'probe' });
    write(f.claim, { ...f.spec, fixtures: ['observer'], probe: ['{node}', '{bundle}/observer'] });
    assert.doesNotThrow(() => freeze(f.claim));
  });

test('a frozen shell wrapper runs directly or with the host sh even if the checkout provides sh',
  { skip: process.platform === 'win32' }, t => {
    const f = fixture(t);
    const wrapper = path.join(f.dir, 'observer.sh');
    write(wrapper, '#!/bin/sh\nexec "$@"\n');
    fs.chmodSync(wrapper, 0o755);
    write(path.join(f.repo, 'sh'), '#!/bin/sh\nexit 77\n');
    fs.chmodSync(path.join(f.repo, 'sh'), 0o755);
    f.git('add', 'sh');
    f.git('commit', '-qm', 'similarly named local launcher');
    write(path.join(f.repo, 'value'), 'new');
    for (const launcher of [[], ['sh']]) {
      write(f.claim, { ...f.spec, fixtures: ['observer.sh', 'probe.mjs'], env: { PATH: '{root}' },
        probe: [...launcher, '{bundle}/observer.sh', '{node}', '{bundle}/probe.mjs'] });
      const proved = verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
      assert.ok(path.isAbsolute(proved.sides.candidate.commands[0].argv[0]));
      assert.equal(proved.sides.candidate.observations.value, 'new');
    }
  });

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { clean, cmd, project, scratch, write } from './helpers.js';

function node(cwd, args, code = 0, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // Keep the Git-only negative case independent of a user's demo override. Deliberately
  // retain NODE_TEST_CONTEXT: the public runner must isolate its own independent commands.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'GREETER_BUILD_VERSION') delete env[key];
  }
  const result = spawnSync(process.execPath, args, {
    cwd, env, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024
  });
  assert.ifError(result.error);
  assert.equal(result.status, code, result.stdout + result.stderr);
  return result;
}
function verb(cwd, code, ...args) {
  const child = node(cwd, [path.join(project, 'bin/verb.js'), ...args, '--json'], code);
  const result = JSON.parse(child.stdout || child.stderr);
  assert.equal(result.verdict, ['verified', 'failed', 'inconclusive'][code]);
  return result;
}
function demo(t) {
  const dir = scratch(), repo = path.join(dir, 'offline Node demo');
  t.after(() => clean(dir));
  const initializer = path.join(project, 'examples/node/create-demo.mjs');
  node(dir, [initializer, repo]);
  return { dir, repo, initializer, claim: path.join(repo, 'claim.json') };
}

test('offline Node quick start rejects a broad wrong patch and verifies the actual fixed CLI', t => {
  const { repo, claim } = demo(t);
  const originalClaim = fs.readFileSync(claim), originalProbe = fs.readFileSync(path.join(repo, 'probe.mjs'));
  const baseline = verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  assert.equal(baseline.sides.base.observations['empty name'], 'Hello, Guest!');
  assert.equal(baseline.sides.base.observations['missing name'], 'Hello, Guest!');
  assert.equal(baseline.sides.base.observations['build version'], 'demo-1');
  assert.equal(baseline.sides.base.origin.split(path.sep).join('/'), 'dist/greeter.cjs');
  assert.equal(fs.existsSync(path.join(repo, 'dist')), false, 'setup builds only inside each snapshot');

  node(repo, ['patch.mjs', 'wrong']);
  const wrong = verb(repo, 1, 'check', claim);
  assert.equal(wrong.sides.candidate.assertions.find(a => a.key === 'empty name').pass, true, 'the tempting fix satisfies the symptom');
  const control = wrong.sides.candidate.assertions.find(a => a.key === 'missing name');
  assert.equal(control.control, true);
  assert.equal(control.pass, false, 'the real neighbor distinguishes the broad wrong fix');
  assert.equal(control.actual, 'Hello, !');
  assert.equal(wrong.sides.candidate.assertions.find(a => a.key === 'named person').pass, true);
  verb(repo, 1, 'prove', claim, '--base', 'HEAD');
  verb(repo, 2, 'status', '--active');

  node(repo, ['patch.mjs', 'fixed']);
  const checked = verb(repo, 0, 'check', claim);
  assert.equal(checked.sides.candidate.commands.some(command => command.phase === 'required'), false);
  const proof = verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  assert.equal(proof.digest, baseline.digest, 'same frozen inputs across both patches');
  assert.ok(proof.sides.candidate.assertions.every(assertion => assertion.pass));
  const required = proof.sides.candidate.commands.filter(command => command.phase === 'required');
  assert.equal(required.length, 1);
  assert.equal(required[0].code, 0);
  assert.match(required[0].stdout, /malformed input fails/, JSON.stringify(required[0]));
  assert.match(required[0].stdout, /# fail 0/);
  verb(repo, 0, 'status');
  verb(repo, 0, 'status', '--active');
  const summary = cmd(repo, process.execPath, [path.join(project, 'bin/verb.js'), 'summary', proof.receipt]);
  assert.match(summary, /Hello, Guest!/);
  assert.match(summary, /Hello, !/);
  assert.match(summary, /missing name \[control\]/);
  assert.deepEqual(fs.readFileSync(claim), originalClaim);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'probe.mjs')), originalProbe);
});

test('Git-aware example builds in its repo, diagnoses source-only snapshots, and supports a frozen version override', t => {
  const { repo, claim } = demo(t);
  const sourceBuild = node(repo, ['build.cjs']);
  assert.match(sourceBuild.stdout, /Built Greeter version git-[0-9a-f]+/);
  const application = JSON.parse(node(repo, [path.join('dist', 'greeter.cjs'), '{}']).stdout);
  assert.match(application.version, /^git-[0-9a-f]+$/);
  assert.equal(cmd(repo, 'git', ['status', '--porcelain']), '', 'generated artifacts are ignored');

  const spec = JSON.parse(fs.readFileSync(claim, 'utf8'));
  delete spec.env;
  const gitOnly = path.join(repo, 'git-only-claim.json');
  write(gitOnly, spec);
  const failed = JSON.parse(node(repo, [path.join(project, 'bin/verb.js'), 'baseline', gitOnly, '--base', 'HEAD', '--json'], 2).stdout);
  assert.equal(failed.verdict, 'inconclusive');
  assert.deepEqual(failed.sides.base.commands.map(command => command.phase), ['setup']);
  assert.match(failed.sides.base.commands[0].stderr, /Git metadata is unavailable/);
  assert.match(failed.sides.base.commands[0].stderr, /GREETER_BUILD_VERSION/);
  assert.match(failed.sides.base.commands[0].stderr, /do not copy or link \.git/);
  const supported = verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  assert.equal(supported.sides.base.observations['build version'], 'demo-1');
  assert.equal(supported.sides.base.commands[0].stdout.trim(), 'Built Greeter version demo-1');
});

test('full CLI launched inside Node test context executes and fails a real required test instead of skipping it', t => {
  const { repo, claim } = demo(t);
  node(repo, ['patch.mjs', 'fixed']);
  fs.appendFileSync(path.join(repo, 'greeter.test.cjs'), `
    test('deliberate required test failure', () => assert.fail('must execute, not silently skip'));
  `);
  const child = node(repo, [path.join(project, 'bin/verb.js'), 'prove', claim, '--base', 'HEAD', '--json'], 1,
    { NODE_TEST_CONTEXT: 'child-v8' });
  const result = JSON.parse(child.stdout);
  assert.equal(result.verdict, 'failed');
  assert.ok(result.sides.candidate.assertions.every(assertion => assertion.pass), 'behavior passes before required test failure');
  const required = result.sides.candidate.commands.find(command => command.phase === 'required');
  assert.equal(required.code, 1);
  assert.match(required.stdout, /not ok .*deliberate required test failure/);
  assert.match(required.stdout, /# fail 1/);
  assert.doesNotMatch(required.stderr, /skipping running files/);
  assert.equal(JSON.parse(fs.readFileSync(result.receipt, 'utf8')).verdict, 'failed');
});

test('test-context isolation preserves explicit claim env and unrelated inherited Node options', t => {
  const { repo, claim } = demo(t);
  const spec = JSON.parse(fs.readFileSync(claim, 'utf8'));
  spec.env.NODE_TEST_CONTEXT = 'explicit-project-value';
  spec.required = [['{node}', '-e', `console.log(JSON.stringify({
    context: process.env.NODE_TEST_CONTEXT, options: process.env.NODE_OPTIONS, ambient: process.env.GREETER_AMBIENT
  }))`]];
  write(claim, spec);
  node(repo, ['patch.mjs', 'fixed']);
  const child = node(repo, [path.join(project, 'bin/verb.js'), 'prove', claim, '--base', 'HEAD', '--json'], 0,
    { NODE_TEST_CONTEXT: 'child-v8', NODE_OPTIONS: '--no-warnings', GREETER_AMBIENT: 'inherited' });
  const result = JSON.parse(child.stdout);
  const required = result.sides.candidate.commands.find(command => command.phase === 'required');
  assert.deepEqual(JSON.parse(required.stdout), {
    context: 'explicit-project-value', options: '--no-warnings', ambient: 'inherited'
  });
});

test('offline initializer refuses an existing destination without changing its files', t => {
  const { dir, repo, initializer } = demo(t);
  const before = fs.readFileSync(path.join(repo, 'greeter.cjs'));
  const result = node(dir, [initializer, repo], 2);
  assert.match(result.stderr, /Refusing to overwrite an existing directory/);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'greeter.cjs')), before);
  assert.equal(cmd(repo, 'git', ['rev-list', '--count', 'HEAD']), '1');
});

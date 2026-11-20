import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cmd, fixture, project, write, verb } from './helpers.js';

const attempt = (f, spec) => {
  write(f.claim, spec);
  return verb(f.repo, 2, 'baseline', f.claim, '--base', 'HEAD');
};

test('misspelled or unsupported fields name the exact location', t => {
  const f = fixture(t), one = f.spec.assertions[0];
  const cases = [
    [{ ...f.spec, assertion: f.spec.assertions }, 'assertion'],
    [{ ...f.spec, assertions: [one, { ...one, key: 'other', expected: 'x' }] }, 'assertions[1].expected'],
    [{ ...f.spec, probe: 'not an argv array' }, 'probe'],
    [{ ...f.spec, required: [['{node}', '-e', 'process.exit(0)', 7]] }, 'required[0]'],
    [{ ...f.spec, setup: [[42]] }, 'setup[0]'],
    [{ ...f.spec, fixtures: ['../probe.mjs'] }, 'fixtures[0]'],
    [{ ...f.spec, fixtures: ['nested\\probe.mjs'] }, 'fixtures[0]'],
    [{ ...f.spec, timeoutMs: 0 }, 'timeoutMs'],
    [{ ...f.spec, requiredTimeoutMs: 'soon' }, 'requiredTimeoutMs'],
    [{ ...f.spec, env: { 'BAD-NAME': 'value' } }, 'env.BAD-NAME'],
    [{ ...f.spec, assertions: [one, { ...one }] }, 'assertions[1].key'],
    [{ ...f.spec, assertions: [{ key: 'same', base: 'x', fixed: 'x' }] }, 'assertions']
  ];
  for (const [spec, field] of cases) {
    const result = attempt(f, spec);
    assert.equal(result.field, field, result.reason);
    assert.ok(result.reason.startsWith(field + ': '), field + ' => ' + result.reason);
  }
});

test('invalid JSON and invalid root values produce a claim-level diagnostic', t => {
  const f = fixture(t);
  const broken = attempt(f, '{"claim":');
  assert.equal(broken.field, '$');
  assert.match(broken.reason, /not valid JSON/);
  const array = attempt(f, '[]');
  assert.equal(array.field, '$');
  assert.match(array.reason, /must be a JSON object/);
});

test('absent controls or required commands are disclosed without blocking a minimal claim', t => {
  const f = fixture(t);
  write(f.claim, { ...f.spec, assertions: [{ key: 'value', base: 'old', fixed: 'new' }], required: [] });
  const baseline = verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  assert.deepEqual(baseline.scope, { observations: 1, controls: 0, requiredCommands: 0 });
  assert.deepEqual(baseline.warnings.map(w => w.code).sort(), ['no_controls', 'no_required_commands']);
  write(path.join(f.repo, 'value'), 'new');
  const proof = verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  assert.equal(proof.warnings.length, 2);
  const status = verb(f.repo, 0, 'status');
  assert.match(status.warnings.map(w => w.message).join('\n'), /No unchanged neighboring controls/);
  assert.match(status.warnings.map(w => w.message).join('\n'), /No required commands/);
  const text = spawnSync(process.execPath, [path.join(project, 'bin/verb.js'), 'summary', proof.receipt],
    { encoding: 'utf8', timeout: 30000 }).stdout;
  assert.match(text, /No required commands/);
});

test('reported scope counts declared observations, controls, and required commands', t => {
  const f = fixture(t);
  const baseline = verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  assert.deepEqual(baseline.scope, { observations: 2, controls: 1, requiredCommands: 1 });
  assert.deepEqual(baseline.warnings, []);
});

test('shareable summaries distinguish unusable observations and failed commands', t => {
  const f = fixture(t);
  const summary = r => cmd(f.repo, process.execPath, [path.join(project, 'bin/verb.js'), 'summary', r.receipt]);
  const setup = summary(attempt(f, { ...f.spec, setup: [['{node}', '-e',
    "console.error('compiler unavailable ' + 'x'.repeat(2000));process.exit(2)"]] }));
  assert.match(setup, /base\/setup: .*setup command failed/);
  assert.match(setup, /Diagnostic: "compiler unavailable/);
  assert.ok(!setup.includes('x'.repeat(320)));
  const timed = summary(attempt(f, { ...f.spec, timeoutMs: 100, setup: [['{node}','-e','setTimeout(()=>{},2000)']] }));
  assert.match(timed, /base\/setup: .*timed out/);
  const missing = summary(attempt(f, { ...f.spec, assertions: [...f.spec.assertions, {key:'missing',base:'a',fixed:'b'}] }));
  assert.match(missing, /base\/probe: .*missing or invalid observation: missing/);
  write(path.join(f.repo,'value'),'new');
  write(f.claim, { ...f.spec, required:[['{node}','-e',"console.error('suite detail');process.exit(7)"]] });
  const required = summary(verb(f.repo, 1, 'prove', f.claim, '--base', 'HEAD'));
  assert.match(required, /candidate\/required: .*required command failed/);
  assert.match(required, /Diagnostic: "suite detail"/);
  write(f.probe, 'console.log(JSON.stringify({origin:process.execPath,observations:{}}));');
  assert.match(summary(attempt(f, f.spec)), /base\/probe: .*origin is outside the checkout/);
});

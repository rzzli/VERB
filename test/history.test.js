import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, write, verb } from './helpers.js';
import { detectConflicts, entries, recent, load } from '../lib/store.js';

function suiteFixture(t, count = 1) {
  const f = fixture(t);
  const flags = Array.from({ length: count }, (_, i) => path.join(f.dir, `suite-${i}`));
  for (const flag of flags) write(flag, '0');
  write(f.claim, { ...f.spec, required: flags.map(flag => ['{node}', '-e',
    `process.exit(Number(require('node:fs').readFileSync(${JSON.stringify(flag)}, 'utf8')))`]) });
  verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  write(path.join(f.repo, 'value'), 'new');
  return { ...f, flags, prove: code => verb(f.repo, code, 'prove', f.claim, '--base', 'HEAD'),
    check: code => verb(f.repo, code, 'check', f.claim) };
}

test('checks cannot replace the three actual required-command reruns needed for recovery', t => {
  const f = suiteFixture(t);
  f.prove(0);
  write(f.flags[0], '1');
  assert.match(f.prove(2).reason, /last three completed runs/);
  for (let i = 0; i < 4; i++) f.check(2);
  write(f.flags[0], '0');
  f.prove(2);
  f.prove(2);
  f.prove(0);
});

test('a later required-command conflict survives runs stopped by an earlier command', t => {
  const f = suiteFixture(t, 2);
  f.prove(0);
  write(f.flags[1], '1');
  f.prove(2);
  write(f.flags[0], '1');
  for (let i = 0; i < 4; i++) {
    const r = f.prove(2);
    assert.equal(r.sides.candidate.commands.filter(c => c.phase === 'required').length, 1);
  }
  write(f.flags[0], '0');
  write(f.flags[1], '0');
  f.prove(2);
  f.prove(2);
  f.prove(0);
});

test('cached baselines do not count toward recovery after a contradictory fresh baseline', t => {
  const f = fixture(t), flag = path.join(f.dir, 'base-state');
  write(flag, 'old');
  write(f.probe, `import fs from 'node:fs'; import path from 'node:path';
const value = fs.readFileSync('value', 'utf8');
console.log(JSON.stringify({origin:path.resolve('value'), observations:{
  value:value === 'old' ? fs.readFileSync(${JSON.stringify(flag)}, 'utf8') : value, neighbor:'same'}}));`);
  verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  write(path.join(f.repo, 'value'), 'new');
  write(flag, 'wrong');
  verb(f.repo, 2, 'prove', f.claim, '--base', 'HEAD');
  write(flag, 'old');
  for (let i = 0; i < 4; i++) verb(f.repo, 2, 'check', f.claim);
  verb(f.repo, 2, 'baseline', f.claim, '--base', 'HEAD');
  verb(f.repo, 2, 'baseline', f.claim, '--base', 'HEAD');
  verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  verb(f.repo, 0, 'check', f.claim);
});

test('candidate observations retain one shared history across check and prove', t => {
  const f = fixture(t), flag = path.join(f.dir, 'candidate-state');
  write(flag, 'new');
  write(f.probe, `import fs from 'node:fs'; import path from 'node:path';
const value = fs.readFileSync('value', 'utf8');
console.log(JSON.stringify({origin:path.resolve('value'), observations:{
  value:value === 'new' ? fs.readFileSync(${JSON.stringify(flag)}, 'utf8') : value, neighbor:'same'}}));`);
  verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  write(path.join(f.repo, 'value'), 'new');
  verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  write(flag, 'wrong');
  verb(f.repo, 2, 'check', f.claim);
  write(flag, 'new');
  verb(f.repo, 2, 'prove', f.claim, '--base', 'HEAD');
  verb(f.repo, 2, 'check', f.claim);
  verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
});

test('required conflicts survive more than 30 checks and incomplete command executions', t => {
  const f = fixture(t), store = path.join(f.dir, 'store');
  const dir = path.join(store, 'history', 'claims', 'claim-key');
  let sequence = 0;
  const run = commands => {
    const before = new Set(entries(dir).map(entry => entry.name));
    const side = { kind: 'working', id: 'unchanged-input', observations: { value: 'new' },
      assertions: [], commands, verdict: 'verified' };
    detectConflicts(store, 'claim-key', 'digest', 'candidate', side);
    const added = entries(dir).find(entry => !before.has(entry.name));
    // Deterministic ordering for rapid unit calls on filesystems with coarse timestamps.
    fs.utimesSync(path.join(dir, added.name), 1700000000 + sequence, 1700000000 + sequence++);
    return side;
  };
  const completed = code => [{ phase: 'required', code }];
  assert.equal(run(completed(0)).verdict, 'verified');
  assert.equal(run(completed(1)).verdict, 'inconclusive');
  for (let i = 0; i < 35; i++) assert.equal(run([]).verdict, 'inconclusive');
  for (let i = 0; i < 5; i++) {
    assert.equal(run([{ phase: 'required', code: null, error: 'command timed out' }]).verdict, 'inconclusive');
  }
  assert.equal(run(completed(0)).verdict, 'inconclusive');
  assert.equal(run(completed(0)).verdict, 'inconclusive');
  assert.equal(run(completed(0)).verdict, 'verified');
  assert.equal(entries(dir).length, 30);
  assert.ok(load(recent(dir)[0].file).suiteHistory.every(window => window.length <= 3));
});

test('history and receipt retention remain bounded across check and prove modes', t => {
  const f = suiteFixture(t);
  const proof = f.prove(0), receipts = path.dirname(proof.receipt);
  const history = path.join(f.repo, '.git', 'verb', 'history', 'claims', path.basename(receipts));
  for (let i = 0; i < 32; i++) {
    if (i % 4 === 0) f.prove(0);
    else f.check(0);
  }
  assert.equal(fs.readdirSync(receipts).filter(name => name.endsWith('.json')).length, 30);
  assert.equal(fs.readdirSync(history).filter(name => name.endsWith('.json')).length, 30);
});

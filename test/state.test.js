import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, project, write, verb } from './helpers.js';
import { baselineFormat, receiptFormat } from '../lib/state.js';

const slotOf = (f, receipt) => path.join(f.repo, '.git', 'verb', 'baselines', path.basename(path.dirname(receipt)), 'current.json');

test('baseline records identify their format and legacy records remain readable', t => {
  const f = fixture(t);
  const baseline = verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  const slot = slotOf(f, baseline.receipt);
  const saved = JSON.parse(fs.readFileSync(slot, 'utf8'));
  assert.equal(saved.format, baselineFormat);
  assert.equal(JSON.parse(fs.readFileSync(baseline.receipt, 'utf8')).format, receiptFormat);
  // Legacy slots and receipts predate explicit format ids.
  delete saved.format;
  write(slot, saved);
  const legacyReceipt = JSON.parse(fs.readFileSync(baseline.receipt, 'utf8'));
  delete legacyReceipt.format;
  write(baseline.receipt, legacyReceipt);
  write(path.join(f.repo, 'value'), 'new');
  verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  verb(f.repo, 0, 'status', '--active');
});

test('an unsequenced proof remains inspectable until a new proof restores automatic approval', t => {
  const f = fixture(t);
  verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  write(path.join(f.repo, 'value'), 'new');
  const proof = verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  const legacy = JSON.parse(fs.readFileSync(proof.receipt, 'utf8'));
  legacy.format = 'verb-receipt/1';
  delete legacy.targetKind;
  delete legacy.sequence;
  legacy.receipt = path.join(path.dirname(proof.receipt), path.basename(proof.receipt).split('~')[1]);
  fs.renameSync(proof.receipt, legacy.receipt);
  write(legacy.receipt, legacy);
  verb(f.repo, 0, 'status', legacy.receipt);
  assert.match(verb(f.repo, 2, 'status').reason, /publication sequence/);
  assert.match(verb(f.repo, 2, 'status', '--active').reason, /publication sequence/);
  verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  verb(f.repo, 0, 'status', '--active');
});

test('unsupported or malformed state fails closed with the record path', t => {
  const f = fixture(t);
  const baseline = verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  const slot = slotOf(f, baseline.receipt);
  const saved = JSON.parse(fs.readFileSync(slot, 'utf8'));

  write(slot, { ...saved, format: 'verb-baseline/99' });
  const future = verb(f.repo, 2, 'status', '--active');
  assert.match(future.reason, /Unsupported baseline record format/);
  assert.match(future.reason, /verb-baseline\/99/);

  write(slot, { ...saved, verdict: 'maybe' });
  assert.match(verb(f.repo, 2, 'status', '--active').reason, /Invalid baseline record verdict/);

  write(slot, 'not json');
  assert.match(verb(f.repo, 2, 'status', '--active').reason, /Cannot read baseline record/);

  write(slot, saved);
  const stored = JSON.parse(fs.readFileSync(baseline.receipt, 'utf8'));
  write(baseline.receipt, { ...stored, format: 'verb-receipt/99' });
  assert.match(verb(f.repo, 2, 'status').reason, /Unsupported receipt format/);
  const summarized = spawnSync(process.execPath, [path.join(project, 'bin/verb.js'), 'summary', baseline.receipt],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(summarized.status, 2);
  assert.match(summarized.stderr, /Unsupported receipt format/);

  write(baseline.receipt, { ...stored, verdict: 'probably' });
  assert.match(verb(f.repo, 2, 'status').reason, /Invalid receipt verdict/);

  write(baseline.receipt, '{');
  assert.match(verb(f.repo, 2, 'status').reason, /Cannot read receipt/);
});

test('a malformed newest receipt cannot silently expose an older verified proof', t => {
  const f = fixture(t);
  verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  write(path.join(f.repo, 'value'), 'new');
  verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  const newest = verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  write(newest.receipt, '{"verdict":"verified"');
  const status = verb(f.repo, 2, 'status');
  assert.match(status.reason, /Cannot read receipt/);
});

test('partial verified records are not treated as complete approval', t => {
  const f = fixture(t);
  verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  write(path.join(f.repo, 'value'), 'new');
  const proof = verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  const complete = JSON.parse(fs.readFileSync(proof.receipt, 'utf8'));
  write(proof.receipt, { ...complete, sides: {} });
  assert.match(verb(f.repo, 2, 'status').reason, /incomplete|not verified/);
});

test('publication order survives tied and reversed receipt timestamps', t => {
  const f = fixture(t);
  verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  write(path.join(f.repo, 'value'), 'new');
  const green = verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  write(f.claim, { ...f.spec, required: [['{node}', '-e', 'process.exit(7)']] });
  const red = verb(f.repo, 1, 'prove', f.claim, '--base', 'HEAD');
  assert.ok(red.sequence > green.sequence);
  for (const time of [100, 200]) {
    fs.utimesSync(green.receipt, time, time);
    fs.utimesSync(red.receipt, 100, 100);
    assert.equal(verb(f.repo, 2, 'status').receipt, red.receipt);
  }
  for (const field of ['action','repo','targetKind','sides','required','sequence']) {
    const damaged = { ...red }; delete damaged[field]; write(red.receipt, damaged);
    assert.match(verb(f.repo, 2, 'status').reason, /Invalid or incomplete/);
  }
});

test('rotation retains the latest publications even with restored file times', t => {
  const f = fixture(t);
  const baseline = verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  write(path.join(f.repo, 'value'), 'new');
  const check = verb(f.repo, 0, 'check', f.claim);
  const dir = path.dirname(check.receipt);
  for (let sequence = 3; sequence <= 32; sequence++) {
    const file = path.join(dir, sequence + '~check-sample.json');
    write(file, { ...check, sequence, receipt: file });
    fs.utimesSync(file, 200 - sequence, 200 - sequence);
  }
  const newest = verb(f.repo, 0, 'check', f.claim);
  assert.equal(newest.sequence, 33);
  assert.equal(fs.readdirSync(dir).length, 30);
  assert.ok(fs.existsSync(baseline.receipt));
  assert.ok(fs.existsSync(path.join(dir, '32~check-sample.json')));
  assert.equal(fs.existsSync(check.receipt), false);
  assert.equal(fs.existsSync(path.join(dir, '4~check-sample.json')), false);
});

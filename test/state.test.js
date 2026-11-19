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

test('unsupported or malformed state fails closed with the record path', t => {
  const f = fixture(t);
  const baseline = verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  const slot = slotOf(f, baseline.receipt);
  const saved = JSON.parse(fs.readFileSync(slot, 'utf8'));

  write(slot, { ...saved, format: 'verb-baseline/2' });
  const future = verb(f.repo, 2, 'status', '--active');
  assert.match(future.reason, /Unsupported baseline record format/);
  assert.match(future.reason, /verb-baseline\/2/);

  write(slot, { ...saved, verdict: 'maybe' });
  assert.match(verb(f.repo, 2, 'status', '--active').reason, /Invalid baseline record verdict/);

  write(slot, 'not json');
  assert.match(verb(f.repo, 2, 'status', '--active').reason, /Cannot read baseline record/);

  write(slot, saved);
  const stored = JSON.parse(fs.readFileSync(baseline.receipt, 'utf8'));
  write(baseline.receipt, { ...stored, format: 'verb-receipt/2' });
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

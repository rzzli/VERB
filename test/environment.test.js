import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { runSide } from '../lib/run.js';
import { scratch, clean } from './helpers.js';

const upper = 'VERB_ENV_CASE_TEST';
const lower = upper.toLowerCase();

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

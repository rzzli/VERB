import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'linux') throw Error('This trial observes Windows receipts reviewed on Linux.');
const origin = path.resolve('bin/verb.js');
const bundle = path.dirname(fileURLToPath(import.meta.url));
function observe(name, paths) {
  const file = path.join(bundle, name);
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = spawnSync(process.execPath, [origin, 'summary', file], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.ok(lines.includes('Claim digest (SHA-256): ' + receipt.digest), result.stdout);
  for (const side of Object.values(receipt.sides)) assert.ok(result.stdout.includes(side.id), result.stdout);
  const relative = value => {
    const rel = paths.relative(receipt.repo, value);
    return paths.isAbsolute(rel) ? '(outside repository volume)' : rel.split(paths.sep).join('/');
  };
  const expectedClaim = 'Claim: ' + relative(receipt.claimPath);
  const expectedOrigins = Object.values(receipt.sides).map(side =>
    '  Origin: ' + side.origin.split(paths.sep).join('/'));
  const relativeArg = value => {
    if (paths.isAbsolute(value)) return relative(value);
    const equals = value.indexOf('=');
    return equals > 0 && paths.isAbsolute(value.slice(equals + 1)) ?
      value.slice(0, equals + 1) + relative(value.slice(equals + 1)) : value;
  };
  const completed = receipt.sides.candidate?.commands.filter(c => c.phase === 'required') ?? [];
  const expectedCommands = receipt.required.map((args, i) =>
    'Required ' + JSON.stringify(args.map(relativeArg)) + ': ' +
      (completed[i] ? 'exit ' + (completed[i].code ?? 'unavailable') : 'not run'));
  return [expectedClaim, ...expectedOrigins, ...expectedCommands].every(line => lines.includes(line)) ?
    'relative' : 'host-path-leak';
}
console.log(JSON.stringify({ origin, observations: {
  'Windows receipt paths on Linux': observe('windows.receipt.json', path.win32),
  'native receipt path control': observe('native.receipt.json', path.posix)
} }));

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, verb, write } from './helpers.js';

function byteFixture(t) {
  const f = fixture(t);
  f.spec.claim = 'show the replacement character �';
  f.spec.assertions[0].fixed = '�';
  f.spec.required = [['{node}', '-e', 'process.stdout.write(Buffer.from([0xff]))']];
  write(f.claim, f.spec);
  write(f.probe, `import fs from 'node:fs';
import path from 'node:path';
const origin = path.resolve('value');
process.stderr.write(Buffer.from([0xff]));
process.stdout.write(Buffer.concat([
  Buffer.from('{"origin":' + JSON.stringify(origin) + ',"observations":{"value":"'),
  fs.readFileSync(origin),
  Buffer.from('","neighbor":"same"}}')
]));
`);
  return f;
}

test('a literal replacement character is valid in a claim and in probe observations', t => {
  const f = byteFixture(t);
  write(path.join(f.repo, 'value'), '�');
  const proof = verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  assert.equal(proof.claim, f.spec.claim);
  assert.equal(proof.sides.candidate.observations.value, '�');
});

test('malformed claim bytes produce a claim-level encoding diagnostic', t => {
  const f = byteFixture(t);
  const contents = fs.readFileSync(f.claim);
  contents[contents.indexOf('�')] = 0xff;
  fs.writeFileSync(f.claim, contents);
  const result = verb(f.repo, 2, 'baseline', f.claim, '--base', 'HEAD');
  assert.equal(result.field, '$');
  assert.match(result.reason, /claim is not valid UTF-8/);
});

test('malformed probe bytes cannot satisfy a replacement-character assertion', t => {
  const f = byteFixture(t);
  fs.writeFileSync(path.join(f.repo, 'value'), Buffer.from([0xff]));
  const proof = verb(f.repo, 2, 'prove', f.claim, '--base', 'HEAD');
  assert.equal(proof.sides.base.verdict, 'verified');
  assert.equal(proof.sides.candidate.verdict, 'inconclusive');
  assert.match(proof.sides.candidate.reason, /probe output is not valid UTF-8/);
  assert.equal(proof.sides.candidate.observations, undefined);
});

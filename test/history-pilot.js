// Usage: node test/history-pilot.js /path/to/click /path/to/escape-string-regexp
import fs from 'node:fs';
import path from 'node:path';
import { project, scratch, clean, cmd, verb, write } from './helpers.js';

const [clickSource, regexpSource] = process.argv.slice(2).map(p => path.resolve(p));
if (!regexpSource) throw Error('Expected paths to Click and escape-string-regexp clones');
const dir = scratch();
const results = [];
try {
  const click = path.join(dir, 'click'), regexp = path.join(dir, 'regexp');
  for (const [src, dst] of [[clickSource, click], [regexpSource, regexp]]) {
    cmd(dir, 'git', ['clone', '--no-hardlinks', '--no-checkout', src, dst]);
  }
  const clickClaim = path.join(project, 'examples/click/claim.json');
  const options = JSON.parse(fs.readFileSync(clickClaim));
  const cases = [[click, 'd3e3852', clickClaim]];
  const help = path.join(dir, 'help.json');
  fs.copyFileSync(path.join(project, 'test/pilot/help.py'), path.join(dir, 'help.py'));
  write(help, { ...options, claim: 'Empty help paragraph after truncation', probe: ['{python}', '{bundle}/help.py'],
    fixtures: ['help.py'], assertions: [{ key: 'blank lines', base: '3', fixed: '1' },
      { key: 'visible help', base: 'True', fixed: 'True' }],
    required: [['{python}', '-m', 'pytest', '-q', 'tests/test_formatting.py']] });
  cases.push([click, '850bffe', help]);
  fs.copyFileSync(path.join(project, 'test/pilot/regexp.cjs'), path.join(dir, 'regexp.cjs'));
  for (const [fix, key, base, fixed] of [
    ['e76291d', 'character class', 'true', 'false'],
    ['732905d', 'unicode', 'syntax error', 'true'],
    ['ec45c70', 'portable escape', '\\u002d', '\\x2d']
  ]) {
    const claim = path.join(dir, fix + '.json');
    write(claim, { claim: key, probe: ['{node}', '{bundle}/regexp.cjs', key], fixtures: ['regexp.cjs'],
      assertions: [{ key, base, fixed }, { key: 'plain text', base: 'abc', fixed: 'abc' }],
      required: [['{node}', '--check', 'index.js']] });
    cases.push([regexp, fix, claim]);
  }
  for (const [repo, fix, claim] of cases) {
    const base = fix + '^1';
    cmd(repo, 'git', ['checkout', '--quiet', '--detach', fix]);
    verb(repo, 0, 'baseline', claim, '--base', base);
    const start = Date.now();
    verb(repo, 0, 'check', claim);
    const focusedMs = Date.now() - start;
    const proofStart = Date.now();
    const receipt = verb(repo, 0, 'prove', claim, '--base', base, '--candidate', fix);
    results.push({ fix, claim: receipt.claim, focusedMs, proofMs: Date.now() - proofStart,
      base: receipt.sides.base.observations, candidate: receipt.sides.candidate.observations });
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  clean(dir);
}

// Usage: node test/measurement/pilot.mjs CLICK_CLONE REGEXP_CLONE
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, scratch, clean, cmd, verb, write } from '../helpers.js';

const sources = process.argv.slice(2).map(p => path.resolve(p));
if (sources.length !== 2) throw Error('Supply local Click and escape-string-regexp clones');
const here = path.dirname(fileURLToPath(import.meta.url));
const area = scratch();
const clickSpec = JSON.parse(fs.readFileSync(path.join(project, 'examples/click/claim.json')));
const cases = [
  { repo: 0, fix: 'd3e3852', spec: clickSpec, probe: path.join(project, 'examples/click/probe.py'),
    source: 'src/click/core.py', edit: s => s.replace('(show_default and (default_value is not None))', 'show_default') },
  { repo: 0, fix: '850bffe', spec: { ...clickSpec, claim: 'Skip an empty truncated help paragraph',
    probe: ['{python}', '{bundle}/help.py'], fixtures: ['help.py'],
    assertions: [{key:'blank lines', base:'3', fixed:'1'}, {key:'visible help', base:'True', fixed:'True'}],
    required: [['{python}', '-m', 'pytest', '-q', 'tests/test_formatting.py']] }, probe: path.join(here, 'help.py'),
    source: 'src/click/core.py', edit: s => s.replace('inspect.cleandoc(self.help).partition("\\f")[0]',
      '"" if "\\f" in self.help else inspect.cleandoc(self.help)') }
];
for (const [fix, key, base, fixed, prefix, width] of [
  ['e76291d','character class','true','false','\\x',2],
  ['732905d','unicode','syntax error','true','\\u',4],
  ['ec45c70','portable escape','\\u002d','\\x2d','\\x',2]
]) {
  cases.push({ repo: 1, fix, spec: {claim: key, probe:['{node}','{bundle}/regexp.cjs',key],
    fixtures:['regexp.cjs'], assertions:[{key, base, fixed},{key:'plain text',base:'abc',fixed:'abc'}],
    required:[['{node}','--check','index.js']] }, probe: path.join(here,'regexp.cjs'), source:'index.js',
    edit: () => 'module.exports = s => Array.from(s, c => ' + JSON.stringify(prefix) +
      ' + c.charCodeAt(0).toString(16).padStart(' + width + ', "0")).join("");\n' });
}
const results = [];
try {
  const repos = sources.map((source, i) => {
    const dest = path.join(area, 'repo-' + i);
    cmd(area, 'git', ['clone','--quiet','--no-hardlinks','--no-checkout',source,dest]);
    return dest;
  });
  for (const item of cases) {
    const repo = repos[item.repo], base = item.fix + '^';
    cmd(repo, 'git', ['checkout','--quiet','--detach',item.fix]);
    const start = performance.now();
    const bundle = path.join(area, item.fix), claim = path.join(bundle, 'claim.json');
    fs.mkdirSync(bundle);
    fs.copyFileSync(item.probe, path.join(bundle, path.basename(item.probe)));
    write(claim, item.spec);
    verb(repo, 0, 'baseline', claim, '--base', base);
    const wireAndBaselineMs = Math.round(performance.now() - start);
    const checksMs = [];
    for (let i=0; i<3; i++) {
      const begin = performance.now(); verb(repo, 0, 'check', claim);
      checksMs.push(Math.round(performance.now() - begin));
    }
    const begin = performance.now();
    const proof = verb(repo, 0, 'prove', claim, '--base', base, '--candidate', item.fix);
    const proveMs = Math.round(performance.now() - begin);
    const source = path.join(repo, item.source), good = fs.readFileSync(source,'utf8');
    const wrong = item.edit(good);
    assert.notEqual(wrong, good);
    write(source, wrong);
    const candidate = verb(repo, 1, 'check', claim).sides.candidate;
    assert.ok(candidate.assertions.filter(a => !a.control).every(a => a.pass));
    const rejectedBy = candidate.assertions.filter(a => a.control && !a.pass).map(a => a.key);
    assert.ok(rejectedBy.length);
    write(source, good);
    results.push({fix: item.fix, base: proof.sides.base.id, claim:item.spec.claim, wireAndBaselineMs,
      checksMs, proveMs, requiredMs:proof.sides.candidate.commands.filter(c=>c.phase==='required').reduce((n,c)=>n+c.ms,0),
      rejectedBy});
  }
  console.log(JSON.stringify(results,null,2));
} finally { clean(area); }

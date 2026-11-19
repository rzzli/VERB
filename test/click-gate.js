// Run from a clone of pallets/click. Only the temporary clone is edited.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, scratch, clean, cmd, verb, write } from './helpers.js';

const dir = scratch();
const repo = path.join(dir, 'click');
const specDir = path.join(dir, 'claim');
const claim = path.join(specDir, 'claim.json');
const base = 'c021f05', fix = 'd3e3852';
const gates = [];
function gate(label, code, ...args) {
  const start = Date.now();
  const result = verb(repo, code, ...args);
  gates.push({ label, outcome: result.verdict, ms: Date.now() - start });
  return result;
}
try {
  cmd(dir, 'git', ['clone', '--quiet', '--no-checkout', '--no-hardlinks', process.cwd(), repo]);
  cmd(repo, 'git', ['checkout', '--quiet', '--detach', base]);
  fs.cpSync(path.join(project, 'examples/click'), specDir, { recursive: true });
  const spec = JSON.parse(fs.readFileSync(claim));
  gate('baseline', 0, 'baseline', claim, '--base', base);
  gate('same broken revision', 1, 'prove', claim, '--base', base, '--candidate', base);
  gate('fixed commit', 0, 'prove', claim, '--base', base, '--candidate', fix);
  cmd(repo, 'git', ['restore', '--source=' + fix, '--worktree', '.']);
  gate('focused local edit', 0, 'check', claim);
  gate('uncommitted fix', 0, 'prove', claim, '--base', base);
  const source = path.join(repo, 'src/click/core.py');
  const good = fs.readFileSync(source, 'utf8');
  write(source, good.replace('(show_default and (default_value is not None))', 'show_default'));
  const broad = gate('overbroad fix', 1, 'check', claim);
  assert.equal(broad.sides.candidate.assertions.find(a => a.control).pass, false);
  write(source, good);
  gate('already fixed baseline', 2, 'baseline', claim, '--base', fix);
  write(claim, { ...spec, required: [['{node}', '-e', 'process.exit(1)']] });
  const suite = gate('broken required suite', 1, 'prove', claim, '--base', base, '--candidate', fix);
  assert.ok(suite.sides.candidate.assertions.every(a => a.pass));
  assert.equal(suite.sides.candidate.commands.at(-1).code, 1);
  write(claim, { ...spec, assertions: [...spec.assertions, {key: 'missing option', base:'x', fixed:'x'}] });
  assert.match(gate('missing observation', 2, 'prove', claim, '--base', base).reason, /missing.*observation/);
  const ambient = path.join(dir, 'site-packages');
  fs.cpSync(path.join(repo, 'src/click'), path.join(ambient, 'click'), { recursive: true });
  write(claim, { ...spec, env: { ...spec.env, PYTHONPATH: ambient } });
  assert.match(gate('ambient Click import', 2, 'prove', claim, '--base', base).reason, /origin/);
  console.log(JSON.stringify({ platform: process.platform, gates }, null, 2));
} finally {
  clean(dir);
}

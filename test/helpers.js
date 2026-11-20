import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './git-environment.mjs';

export const project = fileURLToPath(new URL('../', import.meta.url));
export const scratch = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'verb gate ')));
export const clean = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
export const write = (file, data) => fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
export function cmd(cwd, exe, args) {
  const p = spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(p.error);
  assert.equal(p.status, 0, p.stderr + p.stdout);
  return p.stdout.trim();
}
export function fixture(t) {
  const dir = scratch();
  t.after(() => clean(dir));
  const repo = path.join(dir, 'repository'), claim = path.join(dir, 'claim.json');
  fs.mkdirSync(repo);
  const git = (...args) => cmd(repo, 'git', args);
  git('init', '-q');
  git('config', 'user.email', 'fixture@localhost');
  git('config', 'user.name', 'Fixture');
  write(path.join(repo, 'value'), 'old');
  git('add', '.');
  git('commit', '-qm', 'broken');
  const probe = path.join(dir, 'probe.mjs');
  write(probe, `import fs from 'node:fs'; import path from 'node:path';
const origin = path.resolve('value');
console.log(JSON.stringify({origin, observations:{value:fs.readFileSync(origin,'utf8'),neighbor:'same'}}));`);
  const spec = { claim: 'read saved value', probe: ['{node}', '{bundle}/probe.mjs'], fixtures: ['probe.mjs'],
    assertions: [{ key: 'value', base: 'old', fixed: 'new' }, { key: 'neighbor', base: 'same', fixed: 'same' }],
    required: [['{node}', '-e', 'process.exit(0)']] };
  write(claim, spec);
  return { dir, repo, claim, spec, git, probe };
}

export function verb(cwd, code, ...args) {
  const p = spawnSync(process.execPath, [path.join(project, 'bin/verb.js'), ...args, '--json'],
    { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(p.error);
  const result = JSON.parse(p.stdout || p.stderr);
  assert.equal(p.status, code, JSON.stringify(result, null, 2));
  assert.equal(result.verdict, ['verified', 'failed', 'inconclusive'][code]);
  return result;
}

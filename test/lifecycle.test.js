import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fixture, project, write, verb } from './helpers.js';

const cli = path.join(project, 'bin/verb.js');
const hook = (repo, mode) => spawnSync(process.execPath, [path.join(project, 'hooks/verify.mjs'), mode],
  { cwd: repo, encoding: 'utf8', timeout: 15000 });

function injectedCleanup(f, action, location) {
  const wrapper = path.join(f.dir, 'cleanup-wrapper.mjs');
  write(wrapper, `import fs from 'node:fs'; import path from 'node:path';
const make = fs.mkdtempSync, remove = fs.rmSync, owned = new Set();
fs.mkdtempSync = (...args) => { const dir = make(...args); if (path.basename(args[0]) === 'verb-') owned.add(fs.realpathSync(dir)); return dir; };
fs.rmSync = (dir, options) => {
  const target = ${JSON.stringify(location)} === 'outer' ? owned.has(dir) : owned.has(path.dirname(dir));
  if (target && options?.recursive) throw Object.assign(Error('injected snapshot cleanup failure'), {code:'EBUSY'});
  return remove(dir, options);
};
process.on('exit', () => { for (const dir of owned) remove(dir, {recursive:true,force:true,maxRetries:3}); });
process.argv = [process.execPath, ${JSON.stringify(cli)}, ${JSON.stringify(action)}, ${JSON.stringify(f.claim)}, '--base', 'HEAD', '--json'];
await import(${JSON.stringify(pathToFileURL(cli).href)});`);
  const p = spawnSync(process.execPath, [wrapper], { cwd: f.repo, encoding: 'utf8', timeout: 15000 });
  assert.ifError(p.error);
  assert.equal(p.status, 2, p.stdout + p.stderr);
  return JSON.parse(p.stdout || p.stderr);
}

for (const location of ['side', 'outer']) {
  test(`${location} cleanup failures persist the latest attempt and block both hooks`, t => {
    const f = fixture(t);
    verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
    write(path.join(f.repo, 'value'), 'new');
    verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
    const failed = injectedCleanup(f, 'prove', location);
    assert.equal(failed.action, 'prove');
    assert.ok(fs.existsSync(failed.receipt));
    assert.match(failed.cleanupErrors[0].message, /injected snapshot cleanup failure/);
    assert.equal(verb(f.repo, 2, 'status').receipt, failed.receipt);
    verb(f.repo, 2, 'status', '--active');
    assert.equal(hook(f.repo, '--stop').status, 2);
    assert.equal(hook(f.repo, '--pre-commit').status, 1);
    if (location === 'side') assert.equal(failed.sides.candidate, undefined, 'do not run a sibling while failed cleanup remains');
  });
}

test('cleanup failure preserves the original verification failure diagnostic', t => {
  const f = fixture(t);
  write(f.claim, { ...f.spec, required: [['{node}', '-e', 'process.exit(7)']] });
  write(path.join(f.repo, 'value'), 'new');
  const failed = injectedCleanup(f, 'prove', 'outer');
  assert.equal(failed.reason, 'required command failed');
  assert.equal(failed.sides.candidate.commands.at(-1).code, 7);
  assert.ok(failed.cleanupErrors.length);
});

test('failed rebaseline cleanup stays active and requires a new successful baseline', t => {
  const f = fixture(t);
  verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  write(path.join(f.repo, 'value'), 'new');
  verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  const failed = injectedCleanup(f, 'baseline', 'outer');
  assert.equal(failed.action, 'baseline');
  assert.ok(fs.existsSync(failed.receipt));
  assert.equal(verb(f.repo, 2, 'status', '--active').active, 1);
  verb(f.repo, 2, 'check', f.claim);
  verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  verb(f.repo, 2, 'status', '--active');
  verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  verb(f.repo, 0, 'status', '--active');
});

test('Windows live snapshot cwd cannot erase a failed proof receipt', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), flag = path.join(f.dir, 'launch-worker'), pids = path.join(f.dir, 'workers.jsonl');
  write(path.join(f.dir, 'worker.cjs'), 'setTimeout(() => process.exit(0), 8000);');
  write(path.join(f.dir, 'launch.cjs'), `const fs = require('node:fs');
if (fs.existsSync(${JSON.stringify(flag)})) {
  const child = require('node:child_process').spawn(process.execPath, [require('node:path').join(__dirname,'worker.cjs')], {detached:true,stdio:'ignore'});
  fs.appendFileSync(${JSON.stringify(pids)}, JSON.stringify({pid:child.pid,cwd:process.cwd()})+'\\n'); child.unref();
}`);
  write(f.claim, { ...f.spec, fixtures: ['probe.mjs', 'launch.cjs', 'worker.cjs'], setup: [['{node}', '{bundle}/launch.cjs']] });
  const workers = [];
  t.after(async () => {
    for (const worker of workers) {
      try { process.kill(worker.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      // Windows releases a killed process's snapshot cwd asynchronously.
      for (let attempt = 0; attempt < 200; attempt++) {
        try { process.kill(worker.pid, 0); }
        catch (error) { if (error.code === 'ESRCH') break; throw error; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const temp = path.dirname(path.dirname(worker.cwd));
      assert.equal(path.dirname(temp), fs.realpathSync(os.tmpdir()));
      assert.ok(path.basename(temp).startsWith('verb-'));
      // Best-effort scratch removal: a still-locked tree must not fail the regression.
      for (let attempt = 0; attempt < 40; attempt++) {
        try { fs.rmSync(temp, { recursive: true, force: true }); break; }
        catch (error) { if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE'].includes(error.code)) throw error;
          await new Promise(resolve => setTimeout(resolve, 250)); }
      }
    }
  });
  verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  write(path.join(f.repo, 'value'), 'new');
  verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  write(flag, 'yes');
  const failed = verb(f.repo, 2, 'prove', f.claim, '--base', 'HEAD');
  workers.push(...fs.readFileSync(pids, 'utf8').trim().split('\n').map(line => JSON.parse(line)));
  assert.equal(failed.action, 'prove');
  assert.ok(fs.existsSync(failed.receipt));
  assert.ok(failed.cleanupErrors.some(error => /EBUSY|EPERM|ENOTEMPTY/.test(error.message)));
  assert.equal(verb(f.repo, 2, 'status').receipt, failed.receipt);
  verb(f.repo, 2, 'status', '--active');
  assert.equal(hook(f.repo, '--stop').status, 2);
});

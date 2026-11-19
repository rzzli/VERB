import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { runSide } from '../lib/run.js';
import { scratch, clean } from './helpers.js';

function fixture(t) {
  const dir = scratch();
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, 'source'), 'old');
  t.after(() => clean(dir));
  const probe = [process.execPath, '-e', `console.log(JSON.stringify({
    origin: require('node:path').resolve('source'), observations: {value: 'old'}
  }))`];
  const spec = { probe, required: [], timeoutMs: 400,
    assertions: [{key: 'value', base: 'old', fixed: 'new'}] };
  return { dir, tree, spec };
}

test('timeout stops draining pipes held by a detached descendant after launcher exit', async t => {
  const { dir, tree, spec } = fixture(t);
  const workerDir = path.join(dir, 'worker-state');
  fs.mkdirSync(workerDir);
  const pidFile = path.join(workerDir, 'pid');
  const finishedFile = path.join(workerDir, 'finished');
  const worker = path.join(dir, 'worker.cjs');
  fs.writeFileSync(worker, `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    console.log('worker-started'); console.error('worker-stderr-started');
    setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(finishedFile)}, 'finished');
      console.log('worker-finished');
    }, 3000);
  `);
  const launcher = path.join(dir, 'launcher.cjs');
  fs.writeFileSync(launcher, `
    require('node:child_process').spawn(process.execPath, [${JSON.stringify(worker)}], {
      detached: true, stdio: 'inherit', cwd: ${JSON.stringify(workerDir)}
    });
    setTimeout(() => process.exit(0), 150);
  `);
  const side = { commands: [] };
  const started = Date.now();
  try {
    await runSide(side, { ...spec, setup: [[process.execPath, launcher]] },
      dir, tree, path.join(dir, 'profile'), 'base', false);
    assert.ok(Date.now() - started < 1500, JSON.stringify(side));
    assert.equal(side.verdict, 'inconclusive');
    assert.match(side.reason, /setup: command timed out/);
    assert.equal(side.commands.length, 1, 'probe must not run after setup timeout');
    assert.equal(side.commands[0].code, 0, 'launcher exited successfully before timeout');
    assert.match(side.commands[0].stdout, /worker-started/);
    assert.match(side.commands[0].stderr, /worker-stderr-started/);
    assert.ok(fs.existsSync(pidFile), 'finite worker actually started');
  } finally {
    // Process-tree termination is best-effort; clean only this test's recorded worker.
    if (fs.existsSync(pidFile) && !fs.existsSync(finishedFile)) {
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
});

test('active-root timeouts stay inconclusive and normal output is preserved', async t => {
  const { dir, tree, spec } = fixture(t);
  const timedOut = { commands: [] };
  await runSide(timedOut, { ...spec, setup: [[process.execPath, '-e', 'setTimeout(() => {}, 3000)']] },
    dir, tree, path.join(dir, 'timed-profile'), 'base', false);
  assert.equal(timedOut.verdict, 'inconclusive');
  assert.match(timedOut.reason, /setup: command timed out/);
  const normal = { commands: [] };
  await runSide(normal, { ...spec,
    setup: [[process.execPath, '-e', "console.log('complete stdout');console.error('complete stderr')"]] },
    dir, tree, path.join(dir, 'normal-profile'), 'base', false);
  assert.equal(normal.verdict, 'verified', JSON.stringify(normal));
  assert.equal(normal.commands.length, 2);
  assert.equal(normal.commands[0].stdout, 'complete stdout\n');
  assert.equal(normal.commands[0].stderr, 'complete stderr\n');
  assert.equal(normal.observations.value, 'old');
});

test('output overflow remains inconclusive and capped after pipe shutdown', async t => {
  const { dir, tree, spec } = fixture(t);
  const side = { commands: [] };
  await runSide(side, { ...spec, timeoutMs: 5000,
    setup: [[process.execPath, '-e', 'process.stdout.write(Buffer.alloc(5*1024*1024,120));setTimeout(()=>{},3000)']]
  }, dir, tree, path.join(dir, 'output-profile'), 'base', false);
  assert.equal(side.verdict, 'inconclusive');
  assert.match(side.reason, /output exceeded 4 MiB/);
  assert.equal(side.commands.length, 1);
  assert.ok(Buffer.byteLength(side.commands[0].stdout) <= 4 * 1024 * 1024);
});

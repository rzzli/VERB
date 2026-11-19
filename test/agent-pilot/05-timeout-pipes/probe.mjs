import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const origin = path.join(root, 'bin', 'verb.js');
const area = path.join(process.env.VERB_PROFILE, 'pipe-timeout-observation');
const repo = path.join(area, 'repository');
const workerDir = path.join(area, 'owned-worker');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(workerDir);
function execute(exe, args, cwd = repo) {
  const result = spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true,
    timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  return result;
}
function git(...args) {
  const result = execute('git', args);
  assert.equal(result.status, 0, result.stderr + result.stdout);
}
fs.writeFileSync(path.join(repo, 'app.cjs'), "module.exports = 'old';\n");
git('init', '-q');
git('config', 'user.email', 'timeout-trial@localhost');
git('config', 'user.name', 'Pipe timeout trial');
git('add', 'app.cjs');
git('commit', '-qm', 'Application for timeout verification');
fs.writeFileSync(path.join(area, 'inner-probe.cjs'),
  "const path = require('node:path'); const origin = path.resolve('app.cjs');\n" +
  "console.log(JSON.stringify({origin, observations:{value:require(origin)}}));\n");
fs.writeFileSync(path.join(area, 'worker.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.env.WORKER_DIR, 'pid.json'), JSON.stringify({pid:process.pid}));
console.log('worker-started');
setTimeout(() => {
  fs.writeFileSync(path.join(process.env.WORKER_DIR, 'finished'), 'finished');
  console.log('worker-finished');
}, 3000);
`);
fs.writeFileSync(path.join(area, 'launcher.cjs'), `
const path = require('node:path');
require('node:child_process').spawn(process.execPath, [path.join(__dirname, 'worker.cjs')], {
  detached: true, stdio: 'inherit', cwd: process.env.WORKER_DIR
});
setTimeout(() => process.exit(0), 150);
`);
const common = {
  claim: 'Read the application after setup',
  probe: ['{node}', '{bundle}/inner-probe.cjs'],
  fixtures: ['inner-probe.cjs', 'launcher.cjs', 'worker.cjs'],
  assertions: [{ key: 'value', base: 'old', fixed: 'new' }],
  required: [], timeoutMs: 400, env: { WORKER_DIR: workerDir }
};
function observe(name, setup) {
  const claim = path.join(area, name + '.json');
  fs.writeFileSync(claim, JSON.stringify({ ...common, setup }));
  const start = Date.now();
  const result = execute(process.execPath, [origin, 'baseline', claim, '--base', 'HEAD', '--json']);
  const elapsedMs = Date.now() - start;
  const receipt = JSON.parse(result.stdout);
  return { elapsedMs, code: result.status, receipt };
}

let detached;
try {
  detached = observe('detached', [['{node}', '{bundle}/launcher.cjs']]);
  assert.equal(detached.code, 2, JSON.stringify(detached));
  assert.match(detached.receipt.reason, /setup: command timed out/);
  assert.match(detached.receipt.sides.base.commands[0].stdout, /worker-started/);
  assert.ok(fs.existsSync(path.join(workerDir, 'pid.json')), 'Owned worker did not start');
} finally {
  // Only this probe's finite-lived child may need cleanup; never scan or kill by name.
  const pidFile = path.join(workerDir, 'pid.json');
  if (fs.existsSync(pidFile) && !fs.existsSync(path.join(workerDir, 'finished'))) {
    const { pid } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const active = observe('active-root', [['{node}', '-e', 'setTimeout(() => {}, 3000)']]);
assert.equal(active.code, 2, JSON.stringify(active));
assert.match(active.receipt.reason, /setup: command timed out/);
const normal = observe('normal', [['{node}', '-e', "console.log('setup-completed')"]]);
assert.equal(normal.code, 0, JSON.stringify(normal));
assert.equal(normal.receipt.sides.base.origin, 'app.cjs');
assert.equal(normal.receipt.sides.base.observations.value, 'old');
assert.match(normal.receipt.sides.base.commands[0].stdout, /setup-completed/);
console.error(JSON.stringify({ detachedElapsedMs: detached.elapsedMs, activeElapsedMs: active.elapsedMs,
  normalElapsedMs: normal.elapsedMs, configuredTimeoutMs: 400, boundedThresholdMs: 1500 }));
console.log(JSON.stringify({ origin, observations: {
  'detached pipe timeout': detached.elapsedMs < 1500 ? 'bounded' : 'waited for detached child',
  'active root timeout': active.receipt.verdict,
  'normal setup and probe': normal.receipt.verdict
} }));

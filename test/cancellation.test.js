import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { interrupt, runSide } from '../lib/run.js';
import { scratch, clean, fixture, project, verb, write } from './helpers.js';

const windows = process.platform === 'win32';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await pause(20);
  }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function stopRecorded(pidFile, finishedFile) {
  if (!fs.existsSync(pidFile) || (finishedFile && fs.existsSync(finishedFile))) return;
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'only terminate a recorded test worker PID');
  try { process.kill(pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  // Windows needs a short opportunity to release the worker's current directory.
  if (windows) await until(() => !alive(pid), 'recorded worker did not exit', 2000);
}
function unitFixture(t) {
  const dir = scratch(), tree = path.join(dir, 'tree');
  fs.mkdirSync(tree);
  write(path.join(tree, 'source'), 'old');
  t.after(() => clean(dir));
  const probe = [process.execPath, '-e', `console.log(JSON.stringify({
    origin: require('node:path').resolve('source'), observations: {value: 'old'}
  }))`];
  const spec = { probe, required: [], timeoutMs: 8000,
    assertions: [{ key: 'value', base: 'old', fixed: 'new' }] };
  return { dir, tree, spec };
}

// Markers live outside snapshots. Every detached worker is finite and only its recorded PID is cleaned.
function retainedWorker(dir, conditional = false) {
  const state = path.join(dir, 'worker state');
  fs.mkdirSync(state);
  const pid = path.join(state, 'worker.pid'), finished = path.join(state, 'finished');
  const launcherPid = path.join(state, 'launcher.pid'), exited = path.join(state, 'launcher-exited');
  const worker = path.join(dir, 'finite worker.cjs'), launcher = path.join(dir, 'launcher.cjs');
  write(worker, `const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid));
    console.log('worker stdout'); console.error('worker stderr');
    setTimeout(() => { fs.writeFileSync(${JSON.stringify(finished)}, 'done'); }, 4000);
  `);
  write(launcher, `const fs = require('node:fs');
    ${conditional ? "if (fs.readFileSync('value', 'utf8') === 'old') process.exit(0);" : ''}
    fs.writeFileSync(${JSON.stringify(launcherPid)}, String(process.pid));
    process.on('exit', () => fs.writeFileSync(${JSON.stringify(exited)}, 'exited'));
    require('node:child_process').spawn(process.execPath, [${JSON.stringify(worker)}], {
      detached: true, stdio: 'inherit', cwd: ${JSON.stringify(state)}
    });
    setTimeout(() => process.exit(0), 150);
  `);
  return { launcher, pid, finished, launcherPid, exited };
}

async function workerReady(worker) {
  await until(() => fs.existsSync(worker.pid) && fs.existsSync(worker.exited), 'launcher and finite worker did not start');
  // The marker is written by the launcher's exit handler, just before actual OS exit.
  await pause(150);
}
async function cleanWorker(worker) {
  await stopRecorded(worker.pid, worker.finished);
  await stopRecorded(worker.launcherPid, worker.exited);
}

test('interrupt tears down an exited launcher\'s pipes and is not sticky across runSide calls', async t => {
  const { dir, tree, spec } = unitFixture(t);
  const worker = retainedWorker(dir);
  const side = { commands: [] };
  const pending = runSide(side, { ...spec, setup: [[process.execPath, worker.launcher], spec.probe],
    required: [spec.probe] }, dir, tree, path.join(dir, 'cancelled profile'), 'base', true);
  try {
    await workerReady(worker);
    const started = Date.now();
    interrupt();
    interrupt(); // Repeated cancellation is safe while close is still queued.
    await pending;
    assert.ok(Date.now() - started < 2000, JSON.stringify(side));
    assert.equal(side.verdict, 'inconclusive');
    assert.match(side.reason, /setup: interrupted/);
    assert.equal(side.commands.length, 1, 'no subsequent setup, probe, or required command');
    assert.equal(side.commands[0].code, 0, 'launcher exited before interruption');
    assert.equal(side.commands[0].stdout, 'worker stdout\n');
    assert.equal(side.commands[0].stderr, 'worker stderr\n');
    assert.equal(fs.existsSync(worker.finished), false, 'do not wait for the escaped worker lifetime');
  } finally {
    interrupt();
    await pending;
    await cleanWorker(worker);
  }
  interrupt(); // An interrupt with no live sides must not poison any future test.
  const next = { commands: [] };
  await runSide(next, spec, dir, tree, path.join(dir, 'independent profile'), 'base', false);
  assert.equal(next.verdict, 'verified', JSON.stringify(next));
});

test('interruption between completed commands prevents the next phase', async t => {
  const { dir, tree, spec } = unitFixture(t);
  for (const phase of ['setup', 'probe', 'required']) {
    const commands = [];
    commands.push = function (command) {
      const length = Array.prototype.push.call(this, command);
      if (command.phase === phase) interrupt();
      return length;
    };
    const side = { commands };
    await runSide(side, { ...spec, setup: [spec.probe, spec.probe], required: [spec.probe, spec.probe] },
      dir, tree, path.join(dir, phase + ' boundary'), 'base', true);
    assert.equal(side.verdict, 'inconclusive', phase);
    assert.match(side.reason, /interrupted/);
    assert.deepEqual(commands.map(command => command.phase),
      phase === 'setup' ? ['setup'] : phase === 'probe' ? ['setup', 'setup', 'probe'] : ['setup', 'setup', 'probe', 'required']);
  }
});

test('an explicit AbortSignal cancels its lifetime without cancelling an unrelated side', async t => {
  const { dir, tree, spec } = unitFixture(t);
  const controller = new AbortController();
  controller.abort();
  const cancelled = { commands: [] };
  const profile = path.join(dir, 'never started');
  await runSide(cancelled, spec, dir, tree, profile, 'base', true, controller.signal);
  assert.equal(cancelled.verdict, 'inconclusive');
  assert.equal(cancelled.reason, 'interrupted');
  assert.equal(cancelled.commands.length, 0);
  assert.equal(fs.existsSync(profile), false, 'already interrupted lifetime cannot start setup');
  const next = { commands: [] };
  await runSide(next, spec, dir, tree, path.join(dir, 'fresh lifetime'), 'base', false);
  assert.equal(next.verdict, 'verified');
});

for (const phase of ['setup', 'probe', 'required']) {
  test(`AbortSignal stops an active ${phase} command and all later phases`, async t => {
    const { dir, tree, spec } = unitFixture(t);
    const pid = path.join(dir, 'active.pid');
    const long = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(pid)}, String(process.pid));
      setTimeout(() => {}, 4000);`];
    const controller = new AbortController();
    const side = { commands: [] };
    const config = { ...spec, setup: phase === 'setup' ? [long, spec.probe] : [],
      probe: phase === 'probe' ? long : spec.probe,
      required: phase === 'required' ? [long, spec.probe] : [spec.probe] };
    const pending = runSide(side, config, dir, tree, path.join(dir, 'profile'), 'base', true, controller.signal);
    try {
      await until(() => fs.existsSync(pid), 'active command did not start');
      controller.abort();
      await pending;
      assert.equal(side.verdict, 'inconclusive');
      assert.match(side.reason, new RegExp(phase + ': interrupted'));
      assert.deepEqual(side.commands.map(command => command.phase), phase === 'required' ? ['probe', 'required'] : [phase]);
      assert.equal(alive(Number(fs.readFileSync(pid, 'utf8'))), false, 'active launcher was terminated');
    } finally {
      controller.abort();
      await pending;
      await stopRecorded(pid);
    }
  });
}

async function cliCancellation(t, simulation) {
  const { dir, repo, claim, spec, probe } = fixture(t);
  const worker = retainedWorker(dir, true);
  const phases = path.join(dir, 'later phases');
  const mark = label => `require('node:fs').appendFileSync(${JSON.stringify(phases)},
    ${JSON.stringify(label + ':')} + require('node:fs').readFileSync('value', 'utf8') + '\\n');`;
  write(probe, `import fs from 'node:fs'; import path from 'node:path';
    const origin = path.resolve('value'), value = fs.readFileSync(origin, 'utf8');
    fs.appendFileSync(${JSON.stringify(phases)}, 'probe:' + value + '\\n');
    console.log(JSON.stringify({origin, observations: {value, neighbor: 'same'}}));`);
  spec.setup = [[process.execPath, worker.launcher], [process.execPath, '-e', mark('setup')]];
  spec.required = [[process.execPath, '-e', mark('required')]];
  spec.timeoutMs = 8000;
  write(claim, spec);
  verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  write(phases, '');
  write(path.join(repo, 'value'), 'new');
  const cli = path.join(project, 'bin/verb.js');
  const args = [cli, 'prove', claim, '--base', 'HEAD', '--json'];
  const trigger = path.join(dir, 'deliver handler');
  if (simulation) {
    t.diagnostic('Windows process.emit(SIGINT) tests the registered JS handler, NOT native console-control delivery.');
    const wrapper = path.join(dir, 'Windows handler simulation.mjs');
    write(wrapper, `import fs from 'node:fs';
      process.argv = [process.execPath, ...${JSON.stringify(args)}];
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(trigger)})) { clearInterval(timer); process.emit('SIGINT'); }
      }, 10);
      try { await import(${JSON.stringify(pathToFileURL(cli).href)}); } finally { clearInterval(timer); }
    `);
    args.splice(0, args.length, wrapper);
  }
  const child = spawn(process.execPath, args, { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', settled = false;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const outcome = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { settled = true; resolve({ code, signal }); });
  });
  const deadline = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 12000);
  try {
    await workerReady(worker);
    const started = Date.now();
    if (simulation) write(trigger, 'signal');
    else assert.equal(child.kill('SIGINT'), true, 'send a real OS SIGINT to the owned CLI PID');
    const result = await outcome;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `interruption took ${elapsed}ms; ${stdout} ${stderr}`);
    assert.equal(result.code, 2, stdout + stderr);
    assert.equal(result.signal, null);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.verdict, 'inconclusive');
    assert.match(receipt.reason, /interrupted/);
    assert.equal(receipt.sides.base.verdict, 'verified');
    assert.equal(receipt.sides.candidate.verdict, 'inconclusive');
    assert.deepEqual(receipt.sides.candidate.commands.map(command => command.phase), ['setup']);
    assert.equal(receipt.sides.candidate.commands[0].code, 0, 'launcher has already exited successfully');
    assert.match(receipt.sides.candidate.commands[0].error, /interrupted/);
    assert.deepEqual(fs.readFileSync(phases, 'utf8').trim().split('\n'), ['setup:old', 'probe:old']);
    assert.equal(fs.existsSync(worker.finished), false);
    assert.equal(JSON.parse(fs.readFileSync(receipt.receipt, 'utf8')).verdict, 'inconclusive', 'the CLI persists cancellation');
    verb(repo, 2, 'status');
    verb(repo, 2, 'status', '--active');
    t.diagnostic(`CLI settled ${elapsed}ms after ${simulation ? 'simulated handler' : 'OS SIGINT'} interruption.`);
  } finally {
    clearTimeout(deadline);
    if (!settled) child.kill('SIGKILL');
    await outcome;
    await cleanWorker(worker);
  }
}

test('full CLI: real POSIX SIGINT stops inherited pipes, persists inconclusive, and runs no later phase',
  { skip: windows && 'POSIX OS signal delivery only; see explicitly labeled Windows handler simulation' },
  t => cliCancellation(t, false));
test('full CLI: Windows SIGINT handler SIMULATION stops inherited pipes and persists inconclusive',
  { skip: !windows && 'Windows handler simulation only; POSIX uses real OS SIGINT' },
  t => cliCancellation(t, true));
test('native Windows console-control event delivery',
  { skip: 'UNVERIFIED: portable Node test runner has no native Windows console-control event sender' }, () => {});

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { inside } from './files.js';

const windows = process.platform === 'win32';
// Only live runSide lifetimes are registered; interrupt() never latches process-global state.
const active = new Set();

function killTree(child) {
  if (!child.pid) return;
  if (windows) {
    // taskkill cannot follow an exited launcher; do not target a possibly reused PID.
    if (child.exitCode !== null || child.signalCode !== null) return;
    const killed = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'],
      { windowsHide: true, timeout: 5000 });
    if (killed.status !== 0) child.kill('SIGKILL');
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

export function interrupt() {
  for (const cancel of active) cancel();
}

function execute(argv, cwd, env, timeoutMs, signal) {
  return new Promise(resolve => {
    const started = Date.now();
    let child;
    try {
      // Only this explicitly selected shell form takes command text, not ordinary argv.
      // cmd /s strips one outer quote pair; CRT-style backslash escaping corrupts its text.
      const cmdText = windows && /^cmd(?:\.exe)?$/i.test(path.win32.basename(argv[0])) &&
        argv.length === 5 && /^\/d$/i.test(argv[1]) && /^\/s$/i.test(argv[2]) && /^\/c$/i.test(argv[3]);
      const args = cmdText ? [...argv.slice(1, 4), '"' + argv[4] + '"'] : argv.slice(1);
      child = spawn(argv[0], args, {
        cwd, env, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: cmdText
      });
    } catch (err) {
      const hint = windows && /\.(cmd|bat)$/i.test(argv[0]) ? '; use cmd.exe /d /s /c or invoke the JavaScript CLI with {node}' : '';
      resolve({ argv, code: null, error: err.message + hint, ms: Date.now() - started, stdout: '', stderr: '' });
      return;
    }
    let error, stopped = false, size = 0;
    const output = { stdout: [], stderr: [] };
    function stop(reason) {
      if (stopped) return;
      stopped = true;
      error = reason;
      // Every stop path drops inherited pipes, even after the launcher has exited.
      child.stdout.destroy();
      child.stderr.destroy();
      try { killTree(child); }
      catch (err) { error += '; process cleanup: ' + err.message; }
    }
    const cancel = () => stop('interrupted');
    for (const stream of Object.keys(output)) {
      child[stream].on('data', chunk => {
        size += chunk.length;
        if (size <= 4 * 1024 * 1024) output[stream].push(chunk);
        else stop('command output exceeded 4 MiB');
      });
    }
    const timer = setTimeout(() => stop('command timed out'), timeoutMs);
    child.on('error', err => { error ??= err.message; });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      resolve({ argv, code, error: error || (exitSignal && 'signal ' + exitSignal), ms: Date.now() - started,
        stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString() });
    });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

// An optional signal spans multiple sides (e.g. one CLI invocation); otherwise each call is independent.
export async function runSide(side, spec, bundle, tree, profile, role, suites, signal) {
  const lifetime = new AbortController();
  const cancel = () => lifetime.abort();
  const check = () => { if (lifetime.signal.aborted) throw Error('interrupted'); };
  active.add(cancel);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    check();
    fs.mkdirSync(profile, { recursive: true });
    const tmp = path.join(profile, 'tmp');
    fs.mkdirSync(tmp);
    const vars = { root: tree, bundle, node: process.execPath,
      python: process.env.VERB_PYTHON || (windows ? 'python' : 'python3') };
    const expand = str => str.replace(/\{(root|bundle|node|python)\}/g, (_, key) => vars[key]);
    const env = { ...process.env, HOME: profile, USERPROFILE: profile, TMP: tmp, TEMP: tmp, TMPDIR: tmp,
      APPDATA: profile, LOCALAPPDATA: profile, XDG_CONFIG_HOME: profile, XDG_DATA_HOME: profile,
      XDG_CACHE_HOME: profile, XDG_STATE_HOME: profile, VERB_ROOT: tree, VERB_PROFILE: profile };
    // Node's private recursion marker makes nested `node --test` skip files with exit 0.
    // Commands are independent executions, not children of the caller's test harness.
    for (const key of Object.keys(env)) {
      if ((windows ? key.toUpperCase() : key) === 'NODE_TEST_CONTEXT') delete env[key];
    }
    for (const [key, val] of Object.entries(spec.env ?? {})) {
      // Node keeps only one case-insensitive spelling on Windows; remove inherited aliases.
      if (windows) {
        for (const existing of Object.keys(env)) {
          if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
        }
      }
      env[key] = expand(val);
    }
    const run = async (args, phase) => {
      check();
      const timeout = (phase === 'required' ? spec.requiredTimeoutMs : undefined) ?? spec.timeoutMs ?? 60000;
      const result = await execute(args.map(expand), tree, env, timeout, lifetime.signal);
      side.commands.push({ phase, ...result });
      if (result.error) throw Error(phase + ': ' + result.error);
      check();
      return result;
    };
    for (const args of spec.setup ?? []) {
      if ((await run(args, 'setup')).code !== 0) throw Error('setup command failed');
    }
    const probe = await run(spec.probe, 'probe');
    if (probe.code !== 0) throw Error('probe did not deliver a completed observation');
    const data = JSON.parse(probe.stdout);
    if (typeof data.origin !== 'string' || !path.isAbsolute(data.origin) ||
        !fs.existsSync(data.origin) || !fs.statSync(data.origin).isFile() ||
        !inside(fs.realpathSync(tree), fs.realpathSync(data.origin))) {
      throw Error('observed application origin is outside the checkout or missing');
    }
    side.origin = path.relative(tree, data.origin);
    side.observations = {};
    for (const { key } of spec.assertions) {
      if (!Object.hasOwn(data.observations ?? {}, key) || typeof data.observations[key] !== 'string') {
        throw Error('missing or invalid observation: ' + key);
      }
      Object.defineProperty(side.observations, key, { value: data.observations[key], enumerable: true });
    }
    const expected = role === 'base' ? 'base' : 'fixed';
    side.assertions = spec.assertions.map(a => ({ key: a.key, control: a.base === a.fixed,
      expected: a[expected], actual: side.observations[a.key], pass: side.observations[a.key] === a[expected] }));
    if (side.assertions.some(a => !a.pass)) {
      side.verdict = role === 'base' ? 'inconclusive' : 'failed';
      side.reason = role === 'base' ? 'baseline did not exhibit the specified symptom and controls' : 'behavioral assertion failed';
      return;
    }
    if (suites) {
      for (const args of spec.required) {
        if ((await run(args, 'required')).code !== 0) {
          side.verdict = 'failed';
          side.reason = 'required command failed';
          return;
        }
      }
    }
    check();
    side.verdict = 'verified';
  } catch (error) {
    side.verdict = 'inconclusive';
    side.reason = error.message;
  } finally {
    active.delete(cancel);
    signal?.removeEventListener('abort', cancel);
  }
}

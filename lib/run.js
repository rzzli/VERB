import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { inside } from './files.js';

const windows = process.platform === 'win32';
const active = new Set();

function killTree(child) {
  if (!child.pid) return;
  if (windows) {
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
  for (const child of active) killTree(child);
}

function execute(argv, cwd, env, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now();
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd, env, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      const hint = windows && /\.(cmd|bat)$/i.test(argv[0]) ? '; use cmd.exe /d /s /c or invoke the JavaScript CLI with {node}' : '';
      resolve({ argv, code: null, error: err.message + hint, ms: Date.now() - started, stdout: '', stderr: '' });
      return;
    }
    active.add(child);
    let error, size = 0;
    const output = { stdout: [], stderr: [] };
    function stop(reason) {
      if (error) return;
      error = reason;
      killTree(child);
      // Detached descendants may retain these pipes after the launcher has exited.
      child.stdout.destroy();
      child.stderr.destroy();
    }
    for (const stream of Object.keys(output)) {
      child[stream].on('data', chunk => {
        size += chunk.length;
        if (size <= 4 * 1024 * 1024) output[stream].push(chunk);
        else stop('command output exceeded 4 MiB');
      });
    }
    const timer = setTimeout(() => stop('command timed out'), timeoutMs);
    child.on('error', err => { error = err.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      active.delete(child);
      resolve({ argv, code, error: error || (signal && 'signal ' + signal), ms: Date.now() - started,
        stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString() });
    });
  });
}

export async function runSide(side, spec, bundle, tree, profile, role, suites) {
  fs.mkdirSync(profile, { recursive: true });
  const tmp = path.join(profile, 'tmp');
  fs.mkdirSync(tmp);
  const vars = { root: tree, bundle, node: process.execPath,
    python: process.env.VERB_PYTHON || (windows ? 'python' : 'python3') };
  const expand = str => str.replace(/\{(root|bundle|node|python)\}/g, (_, key) => vars[key]);
  const env = { ...process.env, HOME: profile, USERPROFILE: profile, TMP: tmp, TEMP: tmp, TMPDIR: tmp,
    APPDATA: profile, LOCALAPPDATA: profile, XDG_CONFIG_HOME: profile, XDG_DATA_HOME: profile,
    XDG_CACHE_HOME: profile, XDG_STATE_HOME: profile, VERB_ROOT: tree, VERB_PROFILE: profile };
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
    const timeout = (phase === 'required' ? spec.requiredTimeoutMs : undefined) ?? spec.timeoutMs ?? 60000;
    const result = await execute(args.map(expand), tree, env, timeout);
    side.commands.push({ phase, ...result });
    if (result.error) throw Error(phase + ': ' + result.error);
    return result;
  };
  try {
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
    side.verdict = 'verified';
  } catch (error) {
    side.verdict = 'inconclusive';
    side.reason = error.message;
  }
}

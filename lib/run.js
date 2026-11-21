import fs from 'node:fs';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { checkFrozenFixtures, inside, resolvedPath } from './files.js';

const windows = process.platform === 'win32';
// Repository-local environment from Git hooks (git rev-parse --local-env-vars),
// plus discovery and ref routing that could refer to the enclosing checkout.
const gitLocal = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_CEILING_DIRECTORIES'
]);
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

// Resolve a probe interpreter on the host. Searching with the snapshot as cwd
// would allow a local executable (or a claim's PATH override) to replace it.
function probeExecutable(file) {
  if (path.isAbsolute(file)) return file;
  if (file === 'node') return process.execPath;
  if (file !== path.basename(file) || (windows && /^[a-z]:/i.test(file))) {
    throw Error('Select an absolute path for the probe interpreter: ' + file);
  }
  const executable = windows && !path.extname(file) ? file + '.exe' : file;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)) {
    const candidate = path.join(dir, executable);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  throw Error('Probe interpreter was not found on the host PATH: ' + file);
}

function execute(argv, cwd, env, timeoutMs, signal, phase) {
  return new Promise(resolve => {
    const started = Date.now();
    let child;
    try {
      if (phase === 'probe') argv[0] = probeExecutable(argv[0]);
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
    let error, stopped = false, size = 0, launchFailed = false;
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
    child.on('error', err => {
      // No PID means the operating system never created the process: there is no
      // real exit status, unlike a timeout or interruption after a successful launch.
      if (!child.pid) launchFailed = true;
      error ??= err.message;
    });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      const stdout = Buffer.concat(output.stdout);
      if (phase === 'probe' && code === 0 && !error && !isUtf8(stdout)) {
        error = 'probe output is not valid UTF-8';
      }
      resolve({ argv, code: launchFailed ? null : code,
        error: error || (exitSignal && 'signal ' + exitSignal), ms: Date.now() - started,
        stdout: stdout.toString('utf8'), stderr: Buffer.concat(output.stderr).toString() });
    });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

// An optional signal spans multiple sides (e.g. one CLI invocation); otherwise each call is independent.
export async function runSide(side, spec, bundle, tree, profile, role, suites, signal, frozenFixtures) {
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
    // A declared fixture name is literal, even when it contains text such as
    // "{root}". Only expand the leading bundle reference for an exact match.
    const fixturePaths = new Map((spec.fixtures ?? []).map(name => ['{bundle}/' + name, path.join(bundle, name)]));
    const expand = str => fixturePaths.get(str) ?? str.replace(/\{(root|bundle|node|python)\}/g, (_, key) => vars[key]);
    const env = { ...process.env, HOME: profile, USERPROFILE: profile, TMP: tmp, TEMP: tmp, TMPDIR: tmp,
      APPDATA: profile, LOCALAPPDATA: profile, XDG_CONFIG_HOME: profile, XDG_DATA_HOME: profile,
      XDG_CACHE_HOME: profile, XDG_STATE_HOME: profile, VERB_ROOT: tree, VERB_PROFILE: profile };
    // Node's private recursion marker makes nested `node --test` skip files with exit 0.
    // Commands are independent executions, not children of the caller's test harness.
    for (const key of Object.keys(env)) {
      const name = windows ? key.toUpperCase() : key;
      if (name === 'NODE_TEST_CONTEXT' || gitLocal.has(name)) delete env[key];
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
    // Stop upward discovery before Git enters the directory containing this side.
    // Nested repositories created by project commands still have normal Git semantics.
    const ceilingKey = Object.keys(env).find(key => (windows ? key.toUpperCase() : key) === 'GIT_CEILING_DIRECTORIES');
    const boundary = path.dirname(tree);
    const ceilings = boundary.includes(path.delimiter) ? [] : [boundary];
    if (ceilingKey) {
      ceilings.push(env[ceilingKey]);
      delete env[ceilingKey];
    }
    if (ceilings.length) env.GIT_CEILING_DIRECTORIES = ceilings.join(path.delimiter);
    const run = async (args, phase) => {
      check();
      const timeout = (phase === 'required' ? spec.requiredTimeoutMs : undefined) ?? spec.timeoutMs ?? 60000;
      const result = await execute(args.map(expand), tree, env, timeout, lifetime.signal, phase);
      side.commands.push({ phase, ...result });
      if (result.error) throw Error(phase + ': ' + result.error);
      check();
      return result;
    };
    for (const args of spec.setup ?? []) {
      if ((await run(args, 'setup')).code !== 0) throw Error('setup command failed');
    }
    if (frozenFixtures) checkFrozenFixtures(bundle, frozenFixtures);
    const probe = await run(spec.probe, 'probe');
    if (probe.code !== 0) throw Error('probe did not deliver a completed observation');
    let data;
    try { data = JSON.parse(probe.stdout); }
    catch (error) { throw Error('probe output is not valid JSON: ' + error.message); }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw Error('probe output must be a JSON object with origin and observations');
    }
    if (typeof data.origin !== 'string' || !path.isAbsolute(data.origin)) {
      throw Error('probe output origin must be an absolute file path: ' + JSON.stringify(data.origin ?? null).slice(0, 200));
    }
    let originStat;
    try { originStat = fs.statSync(data.origin); }
    catch { throw Error('probe output origin is missing or not a file: ' + data.origin); }
    if (!originStat.isFile()) throw Error('probe output origin is missing or not a file: ' + data.origin);
    if (!inside(fs.realpathSync.native(tree), resolvedPath(data.origin))) {
      throw Error('probe output origin is outside the checkout: ' + data.origin);
    }
    if (data.observations === null || typeof data.observations !== 'object' || Array.isArray(data.observations)) {
      throw Error('probe output observations must be a JSON object mapping assertion keys to strings');
    }
    side.origin = path.relative(tree, data.origin);
    side.observations = {};
    for (const { key } of spec.assertions) {
      if (!Object.hasOwn(data.observations, key) || typeof data.observations[key] !== 'string') {
        throw Error('missing or invalid observation: ' + key);
      }
      Object.defineProperty(side.observations, key, { value: data.observations[key], enumerable: true });
    }
    const expected = role === 'base' ? 'base' : 'fixed';
    side.assertions = spec.assertions.map(a => ({ key: a.key, control: a.base === a.fixed,
      expected: a[expected], actual: side.observations[a.key], pass: side.observations[a.key] === a[expected],
      ...(a.wrongFix !== undefined && { wrongFix: a.wrongFix }) }));
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

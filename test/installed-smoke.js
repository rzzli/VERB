import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Standalone release gate: npm run test:installed. No source runtime imports, test
// recursion, registry downloads, global installs, or changes to global Git config.
const project = fileURLToPath(new URL('../', import.meta.url));
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
};

function npmCLI() {
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  throw Error('npm CLI not found; run this release gate with npm run test:installed.');
}

test('offline installed tarball discovers verb and runs the full public gate lifecycle', { timeout: 180000 }, t => {
  const npm = npmCLI();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verb installed smoke ')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  assert.equal(inside(project, dir), false, 'installation and target repository must be outside the source checkout');
  const consumer = path.join(dir, 'consumer'), repo = path.join(dir, 'target');
  const archives = path.join(dir, 'archives');
  for (const folder of [consumer, repo, archives]) fs.mkdirSync(folder);
  const userConfig = path.join(dir, 'user-config'), globalConfig = path.join(dir, 'global-config');
  for (const file of [userConfig, globalConfig]) fs.writeFileSync(file, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:GIT_|NPM_|NODE_PATH$|NODE_OPTIONS$|INIT_CWD$)/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig, GIT_ATTR_NOSYSTEM: '1',
    npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
    npm_config_cache: path.join(dir, 'npm-cache'), npm_config_offline: 'true',
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    npm_config_registry: 'http://127.0.0.1:9', NODE_PATH: '' });
  const run = (cwd, exe, args, options = {}) => {
    const result = spawnSync(exe, args, { cwd, env, encoding: 'utf8', windowsHide: true,
      timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options });
    assert.ifError(result.error);
    return result;
  };
  const expect = (result, code = 0) => {
    assert.equal(result.status, code, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  const npmRun = (cwd, ...args) => expect(run(cwd, process.execPath, [npm, ...args], { timeout: 60000 }));
  const pack = JSON.parse(npmRun(project, 'pack', '--json', '--offline', '--ignore-scripts', '--pack-destination', archives))[0];
  assert.equal(pack.filename, path.basename(pack.filename));
  const packed = new Set(pack.files.map(file => file.path));
  for (const name of ['bin/verb.js', 'lib/files.js', 'lib/staged.js', 'hooks/verify.mjs',
    'skills/verb-regression/SKILL.md', 'templates/claim.json', 'examples/node/claim.json',
    'examples/node/probe.mjs', 'examples/node/create-demo.mjs']) assert.ok(packed.has(name), 'missing package file: ' + name);
  assert.equal([...packed].some(name => /^(?:test|docs|\.git)\//.test(name)), false, 'development evidence is not shipped');
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'verb-local-smoke', private: true }));
  npmRun(consumer, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
    '--save=false', path.join(archives, pack.filename));
  const installed = path.join(consumer, 'node_modules', 'verb-runtime-verify');
  assert.ok(fs.lstatSync(installed).isDirectory());
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), false, 'tarball install must not link back to source');
  assert.equal(inside(project, fs.realpathSync(installed)), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'verb-runtime-verify');
  assert.deepEqual(manifest.dependencies ?? {}, {}, 'runtime must remain dependency-free');
  const installedCLI = path.join(installed, manifest.bin.verb);
  const installedHook = path.join(installed, 'hooks/verify.mjs');
  const bin = path.join(consumer, 'node_modules', '.bin');
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [bin, path.dirname(process.execPath), ...(env[pathKey] ?? '').split(path.delimiter)
    .filter(entry => entry && !inside(project, path.resolve(entry)))].join(path.delimiter);
  if (process.platform === 'win32') {
    const discoveries = expect(run(repo, 'where.exe', ['verb'])).split(/\r?\n/);
    assert.ok(discoveries.some(file => path.relative(path.join(bin, 'verb.cmd'), file) === ''));
    assert.ok(inside(bin, discoveries[0]), 'command discovery must prefer the installed shim');
    assert.ok(fs.readFileSync(path.join(bin, 'verb.cmd'), 'utf8').includes('verb-runtime-verify'));
  } else {
    assert.equal(expect(run(repo, '/bin/sh', ['-c', 'command -v verb'])), path.join(bin, 'verb'));
    assert.equal(fs.realpathSync(path.join(bin, 'verb')), fs.realpathSync(installedCLI));
  }
  const invoke = (...args) => {
    if (process.platform !== 'win32') return run(repo, 'verb', args);
    // npm installs a .cmd shim on Windows. Explicit cmd is necessary; the command
    // name is PATH-discovered and all arguments here are controlled fixture paths.
    assert.ok(args.every(arg => !/["\r\n%]/.test(arg)));
    const command = 'verb ' + args.map(arg => '"' + arg + '"').join(' ');
    return run(repo, process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { windowsVerbatimArguments: true });
  };
  const verb = (code, ...args) => JSON.parse(expect(invoke(...args, '--json'), code));
  const hook = (code, ...args) => expect(run(repo, process.execPath, [installedHook, ...args]), code);
  const git = (...args) => expect(run(repo, 'git', args));
  assert.match(expect(invoke('--help')), /VERB/);
  git('init', '-q');
  git('config', 'user.email', 'installed@localhost');
  git('config', 'user.name', 'Installed smoke');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.attributesFile', globalConfig);
  fs.writeFileSync(path.join(repo, 'value'), 'old');
  fs.writeFileSync(path.join(repo, 'neighbor'), 'same');
  fs.writeFileSync(path.join(repo, 'required.test.cjs'), `const test = require('node:test');
const assert = require('node:assert/strict');
test('installed required suite executes the real assertion', () => {
  assert.equal(require('node:fs').readFileSync('value','utf8'), 'new');
  console.log('INSTALLED_REQUIRED_TEST_RAN');
});\n`);
  git('add', '.'); git('commit', '-qm', 'broken');
  const base = git('rev-parse', 'HEAD');
  const claim = path.join(dir, 'claim.json');
  fs.writeFileSync(path.join(dir, 'probe.mjs'), `import fs from 'node:fs'; import path from 'node:path';
const origin = path.resolve('value');
console.log(JSON.stringify({origin, observations:{value:fs.readFileSync(origin,'utf8'),neighbor:fs.readFileSync('neighbor','utf8')}}));`);
  fs.writeFileSync(claim, JSON.stringify({ claim: 'installed package reads the fixed value',
    probe: ['{node}', '{bundle}/probe.mjs'], fixtures: ['probe.mjs'], timeoutMs: 5000,
    assertions: [{ key: 'value', base: 'old', fixed: 'new' }, { key: 'neighbor', base: 'same', fixed: 'same' }],
    required: [['{node}', '--test', 'required.test.cjs']] }));
  assert.equal(verb(0, 'status', '--active').active, 0);
  hook(0, '--stop'); hook(0, '--pre-commit');
  verb(0, 'baseline', claim, '--base', base);
  verb(1, 'check', claim);
  hook(2, '--stop'); hook(1, '--pre-commit');
  fs.writeFileSync(path.join(repo, 'value'), 'new');
  verb(0, 'check', claim);
  verb(2, 'status', '--active');
  hook(2, '--stop');
  const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
  const precommit = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(precommit, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(installedHook) + ' --pre-commit\n');
  fs.chmodSync(precommit, 0o755);
  git('add', '.');
  const blocked = run(repo, 'git', ['commit', '-qm', 'unproved must block']);
  expect(blocked, 1);
  assert.match(blocked.stderr, /VERB blocked/);
  assert.equal(git('rev-parse', 'HEAD'), base);
  const requiredRan = receipt => {
    const commands = receipt.sides.candidate.commands.filter(command => command.phase === 'required');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].code, 0);
    // Do not scrub NODE_TEST_CONTEXT in this harness: the runtime must prevent
    // inherited test-runner state from silently skipping a declared node --test.
    assert.match(commands[0].stdout, /INSTALLED_REQUIRED_TEST_RAN/, commands[0].stderr);
    assert.doesNotMatch(commands[0].stderr, /recursively|skipping running tests/i);
  };
  const proved = verb(0, 'prove', claim, '--base', base);
  requiredRan(proved);
  assert.equal(verb(0, 'status').receipt, proved.receipt);
  assert.equal(verb(0, 'status', '--active').active, 1);
  verb(0, 'status', proved.receipt);
  const summary = expect(invoke('summary', proved.receipt));
  assert.ok(summary.includes(proved.digest));
  assert.match(summary, /neighbor.*\[control\]/);
  assert.match(summary, /Required .*exit 0/);
  hook(0, '--stop'); hook(0, '--pre-commit');
  git('commit', '-qm', 'installed package proved fix');
  assert.equal(git('show', 'HEAD:value'), 'new');
  requiredRan(verb(0, 'prove', claim, '--base', base, '--candidate', 'HEAD'));
  verb(0, 'deactivate', claim);
  assert.equal(verb(0, 'status', '--active').active, 0);
  hook(0, '--stop');
  t.diagnostic(JSON.stringify({ node: process.version, platform: process.platform, npm: npmRun(consumer, '--version'),
    package: pack.name, version: pack.version, files: pack.entryCount, compressedBytes: pack.size,
    unpackedBytes: pack.unpackedSize, integrity: pack.integrity, offlineInstall: true, runtimeDependencies: 0,
    discovery: path.relative(consumer, process.platform === 'win32' ? path.join(bin, 'verb.cmd') : path.join(bin, 'verb')) }));
});

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const hash = data => createHash('sha256').update(data).digest('hex');
export const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));

export function saveJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = file + '.' + randomUUID();
  fs.writeFileSync(staging, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(staging, file);
}

export function git(cwd, args, env = process.env) {
  const proc = spawnSync('git', ['-C', cwd, ...args], {
    env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024
  });
  if (proc.error || proc.status !== 0) throw Error(proc.error?.message || proc.stderr.trim());
  return proc.stdout;
}

export function resolveRef(repo, ref) {
  return git(repo, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']).trim();
}

export function inside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function plainFile(root, relative) {
  const file = path.resolve(root, relative);
  if (!inside(root, file)) throw Error('Path escapes root: ' + relative);
  const expected = path.resolve(fs.realpathSync(root), relative);
  if (path.relative(expected, fs.realpathSync(file)) !== '' || !fs.lstatSync(file).isFile()) {
    throw Error('Expected a regular file inside the root: ' + relative);
  }
  return file;
}

// A working snapshot uses disk contents, including unstaged edits, new files and deletions.
export function working(repo, dest) {
  if (git(repo, ['ls-files', '--stage', '-z']).split('\0').some(line => line.startsWith('160000 '))) {
    throw Error('Working-tree submodules are unsupported');
  }
  const entries = git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0').filter(Boolean);
  const digest = createHash('sha256');
  for (const name of [...new Set(entries)].sort()) {
    const source = path.join(repo, name);
    if (name.endsWith('/')) throw Error('Nested repositories are unsupported: ' + name);
    let stat;
    try { stat = fs.lstatSync(source, { throwIfNoEntry: false }); }
    catch (error) {
      if (error.code === 'ENOTDIR') continue;
      throw error;
    }
    if (!stat || stat.isDirectory()) continue;
    const bytes = fs.readFileSync(plainFile(repo, name));
    digest.update(JSON.stringify([name, stat.mode & 0o111, hash(bytes)]));
    if (dest) {
      const file = path.join(dest, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { mode: stat.mode });
    }
  }
  return { kind: 'working', id: digest.digest('hex') };
}

export function checkout(repo, commit, dest, index) {
  const entries = git(repo, ['ls-tree', '-r', '-z', commit]).split('\0');
  if (entries.some(entry => /^(120000|160000) /.test(entry))) {
    throw Error('This revision contains symlinks or submodules; materialize a regular-file project for v1.');
  }
  const env = { ...process.env, GIT_INDEX_FILE: index };
  git(repo, ['read-tree', commit], env);
  git(repo, ['checkout-index', '--all', '--prefix=' + dest.replaceAll('\\', '/') + '/'], env);
  return { kind: 'commit', id: commit };
}

function command(value) {
  return Array.isArray(value) && value.length > 0 &&
    value.every(arg => typeof arg === 'string') && value[0].length > 0;
}

// Copy bytes, without inheriting source filesystem encryption or ACL metadata.
export function copyFixtures(names, source, dest) {
  for (const name of names) {
    const file = path.join(dest, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fs.readFileSync(plainFile(source, name)));
  }
}

export function freeze(claimPath, dest) {
  const root = path.dirname(claimPath);
  const contents = fs.readFileSync(claimPath);
  const spec = JSON.parse(contents.toString('utf8').replace(/^\uFEFF/, ''));
  if (typeof spec.claim !== 'string' || !spec.claim.trim() || !command(spec.probe) ||
      !Array.isArray(spec.fixtures) || !Array.isArray(spec.assertions) || !spec.assertions.length ||
      !Array.isArray(spec.required) || !spec.required.every(command) ||
      !Array.isArray(spec.setup ?? []) || !(spec.setup ?? []).every(command)) throw Error('Invalid claim, see templates/claim.json');
  if (spec.env !== undefined && (!spec.env || typeof spec.env !== 'object' || Array.isArray(spec.env) ||
      !Object.entries(spec.env).every(([k, v]) => /^[A-Za-z_][A-Za-z_0-9]*$/.test(k) && typeof v === 'string'))) {
    throw Error('env must be an object mapping environment variable names to strings');
  }
  if (!Number.isSafeInteger(spec.timeoutMs ?? 60000) || (spec.timeoutMs ?? 60000) < 1 ||
      (spec.timeoutMs ?? 60000) > 2147483647) throw Error('Invalid timeoutMs');
  const names = new Set();
  for (const assertion of spec.assertions) {
    if (typeof assertion.key !== 'string' || !assertion.key || names.has(assertion.key) ||
        typeof assertion.base !== 'string' || typeof assertion.fixed !== 'string') {
      throw Error('Each assertion needs a unique key and string base/fixed observations');
    }
    names.add(assertion.key);
  }
  if (!spec.assertions.some(a => a.base !== a.fixed)) throw Error('Specify a distinguishing observation');
  const digest = createHash('sha256').update(contents);
  if (!spec.fixtures.length || !spec.probe.slice(1).some(arg => spec.fixtures.some(f => arg === '{bundle}/' + f))) {
    throw Error('Pass the frozen probe script as a {bundle}/ fixture argument');
  }
  for (const name of [...new Set(spec.fixtures)].sort()) {
    if (typeof name !== 'string' || !name || name.includes('\\') ||
        name.split('/').some(part => !part || part === '..' || part === '.')) throw Error('Invalid fixture path');
    const bytes = fs.readFileSync(plainFile(root, name));
    digest.update(JSON.stringify([name, hash(bytes)]));
    const file = path.join(dest, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  return { spec, digest: digest.digest('hex') };
}

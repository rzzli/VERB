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

const within = (root, file) => path.relative(root, file) === '' || inside(root, file);

function linkTarget(root, file, target, allowAbsolute = false) {
  const parent = path.dirname(file);
  const abs = path.resolve(parent, target);
  const absolute = path.isAbsolute(target);
  if ((!absolute && /^[A-Za-z]:/.test(target)) || (!allowAbsolute && absolute) || !within(root, abs)) {
    throw Error('Symlink target is outside the snapshot: ' + path.relative(root, file));
  }
  return absolute ? path.relative(parent, abs) || '.' : target;
}

function internalLink(root, file, allowAbsolute = false, shared = []) {
  const target = linkTarget(root, file, fs.readlinkSync(file), allowAbsolute);
  let real;
  try { real = fs.realpathSync(file); }
  catch { throw Error('Symlink target is missing or cannot be resolved: ' + path.relative(root, file)); }
  if (!within(root, real) && !shared.some(source => within(source, real))) {
    throw Error('Symlink escapes the snapshot: ' + path.relative(root, file));
  }
  return { target, type: fs.statSync(real).isDirectory() ? 'dir' : 'file' };
}

// A working snapshot uses disk contents, including unstaged edits, new files and deletions.
export function working(repo, dest, names = []) {
  if (git(repo, ['ls-files', '--stage', '-z']).split('\0').some(line => line.startsWith('160000 '))) {
    throw Error('Working-tree submodules are unsupported');
  }
  const entries = git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0').filter(Boolean);
  const digest = createHash('sha256');
  const links = [];
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
    if (stat.isSymbolicLink()) {
      const parent = path.dirname(source);
      if (path.relative(parent, fs.realpathSync(parent)) !== '') throw Error('Symlink parent is not a plain directory: ' + name);
      const { target, type } = internalLink(repo, source, true);
      digest.update(JSON.stringify([name, 'link', target]));
      if (dest) links.push({ file: path.join(dest, name), target, type });
      continue;
    }
    const bytes = fs.readFileSync(plainFile(repo, name));
    digest.update(JSON.stringify([name, stat.mode & 0o111, hash(bytes)]));
    if (dest) {
      const file = path.join(dest, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { mode: stat.mode });
    }
  }
  for (const { file, target, type } of links) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(target, file, type);
  }
  if (dest) linkDirectories(repo, dest, names);
  const shared = names.map(name => path.join(repo, name));
  for (const { file } of links) internalLink(dest, file, false, shared);
  return { kind: 'working', id: digest.digest('hex') };
}

export function checkout(repo, commit, dest, index, names = []) {
  const entries = git(repo, ['ls-tree', '-r', '-z', commit]).split('\0');
  if (entries.some(entry => entry.startsWith('160000 '))) throw Error('Commit submodules are unsupported');
  // Attribute lookup must use this revision's index/tree, not the candidate checkout.
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_WORK_TREE: dest };
  git(repo, ['read-tree', commit], env);
  git(repo, ['-c', 'core.symlinks=true', 'checkout-index', '--all', '--prefix=' + dest.replaceAll('\\', '/') + '/'], env);
  const links = entries.filter(e => e.startsWith('120000 ')).map(entry => {
    const name = entry.slice(entry.indexOf('\t') + 1);
    const file = path.join(dest, name);
    const target = linkTarget(repo, path.join(repo, name), fs.readlinkSync(file), true);
    return { file, target };
  });
  for (const { file } of links) fs.unlinkSync(file);
  linkDirectories(repo, dest, names);
  const shared = names.map(name => path.join(repo, name));
  // Git cannot infer a Windows directory symlink's type when its target is absent.
  // Recreate links after dependencies, resolving chains from their targets outward.
  const pending = new Set(links);
  while (pending.size) {
    const before = pending.size;
    for (const link of pending) {
      const target = path.resolve(path.dirname(link.file), link.target);
      if (!fs.existsSync(target)) continue;
      fs.symlinkSync(link.target, link.file, fs.statSync(target).isDirectory() ? 'dir' : 'file');
      pending.delete(link);
    }
    if (pending.size === before) {
      throw Error('Symlink target is missing or cannot be resolved: ' + path.relative(dest, pending.values().next().value.file));
    }
  }
  for (const { file } of links) internalLink(dest, file, false, shared);
  return { kind: 'commit', id: commit };
}

export function linkDirectories(repo, tree, names) {
  for (const name of names) {
    const source = path.join(repo, name);
    const dest = path.join(tree, name);
    let ignored;
    try { ignored = git(repo, ['check-ignore', '--', name + '/']).trim(); } catch (error) {
      if (error.message) throw error;
    }
    if (!ignored || git(repo, ['ls-files', '-z', '--', ':(literal)' + name])) {
      throw Error('link requires an ignored, untracked directory: ' + name);
    }
    if (path.relative(source, fs.realpathSync(source)) !== '' || !fs.lstatSync(source).isDirectory()) {
      throw Error('link source must be a plain directory: ' + name);
    }
    let parent = tree;
    for (const part of name.split('/').slice(0, -1)) {
      parent = path.join(parent, part);
      const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
      if (!stat) fs.mkdirSync(parent);
      else if (!stat.isDirectory()) throw Error('link parent must be a plain directory: ' + name);
    }
    fs.symlinkSync(source, dest, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

function command(value) {
  return Array.isArray(value) && value.length > 0 &&
    value.every(arg => typeof arg === 'string') && value[0].length > 0;
}

function writeFixture(file, bytes, executable) {
  fs.writeFileSync(file, bytes);
  fs.chmodSync(file, (fs.statSync(file).mode & 0o666) | executable);
}

// Copy bytes and executable bits, without inheriting source encryption or ACL metadata.
export function copyFixtures(names, source, dest) {
  for (const name of names) {
    const file = path.join(dest, name);
    const input = plainFile(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFixture(file, fs.readFileSync(input), fs.statSync(input).mode & 0o111);
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
  const requiredTimeout = spec.requiredTimeoutMs ?? spec.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(requiredTimeout) || requiredTimeout < 1 || requiredTimeout > 2147483647) {
    throw Error('Invalid requiredTimeoutMs');
  }
  if (spec.link !== undefined && (!Array.isArray(spec.link) ||
      new Set(spec.link).size !== spec.link.length || !spec.link.every(name =>
        typeof name === 'string' && name.split('/').every(part => part && part !== '.' && part !== '..' &&
          part.toLowerCase() !== '.git' && !/[\\:*?\[\]]/.test(part))))) {
    throw Error('link must list unique repository-relative directory paths');
  }
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
    const input = plainFile(root, name);
    const bytes = fs.readFileSync(input);
    const executable = fs.statSync(input).mode & 0o111;
    digest.update(JSON.stringify([name, hash(bytes), executable]));
    if (dest) {
      const file = path.join(dest, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFixture(file, bytes, executable);
    }
  }
  return { spec, digest: digest.digest('hex') };
}

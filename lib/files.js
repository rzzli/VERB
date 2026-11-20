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
  const expected = path.resolve(fs.realpathSync.native(root), relative);
  if (path.relative(expected, fs.realpathSync.native(file)) !== '' || !fs.lstatSync(file).isFile()) {
    throw Error('Expected a regular file inside the root: ' + relative);
  }
  return file;
}

const within = (root, file) => path.relative(root, file) === '' || inside(root, file);

// Resolve links component by component before expanding DOS names. On Windows this
// also checks a relative link in a shared junction from its actual directory.
export function resolvedPath(file) {
  const resolved = fs.realpathSync(file);
  return process.platform === 'win32' ? fs.realpathSync.native(resolved) : resolved;
}

// Windows gives a directory both long and DOS names. Compare only the root prefix:
// the rest may be missing in the working tree or may itself be a versioned symlink.
export function windowsRootAlias(root, file) {
  if (process.platform !== 'win32' || !path.isAbsolute(file)) return;
  const absolute = path.resolve(file);
  if (within(root, absolute)) return;
  const volume = path.parse(absolute).root;
  if (path.relative(volume, path.parse(root).root) !== '') return;
  const depth = root.slice(volume.length).split(path.sep).length;
  const prefix = path.join(volume, ...absolute.slice(volume.length).split(path.sep).slice(0, depth));
  try {
    // The non-native call resolves redirects but preserves DOS spelling. A junction
    // outside the repository must not become an accepted spelling of the root.
    if (path.relative(prefix, fs.realpathSync(prefix)) === '' &&
        path.relative(root, fs.realpathSync.native(prefix)) === '') return prefix;
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
  }
}

export function linkTarget(root, file, target, allowAbsolute = false) {
  const parent = path.dirname(file);
  const absolute = path.isAbsolute(target);
  let abs = path.resolve(parent, target);
  const alias = absolute && allowAbsolute && windowsRootAlias(root, abs);
  if (alias) abs = path.join(root, path.relative(alias, abs));
  if ((!absolute && /^[A-Za-z]:/.test(target)) || (!allowAbsolute && absolute) || !within(root, abs)) {
    throw Error('Symlink target is outside the snapshot: ' + path.relative(root, file));
  }
  return absolute ? path.relative(parent, abs) || '.' : target;
}

function internalLink(root, file, allowAbsolute = false, shared = []) {
  const target = linkTarget(root, file, fs.readlinkSync(file), allowAbsolute);
  let real;
  try { real = resolvedPath(file); }
  catch { throw Error('Symlink target is missing or cannot be resolved: ' + path.relative(root, file)); }
  if (!within(root, real) && !shared.some(source => within(source, real))) {
    throw Error('Symlink escapes the snapshot: ' + path.relative(root, file));
  }
  return { target, type: fs.statSync(real).isDirectory() ? 'dir' : 'file' };
}

// Both working and staged identities use the same ordered entry encoding.
export function hashSnapshotEntry(digest, name, mode, content) {
  digest.update(JSON.stringify([name, mode, mode === 'link' ? content : hash(content)]));
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
      if (path.relative(parent, fs.realpathSync.native(parent)) !== '') throw Error('Symlink parent is not a plain directory: ' + name);
      const { target, type } = internalLink(repo, source, true);
      hashSnapshotEntry(digest, name, 'link', target);
      if (dest) links.push({ file: path.join(dest, name), target, type });
      continue;
    }
    const bytes = fs.readFileSync(plainFile(repo, name));
    hashSnapshotEntry(digest, name, stat.mode & 0o111, bytes);
    if (dest) {
      const file = path.join(dest, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { mode: stat.mode });
      if (process.platform !== 'win32' && (stat.mode & 0o111)) {
        fs.chmodSync(file, (fs.statSync(file).mode & 0o666) | (stat.mode & 0o111));
      }
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
    if (path.relative(source, fs.realpathSync.native(source)) !== '' || !fs.lstatSync(source).isDirectory()) {
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
    value.every(arg => typeof arg === 'string' && !arg.includes('\0')) && value[0].length > 0;
}

function invalidClaim(field, message) {
  throw Object.assign(Error(field + ': ' + message), { code: 'claim_invalid', field });
}

function validateClaim(spec) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(spec)) invalidClaim('$', 'claim must be a JSON object');
  const fields = ['claim', 'probe', 'fixtures', 'assertions', 'required', 'setup', 'env', 'timeoutMs', 'requiredTimeoutMs', 'link'];
  for (const key of Object.keys(spec)) if (!fields.includes(key)) invalidClaim(key, 'unknown claim field');
  if (typeof spec.claim !== 'string' || !spec.claim.trim()) invalidClaim('claim', 'must be a nonempty string');
  if (!command(spec.probe)) invalidClaim('probe', 'must be a nonempty argv array of strings, with no NUL characters');
  for (const field of ['required', 'setup']) {
    if (field === 'setup' && spec[field] === undefined) continue;
    if (!Array.isArray(spec[field])) invalidClaim(field, 'must be an array of argv arrays (an empty array is allowed)');
    spec[field].forEach((argv, index) => { if (!command(argv)) invalidClaim(`${field}[${index}]`, 'must be a nonempty argv array of strings, with no NUL characters'); });
  }
  if (!Array.isArray(spec.fixtures) || !spec.fixtures.length) invalidClaim('fixtures', 'must be a nonempty array of fixture paths');
  spec.fixtures.forEach((name, index) => {
    if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') ||
        /^[A-Za-z]:/.test(name) || name.split('/').some(part => !part || part === '..' || part === '.')) {
      invalidClaim(`fixtures[${index}]`, 'must be a relative fixture path using forward slashes, without . or .. segments');
    }
  });
  if (!spec.probe.slice(1).some(arg => spec.fixtures.some(name => arg === '{bundle}/' + name))) {
    invalidClaim('probe', 'pass the frozen probe script as an exact {bundle}/ fixture argument');
  }
  if (spec.env !== undefined) {
    if (!object(spec.env)) invalidClaim('env', 'must be an object mapping environment variable names to strings');
    for (const [key, value] of Object.entries(spec.env)) {
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) {
        invalidClaim('env.' + key, 'must have a valid variable name and a string value without NUL characters');
      }
    }
  }
  for (const field of ['timeoutMs', 'requiredTimeoutMs']) {
    if (spec[field] !== undefined && (!Number.isSafeInteger(spec[field]) || spec[field] < 1 || spec[field] > 2147483647)) {
      invalidClaim(field, 'must be an integer from 1 to 2147483647');
    }
  }
  if (spec.link !== undefined && (!Array.isArray(spec.link) || new Set(spec.link).size !== spec.link.length ||
      !spec.link.every(name => typeof name === 'string' && !name.includes('\0') && name.split('/').every(part =>
        part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !/[\\:*?\[\]]/.test(part))))) {
    invalidClaim('link', 'must list unique repository-relative directory paths');
  }
  if (!Array.isArray(spec.assertions) || !spec.assertions.length) invalidClaim('assertions', 'must be a nonempty array');
  const names = new Set();
  spec.assertions.forEach((assertion, index) => {
    const field = `assertions[${index}]`;
    if (!object(assertion)) invalidClaim(field, 'must be an object with key, base, and fixed');
    for (const key of Object.keys(assertion)) if (!['key', 'base', 'fixed'].includes(key)) invalidClaim(field + '.' + key, 'unknown assertion field');
    if (typeof assertion.key !== 'string' || !assertion.key || names.has(assertion.key)) invalidClaim(field + '.key', 'must be a unique nonempty string');
    for (const key of ['base', 'fixed']) if (typeof assertion[key] !== 'string') invalidClaim(field + '.' + key, 'must be a string observation');
    names.add(assertion.key);
  });
  if (!spec.assertions.some(a => a.base !== a.fixed)) invalidClaim('assertions', 'specify a distinguishing observation');
  const scope = { observations: spec.assertions.length, controls: spec.assertions.filter(a => a.base === a.fixed).length,
    requiredCommands: spec.required.length };
  const warnings = [];
  if (!scope.controls) warnings.push({ code: 'no_controls', message: 'No unchanged neighboring controls are declared; verification is limited to the distinguishing observations.' });
  if (!scope.requiredCommands) warnings.push({ code: 'no_required_commands', message: 'No required commands are declared; a passing proof does not claim project-test coverage.' });
  return { scope, warnings };
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
  let spec;
  try { spec = JSON.parse(contents.toString('utf8').replace(/^\uFEFF/, '')); }
  catch (error) { invalidClaim('$', 'claim is not valid JSON: ' + error.message); }
  const { scope, warnings } = validateClaim(spec);
  const digest = createHash('sha256').update(contents);
  for (const name of [...new Set(spec.fixtures)].sort()) {
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
  return { spec, digest: digest.digest('hex'), contents, scope, warnings };
}

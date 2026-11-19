import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { working, checkout } from '../lib/files.js';
import { fixture, write, verb } from './helpers.js';

function symlink(t, target, file, type = 'file') {
  try { fs.symlinkSync(target, file, type); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows symlink permission unavailable');
      return false;
    }
    throw error;
  }
  return true;
}

test('prove composes shared dependencies and internal aliases without modifying the shared source', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.repo, 'deps'));
  write(path.join(f.repo, 'deps', 'prefix'), '!');
  write(path.join(f.repo, '.gitignore'), '/deps/\n');
  if (!symlink(t, 'deps/prefix', path.join(f.repo, 'alias'))) return;
  f.git('config', 'core.symlinks', 'true');
  f.git('add', '.');
  f.git('commit', '-qm', 'dependency alias');
  write(f.probe, `import fs from 'node:fs'; import path from 'node:path';
const origin = path.resolve('value');
console.log(JSON.stringify({origin, observations:{value:fs.readFileSync(origin,'utf8')+fs.readFileSync('alias','utf8'),neighbor:'same'}}));`);
  write(f.claim, { ...f.spec, link: ['deps'], assertions: [
    { key: 'value', base: 'old!', fixed: 'new!' }, f.spec.assertions[1]
  ] });
  write(path.join(f.repo, 'value'), 'new');
  verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  assert.equal(fs.readFileSync(path.join(f.repo, 'deps', 'prefix'), 'utf8'), '!');
});

function snapshot(f, mode, names = []) {
  const dest = fs.mkdtempSync(path.join(f.dir, mode + '-'));
  if (mode === 'working') working(f.repo, dest, names);
  else checkout(f.repo, f.git('rev-parse', 'HEAD'), dest, dest + '.index', names);
  return dest;
}

for (const mode of ['working', 'commit']) {
  for (const name of ['deps', 'cache/deps']) {
    test(`${mode}: tracked symlinks resolve through shared ${name}`, t => {
      const f = fixture(t);
      const source = path.join(f.repo, name);
      fs.mkdirSync(source, { recursive: true });
      write(path.join(source, 'prefix'), 'shared:');
      write(path.join(f.repo, '.gitignore'), '/' + name + '/\n');
      if (!symlink(t, name + '/prefix', path.join(f.repo, 'alias'))) return;
      if (!symlink(t, name, path.join(f.repo, 'directory-alias'), 'dir')) return;
      if (!symlink(t, 'directory-alias', path.join(f.repo, 'aaa-directory-chain'), 'dir')) return;
      if (!symlink(t, 'aaa-directory-chain/prefix', path.join(f.repo, 'aaa-nested-chain'))) return;
      if (!symlink(t, 'alias', path.join(f.repo, 'chain'))) return;
      if (!symlink(t, path.join(source, 'prefix'), path.join(f.repo, 'absolute-alias'))) return;
      if (!symlink(t, source, path.join(f.repo, 'absolute-directory'), 'dir')) return;
      f.git('config', 'core.symlinks', 'true');
      f.git('add', '.');
      f.git('commit', '-qm', 'aliases into ignored dependencies');
      const dest = snapshot(f, mode, [name]);
      for (const alias of ['alias', 'chain', 'absolute-alias', 'aaa-nested-chain']) {
        assert.ok(fs.lstatSync(path.join(dest, alias)).isSymbolicLink());
        assert.equal(fs.readFileSync(path.join(dest, alias), 'utf8'), 'shared:');
      }
      for (const alias of ['directory-alias', 'absolute-directory', 'aaa-directory-chain']) {
        assert.ok(fs.lstatSync(path.join(dest, alias)).isSymbolicLink());
        assert.equal(fs.readFileSync(path.join(dest, alias, 'prefix'), 'utf8'), 'shared:');
      }
      assert.equal(fs.realpathSync(path.join(dest, 'alias')), path.join(source, 'prefix'));
      assert.throws(() => snapshot(f, mode), /missing or cannot be resolved/);
    });
  }

  test(`${mode}: shared links do not permit external or dangling symlinks`, t => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.repo, 'deps'));
    write(path.join(f.repo, '.gitignore'), '/deps/\n');
    write(path.join(f.dir, 'outside'), 'outside');
    if (!symlink(t, '../outside', path.join(f.repo, 'escape'))) return;
    f.git('config', 'core.symlinks', 'true');
    f.git('add', '.');
    f.git('commit', '-qm', 'outside alias');
    assert.throws(() => snapshot(f, mode, ['deps']), /Symlink target is outside the snapshot/);
    fs.unlinkSync(path.join(f.repo, 'escape'));
    if (!symlink(t, 'deps/missing', path.join(f.repo, 'escape'))) return;
    f.git('add', '.');
    f.git('commit', '-qm', 'dangling alias');
    assert.throws(() => snapshot(f, mode, ['deps']), /missing or cannot be resolved/);
    fs.unlinkSync(path.join(f.repo, 'escape'));
    if (!symlink(t, '../../outside', path.join(f.repo, 'deps', 'indirect'))) return;
    if (!symlink(t, 'deps/indirect', path.join(f.repo, 'escape'))) return;
    f.git('add', '.');
    f.git('commit', '-qm', 'outside through declared dependency');
    assert.throws(() => snapshot(f, mode, ['deps']), /Symlink escapes the snapshot/);
    fs.unlinkSync(path.join(f.repo, 'deps', 'indirect'));
    if (!symlink(t, '../value', path.join(f.repo, 'deps', 'indirect'))) return;
    assert.throws(() => snapshot(f, mode, ['deps']), /Symlink escapes the snapshot/);
  });

  test(`${mode}: declared directories must exist, be ignored, and contain no tracked files`, t => {
    const f = fixture(t);
    write(path.join(f.repo, '.gitignore'), '/deps/\n');
    f.git('add', '.');
    f.git('commit', '-qm', 'ignore missing dependency');
    assert.throws(() => snapshot(f, mode, ['deps']), /ENOENT/);
    fs.mkdirSync(path.join(f.repo, 'deps'));
    write(path.join(f.repo, 'deps', 'tracked'), 'tracked');
    f.git('add', '-f', 'deps/tracked');
    f.git('commit', '-qm', 'tracked dependency');
    assert.throws(() => snapshot(f, mode, ['deps']), /ignored, untracked directory/);
    fs.mkdirSync(path.join(f.repo, 'not-ignored'));
    assert.throws(() => snapshot(f, mode, ['not-ignored']), /ignored, untracked directory/);
  });
}

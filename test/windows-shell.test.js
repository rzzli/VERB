import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, verb, write } from './helpers.js';

const windows = process.platform === 'win32';
const literal = ['', 'two words', '"quoted"', 'embedded"quote', 'C:\\path with spaces\\',
  'backslash\\"quote', '\\\\server\\share\\file', '& | < > ^ % ! ( )', 'x&echo injected',
  '$(echo injected);*?', 'trailing backslashes\\\\', 'equal=value with spaces'];

test('full proof: ordinary Node argv retains spaces, quotes, backslashes, and shell metacharacters', t => {
  const { repo, claim, spec, git } = fixture(t);
  const scripts = path.join(repo, 'directory with spaces');
  fs.mkdirSync(scripts);
  write(path.join(scripts, 'capture argv.cjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
  git('add', '.');
  git('commit', '-qm', 'literal argv helper');
  const args = ['{node}', '{root}/directory with spaces/capture argv.cjs', ...literal];
  spec.setup = [args];
  spec.required = [args];
  write(claim, spec);
  const baseline = verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
  assert.deepEqual(JSON.parse(baseline.sides.base.commands[0].stdout), literal);
  write(path.join(repo, 'value'), 'new');
  const proof = verb(repo, 0, 'prove', claim, '--base', 'HEAD');
  for (const side of Object.values(proof.sides)) {
    for (const command of side.commands.filter(command => command.phase !== 'probe')) {
      assert.equal(command.code, 0);
      assert.deepEqual(JSON.parse(command.stdout), literal);
      assert.deepEqual(command.argv.slice(2), literal, 'receipt records the original logical argv');
    }
  }
});

test('full proof: explicit cmd.exe /d /s /c handles quoted batch paths and arguments',
  { skip: !windows && 'Windows cmd.exe command-text encoding only' }, t => {
    const { repo, claim, spec, git } = fixture(t);
    const scripts = path.join(repo, 'directory with spaces');
    fs.mkdirSync(scripts);
    write(path.join(scripts, 'capture argv.cjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
    write(path.join(scripts, 'quoted helper.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0capture argv.cjs" %*\r\n`);
    git('add', '.');
    git('commit', '-qm', 'quoted shell helper');
    const text = '"{root}\\directory with spaces\\quoted helper.cmd" "argument with spaces" "ampersand&literal" "pipe|literal" "{root}\\directory with spaces"';
    // Bare/absolute names and case-insensitive switches all use the same deliberately narrow form.
    spec.required = [
      ['cmd.exe', '/d', '/s', '/c', text],
      [path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), '/D', '/S', '/C', 'call ' + text]
    ];
    spec.setup = [['cmd.exe', '/d', '/s', '/c', 'echo ordinary-shell-command']];
    write(claim, spec);
    const baseline = verb(repo, 0, 'baseline', claim, '--base', 'HEAD');
    assert.equal(baseline.sides.base.commands[0].stdout.trim(), 'ordinary-shell-command');
    write(path.join(repo, 'value'), 'new');
    const proof = verb(repo, 0, 'prove', claim, '--base', 'HEAD');
    const commands = proof.sides.candidate.commands.filter(command => command.phase === 'required');
    assert.equal(commands.length, 2);
    for (const command of commands) {
      assert.equal(command.code, 0, JSON.stringify(command));
      const actual = JSON.parse(command.stdout);
      assert.deepEqual(actual.slice(0, 3), ['argument with spaces', 'ampersand&literal', 'pipe|literal']);
      assert.ok(path.isAbsolute(actual[3]));
      assert.equal(path.basename(actual[3]), 'directory with spaces');
      assert.ok(command.argv[4].includes('"' + actual[3] + '"'), 'receipt retains unwrapped command text');
      assert.equal(command.stderr, '');
    }
  });

test('Windows batch files still require an explicit shell; no implicit shell fallback',
  { skip: !windows && 'Node Windows .cmd spawn restriction only' }, t => {
    const { repo, claim, spec, git } = fixture(t);
    write(path.join(repo, 'direct helper.cmd'), '@echo off\r\necho must-not-run\r\n');
    git('add', '.');
    git('commit', '-qm', 'direct batch helper');
    spec.setup = [['{root}/direct helper.cmd']];
    write(claim, spec);
    const result = verb(repo, 2, 'baseline', claim, '--base', 'HEAD');
    assert.equal(result.sides.base.commands.length, 1);
    assert.equal(result.sides.base.commands[0].code, null);
    assert.equal(result.sides.base.commands[0].stdout, '');
    assert.match(result.sides.base.commands[0].error, /cmd\.exe|EINVAL|ENOENT/);
  });

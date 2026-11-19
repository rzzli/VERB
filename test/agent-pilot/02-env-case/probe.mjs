import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') throw Error('This behavioral trial concerns Windows environment-name identity.');
const root = process.cwd();
const origin = path.join(root, 'bin', 'verb.js');
const area = path.join(process.env.VERB_PROFILE, 'env-case-observation');
const repo = path.join(area, 'repository');
fs.mkdirSync(repo, { recursive: true });

// A normal inherited PATH spelling makes the selected input independent of shell casing.
const env = { ...process.env };
const inheritedPath = process.env.PATH;
for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
env.PATH = inheritedPath;
const desiredPath = path.dirname(process.execPath) + path.delimiter + path.join(area, 'tools');
fs.mkdirSync(path.join(area, 'tools'));

function execute(exe, args, cwd = repo) {
  const result = spawnSync(exe, args, { cwd, env, encoding: 'utf8', windowsHide: true,
    timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  return result;
}
function git(...args) {
  const result = execute('git', args);
  assert.equal(result.status, 0, result.stderr + result.stdout);
}
fs.writeFileSync(path.join(repo, 'app.cjs'),
  "module.exports = () => process.env.PATH === process.env.VERB_EXPECTED_PATH ? 'honored' : 'ignored';\n");
git('init', '-q');
git('config', 'user.email', 'env-case-trial@localhost');
git('config', 'user.name', 'Environment case trial');
git('add', 'app.cjs');
git('commit', '-qm', 'Environment-reporting application');
fs.writeFileSync(path.join(area, 'inner-probe.cjs'),
  "const path = require('node:path'); const origin = path.resolve('app.cjs');\n" +
  "console.log(JSON.stringify({origin, observations:{override:require(origin)()}}));\n");

function observe(key) {
  const claim = path.join(area, key === 'path' ? 'lowercase.json' : 'uppercase.json');
  fs.writeFileSync(claim, JSON.stringify({
    claim: 'Observe whether the declared PATH value reaches the application',
    probe: ['{node}', '{bundle}/inner-probe.cjs'], fixtures: ['inner-probe.cjs'],
    env: { [key]: desiredPath, VERB_EXPECTED_PATH: desiredPath },
    assertions: [{ key: 'override', base: 'ignored', fixed: 'honored' }], required: []
  }));
  const result = execute(process.execPath, [origin, 'baseline', claim, '--base', 'HEAD', '--json']);
  assert.ok([0, 2].includes(result.status), result.stderr + result.stdout);
  const receipt = JSON.parse(result.stdout);
  const side = receipt.sides?.base;
  assert.equal(side?.origin, 'app.cjs', result.stdout);
  assert.equal(side.commands.length, 1, result.stdout);
  assert.equal(side.commands[0].code, 0, result.stdout);
  assert.ok(!side.commands[0].error, result.stdout);
  assert.ok(['ignored', 'honored'].includes(side.observations?.override), result.stdout);
  return side.observations.override;
}
console.log(JSON.stringify({ origin, observations: {
  'lowercase PATH override': observe('path'),
  'uppercase PATH override': observe('PATH')
} }));

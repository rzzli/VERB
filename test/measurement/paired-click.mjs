// node paired-click.mjs CLICK_CLONE AISLOP_CLI_JS NEW_OUTPUT
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trials, challengeSource } from '../blind-review/challenges.mjs';
import '../git-environment.mjs';

const args = process.argv.slice(2);
if (args.length !== 3 || !process.env.VERB_PYTHON) {
  throw Error('Supply a Click clone, the aisLOP CLI .js file, and a new output directory. Set VERB_PYTHON to the Python executable.');
}
const [source, scanner, output] = args.map(p => path.resolve(p));
const python = path.resolve(process.env.VERB_PYTHON);
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../../bin/verb.js');
fs.mkdirSync(output);
const scratch = path.join(output, 'scratch');
fs.mkdirSync(scratch);
const toolsEnv = { ...process.env, VERB_PYTHON: python, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
  PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', PYTHONNOUSERSITE: '1', PYTHONUTF8: '1' };
for (const key of Object.keys(toolsEnv)) {
  if (/^(PYTEST_ADDOPTS|PYTEST_PLUGINS|AISLOP_.*|RUFF_.*)$/i.test(key)) delete toolsEnv[key];
}
const scanEnv = {...toolsEnv, HOME: scratch, USERPROFILE: scratch, AISLOP_NO_HISTORY: '1',
  AISLOP_NO_UPDATE_NOTIFIER: '1', AISLOP_NO_TELEMETRY: '1'};
// Fix the diff policy before scoring any candidates. The scanner only performs local checks.
const scannerPolicy = {
  version: 1,
  ci: { failBelow: 70, failOnMissingTools: true, format: 'json' },
  security: { audit: false }, telemetry: { enabled: false }
};
const explanations = {
  empty: ['unset', 'Showing the empty default on every option also labels an option with no default.'],
  help: ['public_paragraphs_survive', 'Dropping all help that contains a form feed removes public paragraphs too.']
};

function run(cwd, exe, argv, env = toolsEnv) {
  const start = performance.now();
  const r = spawnSync(exe, argv, { cwd, env, encoding: 'utf8', windowsHide: true,
    timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  return { exit: r.status, error: r.error?.message ?? r.signal, stdout: r.stdout ?? '',
    stderr: r.stderr ?? '', ms: Math.round(performance.now() - start) };
}
function checked(cwd, exe, argv) {
  const r = run(cwd, exe, argv);
  assert.equal(r.exit, 0, r.error || r.stderr || r.stdout);
  return r.stdout.trim();
}
const git = (cwd, ...argv) => checked(cwd, 'git', argv);
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});

function nativeSuite(repo, evidence) {
  const env = { ...toolsEnv, PYTHONPATH: path.join(repo, 'src') };
  const loaded = run(repo, python, ['-c', 'import click; print(click.__file__)'], env);
  assert.equal(loaded.exit, 0, loaded.stderr);
  assert.equal(fs.realpathSync(loaded.stdout.trim()), fs.realpathSync(path.join(env.PYTHONPATH, 'click', '__init__.py')));
  const r = run(repo, python, ['-m', 'pytest', '-q', '--color=no'], env);
  fs.writeFileSync(path.join(evidence, 'pytest.txt'), r.stdout + r.stderr);
  const summary = r.stdout.trimEnd().split(/\r?\n/).at(-1) ?? '';
  const failedTests = [...r.stdout.matchAll(/^FAILED (\S+)/gm)].map(m => m[1]);
  const complete = /\b\d+ passed\b/.test(summary) && !/\b\d+ (errors?|deselected)\b/.test(summary);
  const status = complete && r.exit === 0 ? 'pass' : complete && r.exit === 1 && failedTests.length ? 'block' : 'incomplete';
  return {status, exit: r.exit, ms: r.ms, summary, failedTests};
}

function staticScan(repo, base, evidence) {
  const r = run(repo, process.execPath, [scanner, 'ci', '--changes', '--base', base], scanEnv);
  fs.writeFileSync(path.join(evidence, 'scan.json'), r.stdout);
  fs.writeFileSync(path.join(evidence, 'scan-stderr.txt'), r.error || r.stderr);
  const report = parseOutput(r.stdout);
  const engines = Object.fromEntries(Object.entries(report.engines ?? {}).map(([name, v]) =>
    [name, v.failed ? 'failed' : v.missingTools?.length ? 'missing ' + v.missingTools.join(', ')
      : v.skipped ? 'skipped' : 'ran']));
  const reasons = [];
  if (report.summary?.errors) reasons.push('error findings');
  if (report.scoreable && report.score < scannerPolicy.ci.failBelow) reasons.push('score below 70');
  const complete = report.cliVersion === '0.20.0' && report.scoreable && report.summary?.files > 0 &&
    ['format', 'lint', 'code-quality', 'ai-slop', 'security'].every(name => engines[name] === 'ran') &&
    !Object.values(engines).some(v => v === 'failed' || v.startsWith('missing '));
  const status = complete && r.exit === 0 && !reasons.length ? 'pass' :
    complete && r.exit === 1 && reasons.length ? 'block' : 'incomplete';
  return {status, exit: r.exit, ms: r.ms, score: report.score ?? null, filesForScore: report.summary?.files ?? 0,
    errors: report.summary?.errors ?? null, warnings: report.summary?.warnings ?? null, reasons, engines};
}

function parseOutput(stdout) {
  try { return JSON.parse(stdout); } catch { return {}; }
}

function strictProof(repo, claim, base, candidate, evidence) {
  const r = run(repo, process.execPath, [cli, 'prove', claim, '--base', base, '--candidate', candidate, '--strict', '--json']);
  fs.writeFileSync(path.join(evidence, 'proof.json'), r.stdout);
  const receipt = parseOutput(r.stdout);
  const side = receipt.sides?.candidate;
  const misses = (side?.assertions ?? []).filter(a => !a.pass).map(a => a.key);
  const required = (side?.commands ?? []).filter(c => c.phase === 'required');
  const sameComparison = receipt.strict === true && receipt.sides?.base?.id === base && side?.id === candidate;
  const status = sameComparison && receipt.verdict === 'verified' && r.exit === 0 &&
    required.length === 1 && required[0].code === 0 ? 'pass' :
    sameComparison && receipt.verdict === 'failed' && r.exit === 1 ? 'block' : 'incomplete';
  return {status, exit: r.exit, ms: r.ms, verdict: receipt.verdict ?? null, reason: receipt.reason ?? side?.reason ?? null,
    digest: receipt.digest ?? null, misses, requiredExecuted: required.length};
}

function combined(...components) {
  if (components.some(c => c.status === 'incomplete')) return 'incomplete';
  return components.some(c => c.status === 'block') ? 'block' : 'pass';
}

function makeClaim(trial) {
  const original = path.join(here, '../blind-review/cases', trial.id);
  const dir = path.join(output, trial.id);
  fs.mkdirSync(dir);
  const spec = JSON.parse(fs.readFileSync(path.join(original, 'claim.json'), 'utf8'));
  const [key, wrongFix] = explanations[trial.id];
  const control = spec.assertions.find(a => a.key === key);
  assert.equal(control.base, control.fixed);
  control.wrongFix = wrongFix;
  for (const file of spec.fixtures) fs.copyFileSync(path.join(original, file), path.join(dir, file));
  const claim = path.join(dir, 'claim.json');
  save(claim, spec);
  return claim;
}

// Verify exact scanner and formatter versions before collecting any outcomes.
const scannerTool = run(output, process.execPath, [scanner, '--version'], scanEnv);
assert.equal(scannerTool.exit, 0, scannerTool.stderr);
const scannerVersion = scannerTool.stdout.trim();
assert.equal(scannerVersion, '0.20.0');
const ruff = checked(output, 'ruff', ['--version']);
assert.equal(ruff, 'ruff 0.15.4');
const [pythonVersion, pytest, colorama] = checked(output, python, ['-c',
  'import sys, pytest, colorama; print(sys.version.split()[0], pytest.__version__, colorama.__version__)']).split(' ');
const result = {platform: process.platform, node: process.version, python: pythonVersion, pytest, colorama,
  git: git(output, '--version'), scanner: scannerVersion, ruff, scannerPolicy, rows: []};
const clickTrials = trials.filter(t => t.upstream === 'click');
const claims = new Map(clickTrials.map(trial => [trial.id, makeClaim(trial)]));
for (const trial of clickTrials) {
  const fix = git(source, 'rev-parse', trial.fix + '^{commit}');
  const base = git(source, 'rev-parse', fix + '^');
  for (const [index, challenge] of [null, ...trial.challenges].entries()) {
    const repo = path.join(output, trial.id, 'candidate-' + index);
    const evidence = path.join(output, trial.id, 'evidence-' + index);
    fs.mkdirSync(evidence);
    git(output, 'clone', '-q', '--no-checkout', '--local', source, repo);
    git(repo, 'checkout', '-q', '--detach', fix);
    if (challenge) {
      const file = path.join(repo, trial.source);
      fs.writeFileSync(file, challengeSource(fs.readFileSync(file, 'utf8'), challenge));
      git(repo, 'add', '--', trial.source);
      // The Git identity and date make each seeded candidate reproducible.
      const date = git(repo, 'show', '-s', '--format=%cI', fix);
      const commit = run(repo, 'git', ['-c', 'user.name=VERB pilot', '-c', 'user.email=pilot@example.invalid',
        'commit', '-qm', challenge[0]], {...toolsEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date});
      assert.equal(commit.exit, 0, commit.stderr);
    }
    const candidate = git(repo, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(repo, '.git/info/exclude'), '\n/.aislop/\n/.ruff.toml\n');
    fs.mkdirSync(path.join(repo, '.aislop'));
    save(path.join(repo, '.aislop/config.yml'), scannerPolicy); // JSON is valid YAML.
    // The newer Click revision enables Ruff's automatic fixes in pyproject.toml.
    // Keep its rules but prevent the scanner from changing the patch being measured.
    const pyproject = path.join(repo, 'pyproject.toml');
    const extendsRuff = fs.existsSync(pyproject) && fs.readFileSync(pyproject, 'utf8').includes('[tool.ruff]');
    fs.writeFileSync(path.join(repo, '.ruff.toml'), (extendsRuff ? 'extend = "pyproject.toml"\n' : '') + 'fix = false\n', {flag: 'wx'});
    const native = nativeSuite(repo, evidence);
    assert.equal(git(repo, 'diff', '--name-only', 'HEAD'), '', 'The native suite changed the candidate');
    const scan = staticScan(repo, base, evidence);
    assert.equal(git(repo, 'diff', '--name-only', 'HEAD'), '', 'The scanner changed the candidate');
    const proof = strictProof(repo, claims.get(trial.id), base, candidate, evidence);
    assert.equal(git(repo, 'diff', '--name-only', 'HEAD'), '', 'A tool changed a tracked candidate file');
    const row = {case: trial.id, variant: challenge?.[0] ?? 'genuine', base, candidate, tree: git(repo, 'rev-parse', 'HEAD^{tree}'),
      native, scan, proof, standard: combined(native, scan), withVerb: combined(native, scan, proof)};
    result.rows.push(row);
    console.log(trial.id, row.variant, 'suite:', native.status, 'scan:', scan.status, 'proof:', proof.status);
  }
}
save(path.join(output, 'results.json'), result);
if (result.rows.some(row => row.withVerb === 'incomplete')) process.exitCode = 2;

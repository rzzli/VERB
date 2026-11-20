// Reproducible resource budgets for VERB itself, separate from project tests.
// Reports wall time and peak RSS of the CLI process (Node included), content volume
// hashed/copied per snapshot, and retained .git/verb bytes. Not a microbenchmark:
// snapshot creation dominates, which is the point of the measurement.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import './git-environment.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(project, 'bin/verb.js');
const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verb-budget-')));
const remove = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.isBuffer(data) ? data : typeof data === 'string' ? data : JSON.stringify(data));
};

function git(repo, ...args) {
  const p = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 120000, windowsHide: true });
  if (p.status !== 0) throw Error('git ' + args.join(' ') + ': ' + p.stderr);
  return p.stdout.trim();
}

function bytes(root) {
  let total = 0, files = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) { const nested = bytes(file); total += nested.total; files += nested.files; }
    else if (entry.isFile()) { total += fs.statSync(file).size; files++; }
  }
  return { total, files };
}

const content = repo => {
  const names = [...new Set(git(repo, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))];
  let total = 0;
  for (const name of names) {
    try { total += fs.lstatSync(path.join(repo, name)).isFile() ? fs.statSync(path.join(repo, name)).size : 0; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { files: names.length, total };
};

// maxRSS of the CLI process, including the Node runtime, measured at exit.
function run(cwd, args, rssFile) {
  const wrapper = `
import fs from 'node:fs';
process.on('exit', () => { try { fs.writeFileSync(process.env.VERB_BENCH_RSS, String(process.resourceUsage().maxRSS)); } catch {} });
process.argv = [process.execPath, process.env.VERB_BENCH_CLI, ...JSON.parse(process.env.VERB_BENCH_ARGS)];
await import(process.env.VERB_BENCH_URL);`;
  const started = performance.now();
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', wrapper], {
    cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, VERB_BENCH_RSS: rssFile, VERB_BENCH_CLI: cli, VERB_BENCH_URL: pathToFileURL(cli).href,
      VERB_BENCH_ARGS: JSON.stringify([...args, '--json']) }
  });
  const wallMs = Math.round(performance.now() - started);
  if (p.error) throw p.error;
  const rssKb = Number(fs.readFileSync(rssFile, 'utf8'));
  const result = JSON.parse(p.stdout || p.stderr);
  if (p.status !== 0 || result.verdict !== 'verified') throw Error('verb ' + args[0] + ' failed: ' + (p.stdout || p.stderr));
  // The benchmark deletes the temporary checkout. Export only a checkout-relative
  // identity so a shared report does not contain an author's temporary directory.
  return { wallMs, rssKb, receipt: path.relative(cwd, result.receipt).split(path.sep).join('/') };
}

function profile(t, name, build) {
  const dir = t.dir, repo = path.join(dir, name);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'bench@localhost');
  git(repo, 'config', 'user.name', 'Benchmark');
  build(repo);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'broken');
  const claim = path.join(dir, name + '.json'), probe = path.join(dir, name + '-probe.mjs');
  write(probe, `import fs from 'node:fs'; import path from 'node:path';
const origin = path.resolve('src', 'app.txt');
console.log(JSON.stringify({origin, observations:{state:fs.readFileSync(origin,'utf8').trim(),sentinel:'same'}}));`);
  write(claim, { claim: name + ' behavior', probe: ['{node}', '{bundle}/' + name + '-probe.mjs'],
    fixtures: [name + '-probe.mjs'], assertions: [{ key: 'state', base: 'broken', fixed: 'fixed' }, { key: 'sentinel', base: 'same', fixed: 'same' }],
    required: [['{node}', '-e', 'process.exit(0)']] });
  return { repo, claim };
}

const largeAsset = 12 * 1024 * 1024;
const profiles = {
  small: repo => write(path.join(repo, 'src/app.txt'), 'broken\n'),
  many: repo => {
    write(path.join(repo, 'src/app.txt'), 'broken\n');
    for (let i = 0; i < 2000; i++) write(path.join(repo, 'src/module-' + i + '.txt'), 'line ' + i + '\n');
  },
  large: repo => {
    write(path.join(repo, 'src/app.txt'), 'broken\n');
    write(path.join(repo, 'assets/blob.bin'), Buffer.alloc(largeAsset, 7));
  }
};

const dir = scratch();
const out = { platform: process.platform, node: process.version, commit: git(project, 'rev-parse', 'HEAD'), profiles: {}, generated: new Date().toISOString() };
const t = { dir };
try {
  for (const [name, build] of Object.entries(profiles)) {
    const f = profile(t, name, build), rss = path.join(dir, name + '-rss');
    const before = content(f.repo);
    const baseline = run(f.repo, ['baseline', f.claim, '--base', 'HEAD'], rss);
    write(path.join(f.repo, 'src/app.txt'), 'fixed\n');
    const prove = run(f.repo, ['prove', f.claim, '--base', 'HEAD'], rss);
    const check = run(f.repo, ['check', f.claim], rss);
    const verbState = bytes(path.join(f.repo, '.git', 'verb'));
    const receipts = path.join(f.repo, path.dirname(prove.receipt));
    const retained = bytes(receipts);
    out.profiles[name] = {
      content: { files: before.files, bytes: before.total },
      runs: { baseline, prove, check },
      retained: { receipts: retained.files, receiptBytes: retained.total, verbStateBytes: verbState.total },
      // Two snapshots per prove, one per side, each hashed and written.
      approximateSnapshotBytes: Math.round(before.total * 2 * 2)
    };
    console.log(`${name}: ${before.files} files / ${before.total} bytes; prove ${prove.wallMs} ms, ${prove.rssKb} KiB RSS; ` +
      `retained ${retained.total} bytes in ${retained.files} receipts (state ${verbState.total} bytes)`);
  }

  // Verbose required-command output retention, measured rather than extrapolated.
  const f = profile(t, 'verbose', repo => write(path.join(repo, 'src/app.txt'), 'broken\n'));
  write(f.claim, { ...JSON.parse(fs.readFileSync(f.claim, 'utf8')), required: [['{node}', '-e',
    "process.stdout.write('x'.repeat(64 * 1024))"]] });
  const rss = path.join(dir, 'verbose-rss');
  run(f.repo, ['baseline', f.claim, '--base', 'HEAD'], rss);
  write(path.join(f.repo, 'src/app.txt'), 'fixed\n');
  const first = run(f.repo, ['prove', f.claim, '--base', 'HEAD'], rss);
  const firstReceipt = path.join(f.repo, first.receipt);
  const one = fs.statSync(firstReceipt).size;
  for (let i = 0; i < 9; i++) run(f.repo, ['prove', f.claim, '--base', 'HEAD'], rss);
  const receipts = path.dirname(firstReceipt);
  out.verbose = { bytesPerReceipt: one, retainedReceipts: fs.readdirSync(receipts).length,
    retainedBytes: bytes(receipts).total, documentedCap: '30 receipts per claim' };
  console.log(`verbose: ${one} bytes/receipt; ${out.verbose.retainedReceipts} receipts retain ${out.verbose.retainedBytes} bytes`);

  const target = process.argv.find(arg => arg.startsWith('--out='))?.slice(6);
  if (target) { fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true }); fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n'); }
  console.log(JSON.stringify(out, null, 2));
} finally {
  remove(dir);
}

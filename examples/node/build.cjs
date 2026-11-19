const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// This is this project's supported source-archive override, not a VERB-wide convention.
let version = process.env.GREETER_BUILD_VERSION;
if (version !== undefined && !version.trim()) {
  console.error('GREETER_BUILD_VERSION must be non-empty when supplied.');
  process.exit(2);
}
if (version === undefined) {
  const git = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: __dirname, encoding: 'utf8', windowsHide: true, timeout: 5000
  });
  if (git.error || git.status !== 0) {
    console.error('Cannot derive the Greeter build version: Git metadata is unavailable. ' +
      'For source archives or snapshots, set the supported GREETER_BUILD_VERSION override; do not copy or link .git.');
    console.error(git.error?.message || git.stderr.trim());
    process.exit(2);
  }
  version = 'git-' + git.stdout.trim();
}
const dist = path.join(__dirname, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'greeter.cjs'), path.join(dist, 'greeter.cjs'));
fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify({ version }) + '\n');
console.log('Built Greeter version ' + version);

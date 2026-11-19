// Offline initializer: create one NEW local repo, never modify an existing directory or Git config.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 3) {
  console.error('Usage: node create-demo.mjs NEW_DIRECTORY');
  process.exit(2);
}
const source = path.dirname(fileURLToPath(import.meta.url));
const destination = path.resolve(process.argv[2]);
if (fs.existsSync(destination)) {
  console.error('Refusing to overwrite an existing directory: ' + destination);
  process.exit(2);
}
// mkdir is exclusive so a raced existing directory is never overwritten either.
fs.mkdirSync(destination);
for (const name of ['greeter.cjs', 'build.cjs', 'greeter.test.cjs', 'probe.mjs', 'claim.json', 'patch.mjs']) {
  fs.copyFileSync(path.join(source, name), path.join(destination, name), fs.constants.COPYFILE_EXCL);
}
fs.writeFileSync(path.join(destination, '.gitignore'), '/dist/\n', { flag: 'wx' });
function git(...args) {
  const result = spawnSync('git', args, {
    cwd: destination, encoding: 'utf8', windowsHide: true, timeout: 10000
  });
  if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr || 'Git initialization failed');
}
git('init', '-q');
// All config is local to this newly created disposable repository.
git('config', 'user.name', 'VERB Node demo');
git('config', 'user.email', 'verb-demo@localhost');
git('config', 'core.autocrlf', 'false');
git('add', '.');
// Do not run inherited commit hooks or signing tools just to initialize a tutorial.
const hooks = path.join(destination, '.git', 'demo-empty-hooks');
fs.mkdirSync(hooks);
git('-c', 'core.hooksPath=' + hooks, '-c', 'commit.gpgSign=false',
  'commit', '-qm', 'Known-broken empty display name');
console.log('Created offline demo with a broken HEAD in ' + destination);
console.log('Next: enter that directory and run VERB baseline claim.json --base HEAD.');

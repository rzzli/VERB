#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/verb.js', import.meta.url));
const check = spawnSync(process.execPath, [cli, 'status', '--active', '--json'], { encoding: 'utf8', windowsHide: true });
if (check.status !== 0) {
  let reason = check.error?.message ?? 'Could not run VERB status.';
  try { reason = JSON.parse(check.stdout || check.stderr).reason ?? reason; } catch {}
  console.error('VERB blocked: ' + reason);
  process.exit(process.argv.includes('--stop') ? 2 : 1);
}

if (process.argv.includes('--pre-commit') && JSON.parse(check.stdout).active > 0) {
  // These index flags hide changes from git diff, so a working proof cannot approve them.
  const flags = spawnSync('git', ['ls-files', '-v', '-z'], { encoding: 'utf8', windowsHide: true });
  if (flags.status !== 0 || flags.stdout.split('\0').some(entry => /^[a-zS] /.test(entry))) {
    console.error('VERB blocked: clear assume-unchanged and skip-worktree flags before committing.');
    process.exit(1);
  }
  // Clean filters can make git diff empty while the staged bytes still contain the bug.
  const input = flags.stdout.split('\0').filter(Boolean).map(entry => entry.slice(2)).join('\0') + '\0';
  for (const cached of [[], ['--cached']]) {
    const attrs = spawnSync('git', ['check-attr', ...cached, '-z', '--stdin', 'filter'], { input, encoding: 'utf8', windowsHide: true });
    if (attrs.status !== 0 || attrs.stdout.split('\0').some((value, i) => i % 3 === 2 && !['unspecified', 'unset'].includes(value))) {
      console.error('VERB blocked: pre-commit does not support content-filtered files; prove the commit separately.');
      process.exit(1);
    }
  }
  // A proof is for the working tree, so do not use it to approve a partial commit.
  for (const args of [['diff', '--no-ext-diff', '--name-only', '-z', '--'],
    ['ls-files', '--others', '--exclude-standard', '-z']]) {
    const git = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
    if (git.status !== 0 || git.stdout) {
      console.error('VERB blocked: stage the verified tree before committing (no unstaged changes or untracked files).');
      process.exit(1);
    }
  }
}

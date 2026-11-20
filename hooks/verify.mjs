#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { git } from '../lib/files.js';
import { assertStagedCheckout } from '../lib/staged.js';

// Git may provide a relative temporary index. Preserve its meaning when status and
// the staged comparison change to the repository root; do not use the default index.
if (process.env.GIT_INDEX_FILE) process.env.GIT_INDEX_FILE = path.resolve(process.env.GIT_INDEX_FILE);

const cli = fileURLToPath(new URL('../bin/verb.js', import.meta.url));
const check = spawnSync(process.execPath, [cli, 'status', '--active', '--json'], { encoding: 'utf8', windowsHide: true });
if (check.status !== 0) {
  let reason = check.error?.message ?? 'Could not run VERB status.';
  try { reason = JSON.parse(check.stdout || check.stderr).reason ?? reason; } catch {}
  console.error('VERB blocked: ' + reason);
  process.exit(process.argv.includes('--stop') ? 2 : 1);
}

const status = JSON.parse(check.stdout);
if (process.argv.includes('--pre-commit') && status.active > 0) try {
  const repo = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const options = { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 };
  // These index flags hide changes from git diff, so a working proof cannot approve them.
  const flags = spawnSync('git', ['ls-files', '-v', '-z'], options);
  if (flags.status !== 0 || flags.stdout.split('\0').some(entry => /^[a-zS] /.test(entry))) {
    console.error('VERB blocked: clear assume-unchanged and skip-worktree flags before committing.');
    process.exit(1);
  }
  // Clean filters can make git diff empty while the staged bytes still contain the bug.
  const input = flags.stdout.split('\0').filter(Boolean).map(entry => entry.slice(2)).join('\0') + '\0';
  for (const cached of [[], ['--cached']]) {
    const attrs = spawnSync('git', ['check-attr', ...cached, '-z', '--stdin', 'filter'], { ...options, input });
    if (attrs.status !== 0 || attrs.stdout.split('\0').some((value, i) => i % 3 === 2 && !['unspecified', 'unset'].includes(value))) {
      console.error('VERB blocked: pre-commit does not support content-filtered files; prove the commit separately.');
      process.exit(1);
    }
  }
  // A proof is for the working tree, so do not use it to approve a partial commit.
  for (const args of [['diff', '--no-ext-diff', '--name-only', '-z', '--'],
    ['ls-files', '--others', '--exclude-standard', '-z']]) {
    const result = spawnSync('git', args, options);
    if (result.status !== 0 || result.stdout) {
      console.error('VERB blocked: stage the verified tree before committing (no unstaged changes or untracked files).');
      process.exit(1);
    }
  }
  assertStagedCheckout(repo, status.workingDigest);
} catch (error) {
  console.error('VERB blocked: ' + error.message);
  process.exit(1);
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkout, git, linkTarget } from './files.js';

// Compare the representation VERB would execute, not Git's normalized diff or blobs.
// Keep the caller's index (including Git's temporary partial-commit index) for write-tree;
// checkout uses its own absolute index and the staged tree's attributes.
export function assertStagedCheckout(repo) {
  repo = fs.realpathSync.native(repo);
  const tree = git(repo, ['write-tree']).trim();
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'verb-staged-')));
  try {
    const dest = path.join(temp, 'tree');
    fs.mkdirSync(dest);
    checkout(repo, tree, dest, path.join(temp, 'index'));
    const names = git(repo, ['ls-tree', '-r', '--name-only', '-z', tree]).split('\0').filter(Boolean);
    for (const name of names) {
      const source = path.join(repo, name), candidate = path.join(dest, name);
      const actual = fs.lstatSync(source), expected = fs.lstatSync(candidate);
      let same = false;
      if (actual.isFile() && expected.isFile()) {
        same = (actual.mode & 0o111) === (expected.mode & 0o111) &&
          fs.readFileSync(source).equals(fs.readFileSync(candidate));
      } else if (actual.isSymbolicLink() && expected.isSymbolicLink()) {
        const target = fs.readlinkSync(source);
        // Working snapshots rebase absolute internal links to relative targets too.
        const relative = linkTarget(repo, source, target, true);
        same = relative === fs.readlinkSync(candidate);
      }
      if (!same) throw Error('Staged checkout differs from the verified working tree: ' + JSON.stringify(name) +
        '. Use consistent checkout bytes and prove again, or prove the commit separately.');
    }
    return tree;
  } finally {
    // Cleanup failure is also fail-closed; never approve an incomplete comparison.
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

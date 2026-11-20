# VERB release-readiness review

The [follow-up audit](standalone-verification-audit.md#follow-up-fixes) records the fixes for the frozen observer, proof history, hook invocation, and lock recovery. The findings below describe the earlier working tree.

Reviewed the working tree based on `b965e40` on November 20, 2026, including the pending lock and recovery fixes. **Use a fresh `prove` for release decisions. Fix proof freshness before relying on the automatic hooks as a release gate.**

## Does it meet the goal?

Yes for a specific, useful job. A developer can reproduce a reported behavior at a broken revision, test a plausible neighboring case, and collect evidence that the proposed fix passes both the assertions and the project's declared commands. The agent helps design a discriminating check. Git, the local CLI and the project's own tools execute it. There is no model account, hosted verifier, language adapter, or agent-specific runtime requirement.

The boundary matters. The project must fit into source snapshots and expose observable behavior to a local process. A trusted probe reports where it loaded the application. An empty test suite can still exit zero. Claims with no control or no required commands produce scope warnings. The receipt supports the observations and commands it records. The offline demo and the historical pilot both show wrong fixes passing the main assertion and failing a neighboring control. [Demo](../examples/node/claim.json) · [Five historical changes](../test/measurement/README.md)

## Release findings and acceptance tests

| Priority | Finding | Work to close it |
| --- | --- | --- |
| **P1 · Incorrect approval after history rotation** | A contradiction invalidates a verified working tree. Once other runs evict its history, a single focused check can create a fresh history record and revive the old proof. The candidate's required suite never reruns. [History and proof eligibility](../lib/store.js) | Bind each retained proof to a durable history generation, or preserve its invalidation until that proof expires. Make the reproduction below a regression. Both status modes must stay inconclusive until a new successful proof. Cover fresh and upgraded stores. |
| **P1 · Mistyped hook silently skips staged verification** | On a proven checkout with an unstaged fix, the real `--pre-commit` mode blocked. The misspelling `--precommit` exited zero. The hook checks for flags independently, so a wiring mistake can bypass the staged comparison. [Hook entry point](../hooks/verify.mjs) | Validate exactly one supported mode before Git discovery. Test omitted, unknown, duplicate and mixed flags in source and installed-package runs. Only a valid pre-commit invocation can approve staged files. |
| **P2 · Damaged history can restore approval** | A retained history record containing JSON `null` was skipped. Replacing the newest contradiction record with it turned `status --active` green. The truthiness filter also skips `false`, `0` and `""`. [History reader](../lib/store.js) | Distinguish a file disappearing during rotation from a stored invalid value. Validate each present record before filtering. Exercise all four values and require exit 2 with the file path. |
| **P2 · Moving a checkout strands active claims** | Active slots and receipt references use absolute paths. After relocating a checkout and its repository-owned claim, a new baseline and proof still left the hook blocked on the old path. [Claim identity and active status](../bin/verb.js) | Store repository-owned paths relative to the target checkout, define migration for old slots, and keep external claims explicitly local. Test a move with spaces, an external claim and a second worktree. Require a fresh proof and exactly one active slot after migration. |
| **P2 · Users cannot install a named public release** | The public npm registry returned 404 for `verb-runtime-verify`. The GitHub releases query returned an empty list. The source and offline tarball work. Package metadata says 0.2.0, while CI tests branches without producing a downloadable versioned artifact. [Manifest](../package.json) · [CI](../.github/workflows/test.yml) | Choose one distribution channel. Build one tarball for a tagged commit, install and exercise those same bytes on Windows and Linux, record its checksum and publish that artifact with install instructions. From an empty project, install that exact version and reproduce the demo verdicts. |
| **P2 · Memory and status costs grow with workload** | Working snapshots read each regular file into a single buffer. Staged comparison can hold both copies of the largest file at once. Receipt publication enumerates the retained files across all claims under one lock. Automatic status enumerates and sorts receipts before matching. [Snapshots](../lib/files.js) · [Staged comparison](../lib/staged.js) · [Receipt store](../lib/store.js) | Benchmark a 256 MiB asset and checkouts with 1, 100 and 1,000 mostly retired claims. Measure peak memory, scratch space, and active-status latency separately. Stream file reads where needed, preserving existing digests and staged-byte comparisons. Use the measurements before introducing an index. |
| **P3 · Reproduction depends on the local toolchain** | The comparison inherits much of the caller's environment. Shared dependencies and interpreter versions can change without changing a working-tree digest. Windows and Linux have CI coverage. macOS and native Windows console interruption remain unverified. [Runner](../lib/run.js) · [Workflow](../.github/workflows/test.yml) | Record Node/Git versions and any explicitly selected interpreter identity in receipts without collecting the user's full environment. Test one changed-toolchain replay. Add a macOS installed-package run and a real Windows interrupt experiment before expanding platform support claims. |
| **P3 · First-time usability is unmeasured** | Prepared probes covered five changes across two repositories. No first-time developer took part. Neither machine wiring times nor the shorter README establish the 15-minute human target. [Measurement protocol](../test/measurement/README.md) | Give a new developer the README, an existing check and a bug report from a third project. Time setup, wiring and test authoring separately. Have them explain the failed control and receipt without coaching. Record the first point they needed help. |

### Reproduce the highest-priority history bug

Use the existing [freshness test fixture](../test/freshness.test.js), which lets the candidate probe report a changed observation without editing the working tree.

1. Prove working tree A, record its receipt, and make the fixture report a contradictory observation. Run `check` and confirm active status now exits 2.
2. Restore the observation. Add one untracked file to create tree B and run 31 focused checks on B. Delete the extra file to return to A.
3. Active status first reports expired history. Run one focused check on A. Active status now exits 0 and ordinary status selects the original receipt. **Expected** is exit 2 until a fresh `prove` executes the required commands.

## Lightweight in practice

The installed package contained 22 files, about 38 KiB compressed and 118 KiB unpacked, with zero runtime dependencies. The seven production JavaScript files cover the CLI, snapshot creation, command execution, state, history, staging and the optional hook. The main maintenance risk is deciding when cached evidence still approves a tree. Keep those rules in one place with tests at the CLI boundary.

One Windows resource run measured the following wall times. These timings include Node and Git startup. RSS covers the CLI process for the proof, excluding its children.

| Working tree | Focused check | Full proof | Peak CLI RSS during proof |
| --- | ---: | ---: | ---: |
| Small fixture | 204 ms | 428 ms | 41.1 MiB |
| 2,001 files | 1.31 s | 2.52 s | 50.0 MiB |
| Fixture with a 12 MiB asset | 217 ms | 487 ms | 53.7 MiB |

Eleven receipts in the verbose-output workload occupied 701,274 bytes. The earlier Linux CPython pilot sampled 126.5 MiB of process-tree RSS and 104.0 MiB of scratch space during a full proof of a 4,687-file checkout. These observations support quick focused edits on the tested projects and identify where to measure larger ones. [Resource harness](../test/resource-budget.mjs) · [CPython method and sampling limits](../test/measurement/README.md)

## Changes made during review

- Reduced the README to one cross-shell demo, the command table, installation and scope. The packaged guide carries advanced material. Project-local hook examples now resolve the installed package and can be shared across developer machines. The install smoke test runs the hook through a real Git commit. [README](../README.md) · [Guide](../GUIDE.md) · [Installed-package test](../test/installed-smoke.js)
- Removed personal workspace, interpreter and profile paths from the tracked pilot evidence. The 12 derived receipt files retain hashes of the originals. Historical observations, verdicts, timings and first patches were checked. Trial 04 pins a separate digest for its normalized fixtures and passed on Linux with both the historical and current verifier. Benchmark reports now use checkout-relative receipt references. Prior Git commits retain the original evidence. [Archive and replay details](../test/agent-pilot/README.md)
- Isolated the locale of the one Git diagnostic used for hook discovery. On POSIX a Git pathname with invalid UTF-8 now stops verification before decoding could drop or alias a file. Recovery commands were exercised from a subdirectory with shell punctuation in the claim name. [Git portability tests](../test/git-portability.test.js) · [Recovery tests](../test/hooks-recovery.test.js)

## Verification scope

Reviewed the production CLI, libraries and hook, CI and package contents, agent skill, templates, examples, tracked development harnesses and pilot evidence, along with the pending working-tree changes. Local operational receipts still carry absolute paths to identify what ran. The archive cleanup applies to the shared source tree. Ignored scratch outputs and earlier Git revisions were outside the cleanup.

The full suite ran on Windows with Node 22.23.5 and on Linux under WSL2 with Node 22.14.0. Windows passed 116 tests with 10 platform skips. Linux passed 117 with 9 skips. Both installed-package smoke tests passed. The failing history and hook scenarios above were exercised separately from that suite. The optional upstream Click suite was not rerun for this review.

# VERB v0.2.0 review and TODO

Reviewed 2026-11-18 at commit 8c879cf (v0.2.0), on Linux with Node 22.11, Git 2.34 and Python 3.11.

> Historical context: the verdict, defects, and original test results below describe that commit, not the current implementation. The checklist was subsequently implemented in the working tree. Its completion claims were challenged again on 2026-11-18; see [Aggressive re-verification](#aggressive-re-verification--2026-11-18) for current evidence and remaining limits.

## Goal this review holds VERB to

A lean tool, harness and hook that a coding agent runs to verify its own change, and that raises the quality of that verification. Every recommendation below is judged against that goal. Anything that makes VERB a test framework, a CI system or a sandbox is out of scope.

## Verdict

VERB is a sound, small prototype. The core loop works and the code is careful. It is not yet an agent harness: nothing makes an agent run it, the one command a hook would call gives a wrong answer, and it only fits projects that run straight from source. Those three gaps matter more than any new feature.

## What was run

| Check | Result |
| --- | --- |
| `npm test` | 4 of 4 pass |
| README quick start (`click` `c021f05` → `d3e3852`) | `VERIFIED`, exit 0 |
| `test/click-gate.js` | All gates gave their expected outcome |
| Speed on click | Focused check about 0.35 s, full proof about 1.2–1.4 s |
| Toy Node repo, built for this review | `baseline`, `check`, `prove` work; the defects below were reproduced on it |

Not tested: Windows, large repositories, and any project that needs a build step.

## What works

- The loop itself. One frozen probe has to show the symptom on the broken revision and the fix on the candidate, with a control case that must not change. This is the step agents skip when they report “fixed”.

- Three verdicts. A baseline that never showed the bug is inconclusive (exit 2), not passed. A candidate that still shows it is failed (exit 1).

- Frozen inputs. Editing the probe or claim after the baseline invalidates the baseline (bin/verb.js:111), so the test cannot be quietly weakened mid-fix.

- Clean snapshots. Each side runs in its own copy of the tree with its own HOME, temp and XDG directories (lib/run.js:65).

- Size. About 400 lines, no dependencies, one JSON claim format.

- Process handling. Timeouts kill the whole process tree, output is capped at 4 MiB, and writes are atomic.

## Defects

Each of these was reproduced unless marked otherwise.

| # | Defect | Where | Effect on the goal |
| --- | --- | --- | --- |
| D1 | `verb status` returns `VERIFIED`, exit 0, for a receipt whose own verdict is `failed`. It only compares the working-tree digest. It also ignores whether the receipt came from `prove` or `check`. | `bin/verb.js:72-80` | Blocks any hook. A gate built on `status` passes a failed fix. |
| D2 | One conflicting rerun makes that claim and revision inconclusive for good. History is never pruned and there is no reset. | `lib/verb.js:51-66` | A single transient blip stops the agent; its cheapest way out is to edit the probe, which is the behaviour freezing is meant to prevent. |
| D3 | Deleting `.git/verb/history` to clear D2 makes `check` fail with `ENOENT` until the baseline is rerun. | `bin/verb.js:57` | The only manual workaround for D2 breaks the next command. |
| D4 | The snapshot holds tracked and untracked-but-not-ignored files only. A project that needs `node_modules`, an in-repo venv or build output fails at baseline. | `lib/files.js:48` | VERB fits only projects that run from source. This is the largest limit on where it can be used. |
| D5 | Any symlink or submodule makes the run inconclusive, in both working-tree and commit mode. | `lib/files.js:37`, `lib/files.js:74` | Excludes many real repositories outright. |
| D6 | The probe can tell which side it is on, because the snapshot path contains `base` or `candidate`. A probe that never ran the app got `VERIFIED` on unfixed code. | `bin/verb.js:97` | The receipt guards against honest mistakes only. The path leak makes cheating trivial rather than deliberate. |
| D7 | Receipts and history grow without limit, one of each per run, with full command output. | `bin/verb.js:138` | Minor. Fifteen runs left 112 KB; a long agent session will leave far more. |
| D8 | One `timeoutMs` (default 60 s) covers setup, probe and required commands alike. | `lib/run.js:70` | A full test suite as a required command can time out and read as inconclusive. Not reproduced. |

## Gaps against the goal

- There is no hook. The repo ships a 12-line skill and nothing else. An agent that forgets, or chooses not to, runs nothing. The goal names a hook; today VERB is advisory.

- The skill does not say how to act on results. It does not map exit codes to next steps, and it assumes verb is on PATH.

- Receipts cannot leave the machine. They live in .git/verb, hold absolute paths, and are not something a reviewer can read from the pull request.

- Scope is bug fixes with a visible symptom. “A claim must contain an observation that differs between sides” (lib/files.js:119). New features fit (absent → present). Refactors, where nothing should change, are rejected.

- A probe is not a regression test. It costs about the same to write and does not join the suite, so the project pays twice unless the probe is kept and reused.

## Evidence and packaging

- The README’s “five historical fixes across two repositories” cannot be reproduced from the repo. The harness and results were removed in 8c879cf and gitignored. Only the one Click fix is checkable.

- All evidence is replay of known fixes with probes written in advance. There is no record of VERB catching a wrong fix during real agent work, which is the claim that matters.

- There is no licence file and no CI. The npm name verb appears to be taken already; check before publishing.

- Tests are four integration tests. They cover the main paths well and none of D1–D6.

## Todo list

Ordered so that each step makes the next one worth doing. Steps 1–3 are the minimum for VERB to meet its stated goal.

### Step 1 — Make the gate trustworthy

- [x] Fix D1: status returns verified only when the receipt’s verdict is verified, its action is prove, and the working tree matches. Add a test with a failed receipt.

- [x] Let status run with no receipt argument: find the newest prove receipt for the current working tree, and return inconclusive if there is none. This is the single call a hook needs.

- [x] Fix D6: name the snapshot directories with random ids instead of the role. Pass the role to nothing the probe can see.

### Step 2 — Stop flakiness from trapping the agent

- [x] Fix D3: treat a missing history directory as empty.

- [x] Fix D2: replace permanent poisoning with a rule the agent can satisfy, such as “the last three runs of this side agree”. State the rule in the inconclusive message.

- [x] Prune receipts and history to the most recent N per claim (D7).

### Step 3 — Ship the hook

- [x] Add a hook script of about 30 lines that calls the no-argument status from step 1 and blocks when a claim has a baseline but no fresh verified proof. With no active claim it does nothing, so it costs nothing on unrelated work.

- [x] Document two wirings: an agent stop hook, and a Git pre-commit hook. Keep both as copy-paste snippets, not an installer.

- [x] Extend the skill: what to do on exit 1 and exit 2, that editing the probe after the baseline needs a stated reason, and how to invoke verb when it is not on PATH.

### Step 4 — Widen what it can run on

- [x] Fix D4 with one claim field, for example "link": ["node_modules", ".venv"], that symlinks named ignored directories from the real checkout into both snapshots. Document that linked directories are shared, not snapshotted.

- [x] Document the setup pattern for projects that must build, with one worked example.

- [x] Fix D5: copy symlinks that point inside the repository as symlinks; keep rejecting ones that point outside and submodules.

- [x] Fix D8: allow a separate timeout for required commands.

### Step 5 — Make the result reviewable

- [x] Add a short text summary mode suited to pasting into a pull request: claim, both revisions, each observation, required commands and their exit codes. Use repository-relative paths.

- [x] Record the claim digest in that summary so a reviewer can confirm the probe in the repo is the one that ran.

### Step 6 — Earn the evidence

- [x] Restore the pilot harness under test/ so the README claim is reproducible, or cut the claim down to the Click fix.

- [x] Add CI that runs npm test on Linux and Windows.

- [x] Use VERB on the next five real agent bug fixes. **5/5 prospective self-hosted trials completed** with setup timing, immutable first patches, independent pre-execution agent reviews, and verified receipts. All first candidates passed; no extra review-missed defect was observed. See the [pilot log](agent-pilot.md) and [replayable evidence](../test/agent-pilot/README.md). This is one-repository evidence, not five external projects.

- [x] Add a licence and settle the package name. MIT; `verb-runtime-verify` on npm (registry returned 404 when checked again on 2026-11-18), with the `verb` executable unchanged. This is a selected name, not a reservation or a publication.

## Aggressive re-verification — 2026-11-18

Audited the existing uncommitted implementation without resetting it. The initial Windows suite passed **10/10**, but adversarial reproductions exposed gaps in already-checked items. Regression tests were run failing before their corresponding fixes, then passing afterward.

### Confirmed gaps closed in this pass

- **Gate freshness:** a new proof that stopped during its baseline had no candidate identity, so status and hooks silently accepted an older success. Receipts now retain the attempted working-tree identity even when the candidate never runs. Active proofs also bind to the specific saved baseline, so reactivation or rebaselining cannot reuse a previous activation's proof.
- **Role leakage:** random directory names were insufficient while the candidate could count a surviving baseline directory. Each side is removed before starting the next. The regression uses a probe that never reads the application; unchanged broken code now fails instead of verifying.
- **Flake recovery:** check-only runs and failures of an earlier required command could erase a later command's conflict. Each required command now carries its last three actual completed executions forward, even through more than 30 checks and receipt/history rotation. Incomplete executions do not advance recovery.
- **Hook identity and staged content:** Windows path casing split baseline/proof/deactivation identity; deleted claims and legacy case-alias slots also needed cleanup. Pre-commit additionally refuses index flags and content filters that can hide different staged behavior from `git diff`.
- **Snapshot composition:** symlinks into a declared ignored dependency directory failed because validation happened before linking it. Dependencies are now attached first; commit symlinks are reconstructed in dependency order, including Windows directory links. Undeclared escapes and dangling links still fail.
- **Review output:** absolute paths embedded in `--option=PATH` are now relative. Synchronous process-launch errors are recorded as attempted commands with an unavailable exit code, rather than incorrectly appearing unrun.

### Checklist evidence, item by item

The test links name the persistent regression coverage; all are included by `npm test`.

| Checklist item | Current evidence / qualification |
| --- | --- |
| 1 — D1, receipt verdict/action/tree | [Original integration tests](../test/verification.test.js) reject failed receipts, `check` receipts, commit-only candidates, and changed trees. [Adversarial tests](../test/adversarial.test.js) reject newer baseline-aborted attempts. |
| 1 — No-argument status | [Integration tests](../test/verification.test.js) cover no proof, newest matching proof, unrelated newer trees, and failed newest proofs; [adversarial tests](../test/adversarial.test.js) cover an attempt with no candidate. |
| 1 — D6, role-free snapshot names | [Integration tests](../test/verification.test.js) check random paths, private profiles/bundles, removed indexes, and parallel proofs. [Adversarial tests](../test/adversarial.test.js) prevent the sibling-directory false proof. This is not a sandbox against malicious probes. |
| 2 — D3, missing history | [Integration tests](../test/verification.test.js) delete history after a baseline and successfully run `check`. |
| 2 — D2, recoverable flakiness | [History tests](../test/history.test.js) cover baseline/candidate observation recovery, cached baselines, mixed check/prove runs, required-command conflicts, later-command early exits, and timeouts. |
| 2 — D7, retention | [History tests](../test/history.test.js) exercise 32 real mixed runs and more than 30 check-only records; both stores stay at 30 files per claim. [Integration tests](../test/verification.test.js) verify the cached baseline survives pruning its receipt. History for sufficiently old unrelated input identities still rotates out. |
| 3 — Active-claim hook | [Adversarial tests](../test/adversarial.test.js) cover multiple claims, failed rebaselines, new activation, aliases/deactivation, and the no-active fast path even on an unsupported tree. |
| 3 — Two hook wirings | [README snippets](../README.md#wire-a-hook) remain copy-paste configuration, not an installer. [Adversarial tests](../test/adversarial.test.js) execute an actual Git commit with the hook installed and exercise stop exit 2. A live Claude Code stop session was not exercised. |
| 3 — Agent skill | [Skill](../skills/verb-regression/SKILL.md) inspected for exits 0/1/2, frozen-probe rationale, off-PATH invocation, and required-command recovery via `prove`. |
| 4 — D4, shared ignored directories | [Snapshot tests](../test/snapshots.test.js) cover top-level/nested dependencies, both snapshot modes, CLI composition, and rejected missing/tracked/unignored directories. Shared source remains unchanged after proof cleanup. |
| 4 — Build example | [README build example](../README.md#projects-that-need-a-build) inspected; [integration test](../test/verification.test.js) builds each side from shared dependencies and proves the checkout itself has no generated output. |
| 4 — D5, symlinks | [Snapshot tests](../test/snapshots.test.js) cover relative/absolute file/directory links, chains, ignored dependencies, dangling targets, and direct/indirect escapes. [Integration tests](../test/verification.test.js) continue rejecting submodules in both modes. |
| 4 — D8, required timeout | [Integration tests](../test/verification.test.js) pass a 1500 ms required command with a 1200 ms setup/probe limit and 5000 ms required limit, then verify a 100 ms required limit is inconclusive. |
| 5 — PR summary | [Adversarial tests](../test/adversarial.test.js) check both identities, relative option paths, failed exit 7, successful exit 0, and commands not run. [Integration tests](../test/verification.test.js) check both observed values and the external claim's relative path. |
| 5 — Claim digest | Both summary tests assert the receipt digest is printed; frozen-input mutation is rejected by [integration tests](../test/verification.test.js). [README](../README.md#review-a-summary) now explains the composite digest and gives a recomputation command, which was executed successfully. |
| 6 — Reproducible historical evidence | At this initial audit, the [README](../README.md#what-works-today) claimed only the Click replay. All ten [Click release gates](../test/click-gate.js) gave their expected outcomes. The separate prospective pilot added later is recorded below, not backfilled into this audit. |
| 6 — Linux/Windows CI | [CI configuration](../.github/workflows/test.yml) invokes `npm test` on both platforms. Both suites were also run locally, as recorded below. Remote GitHub Actions runs were not inspected or triggered. |
| 6 — Five real agent fixes | **Initially 0/5; now 5/5 in the subsequent prospective pass.** The [pilot log](agent-pilot.md) still excludes this uninstrumented audit and historical replays. Five new product defects were frozen and proved before/after their first candidate fixes. |
| 6 — Licence/package | [MIT licence](../LICENSE) and [package metadata](../package.json) checked. Packing and offline installation succeeded, including the `verb` executable and inactive hook. The [registry](https://registry.npmjs.org/verb-runtime-verify) returned E404 for the selected name; publication rights/name reservation are not established. |

### Executed validation

| Check | Result |
| --- | --- |
| Windows `npm.cmd test`, Node 22.23.5, Git 2.53.0.windows.2 | **37 passed, 0 failed, 0 skipped**; about 24 seconds. Symlink tests actually executed. |
| Ubuntu under WSL `npm test`, native Linux Node 22.23.5, Git 2.53.0 | **34 passed, 0 failed, 3 skipped**; about 7 seconds. The three skips are explicitly Windows-only casing/deletion/batch-launch tests. |
| Windows Click release test, Python 3.11.15 | **10/10 expected gate outcomes**, including overbroad fix, broken required suite, and ambient import rejection. |
| `npm pack` and isolated offline install with lifecycle scripts disabled | **Passed**; 12 payload files including licence, CLI, hook, libraries, skill, example and template. Installed `verb --help` and inactive stop hook succeeded. |
| Documented digest recomputation command | **Passed** for the bundled Click claim. |
| `git diff --check` | **Passed**; Git emitted only existing LF/CRLF conversion warnings. |

The Linux runtime was a temporary official Node distribution with its [published SHA-256](https://nodejs.org/dist/v22.23.5/SHASUMS256.txt) checked; no system Node installation was changed. These are local validation results, not claims of remote CI success.

### Deliberate remaining limits

- The initial audit had no measured pilot results. The follow-up below closes that checkbox with a self-hosted sample only; no verified live Claude hook session or npm publication is claimed.
- Pre-commit conservatively rejects `assume-unchanged`, `skip-worktree`, and content-filtered files; sparse/LFS workflows need another verification route.
- Linked dependencies are shared and outside the digest. Workspace dependency links into the original checkout can load candidate source during the baseline; the [README](../README.md#projects-that-need-a-build) warns to install/build those inside each snapshot instead.
- Windows batch files require explicit `cmd.exe` or a direct Node CLI; commands do not silently acquire shell parsing. Summary observations and embedded scripts are literal, not a general private-data redactor.

## Prospective pilot completion — follow-up on 2026-11-18

Five genuinely new self-hosted defects were reproduced with frozen real-CLI probes before their fixes were authored:

1. Historical snapshots consulted candidate attributes: [root/nested attribute regression](../test/pilot-attributes.test.js).
2. Windows case variants silently defeated environment overrides: [Windows/POSIX environment regression](../test/environment.test.js).
3. Frozen fixtures dropped executable bits and failed to bind mode changes: [mode, read-only and restrictive-umask regressions](../test/fixture-modes.test.js).
4. Linux summaries interpreted Windows receipts using host paths: [drive, UNC and POSIX regressions](../test/portable-summary.test.js).
5. A timed-out command waited for a detached child's captured pipes: [timeout, successful-output and output-cap regressions](../test/timeout-pipes.test.js). Killing detached descendants remains best-effort, not sandbox containment.

All five **first** candidate proofs verified, after independent automated static review and before any revision of the candidates. Median measured claim/probe setup was **1.94 minutes** (8.17 summed minutes); discovery/shared harness work was not separately timed and is not included. **No additional defect missed by review was observed** in those first patches. This supports retaining a small verification loop, not expanding into a framework or claiming broad efficacy.

- Integrated `npm test`: **47 tests**; Windows **45 passed / 2 POSIX-only skips**, Linux **44 passed / 3 Windows-only skips**, zero failures.
- Immutable original-patch replay: **3/3 Windows and 4/4 Linux cases verified**, covering all five unique defects with matching original digests.
- Updated-verifier/integrated-source replay: the same **3/3 + 4/4** matrix verified, including execution of every required suite.
- Five fixes add **22 net runtime lines**, with **no new dependencies, public commands or claim fields**. Pilot artifacts remain development-only.
- Click release gates reran with **10/10 expected outcomes**. Final offline package smoke passed: **12 files / 19,206 packed bytes**, no pilot artifacts, runtime-byte equality, installed baseline/proof/active status, and inactive/active installed hooks.
- The [pilot log](agent-pilot.md) states the continuation decision and limits; the [evidence guide](../test/agent-pilot/README.md) links raw receipts, first patches, reviews, the archived baseline and offline replay; [results](../test/agent-pilot/results.json) records hashes, timing and validation outcomes.

Do not expand the feature set on this sample: all five fixes are in VERB, reviewers are agents rather than humans, and no incremental catches over review were demonstrated. Existing baselines need rerunning because executable fixture bits now participate in the digest.

## Decide later, only if step 6 supports it

- Control-only claims for refactors. Allow a claim where every observation is the same on both sides. Small change, and it widens VERB from bug fixes to “behaviour preserved”. Hold it until the bug-fix loop has proved its worth.

- Probe promotion. A way to turn a verified probe into a permanent regression test. Useful, but it pulls toward being a test framework.

## Leave out

Sandboxing, signed receipts, a plugin system, non-Git support, and richer assertion matching (regex, numeric ranges). Each adds weight without improving what the agent verifies; matching logic belongs in the probe.

# Prospective self-hosted pilot — 2026-11-18

These are five **new, genuine VERB defects fixed prospectively**, not injected application bugs or replays of historical known fixes. Small repositories inside the probes are inputs that expose VERB's existing defects. All five fixes are in one product; this is **not evidence from five unrelated projects**.

The pre-fix implementation was captured from the existing dirty working tree as commit `c48f6c2099f5ffe2fabcfa6412cf28998462c73b` in [baseline.bundle](baseline.bundle). The user's repository history was not changed. The bundle makes the original defects replayable after the fixes are integrated.

## Evidence

Each trial contains a frozen claim/probe, timestamped setup record, verified baseline receipt, immutable first patch and its SHA-256, independent static review recorded before execution, and first-candidate proof/summary. The reviews are by **independent automated agents, not humans**. All five first candidates passed; no extra defect missed by those reviewers was observed.

| Trial | Original execution | Receipt summary | Timing and review |
| --- | --- | --- | --- |
| Historical Git attributes | Windows | [01 summary](01-attributes/first-candidate.summary.txt) | [Trial](01-attributes/trial.json) · [Review](01-attributes/review.json) |
| Case-insensitive environment overrides | Windows | [02 summary](02-env-case/first-candidate.summary.txt) | [Trial](02-env-case/trial.json) · [Review](02-env-case/review.json) |
| Executable fixtures and mode binding | Linux | [03 summary](03-fixture-modes/first-candidate.summary.txt) | [Trial](03-fixture-modes/trial.json) · [Review](03-fixture-modes/review.json) |
| Receipt paths across operating systems | Linux | [04 summary](04-portable-summary/first-candidate.summary.txt) | [Trial](04-portable-summary/trial.json) · [Review](04-portable-summary/review.json) |
| Detached-descendant output-pipe timeout | Windows | [05 summary](05-timeout-pipes/first-candidate.summary.txt) | [Trial](05-timeout-pipes/trial.json) · [Review](05-timeout-pipes/review.json) |

The Windows receipt used in trial 04 is an actual verified tool receipt, not a hand-written success. Its native-path control is the original Linux trial 03 baseline receipt. Stored absolute paths describe the original runs; use the replay harness, not their old replay argv, on another machine.

## Replay offline

Requirements: Node 22+, Git, and a POSIX shell for the POSIX fixture trial. No npm install or network access is needed. Like VERB itself, this executes repository code and declared commands; it is not a sandbox.

From the repository root:

```sh
# Replay original first patches using the frozen pre-pilot verifier.
node test/agent-pilot/replay.mjs

# Use today's verifier against the integrated current source and regression tests.
node test/agent-pilot/replay.mjs --current --integrated

# One case, optionally retain a machine-readable validation report.
node test/agent-pilot/replay.mjs --case 01-attributes --output .pilot/replay.json
```

Windows runs trials 01, 02, 05. Linux runs 01, 03, 04, 05. Unsupported cases are explicitly skipped, not counted as passing. Both platforms together cover all five; macOS was not tested. The harness checks patch checksums, prospective event ordering, baseline identity, frozen-input digests (with the original verifier), verdicts, and actual required-command execution. Temporary clones are removed; original evidence is never rewritten.

The first two Windows captures include incidental CRLF checkout churn. Those original patches are preserved unchanged; only their substantive fixes were integrated. Later clones were configured before checkout to avoid that noise. [Attributes](.gitattributes) preserve artifact bytes across checkouts.

The fixture-mode fix changes the digest format to include executable bits. Consequently current-verifier replay produces new digests and existing user baselines need to be rerun; original-verifier replay still checks the exact recorded digests. This is not evidence tampering.

## Scope and decision

See the [pilot log](../../docs/agent-pilot.md) for cost, limitations, and the continuation decision, and [results.json](results.json) for derived metrics and subsequent replay results. The replay harness, bundled baseline, raw receipts, reviews and tests are development artifacts, **excluded from the published package**. Runtime additions remain dependency-free and add no public commands or claim fields.

# VERB pilot: five real agent bug fixes

**Completed: 5/5 prospective self-hosted trials on 2026-11-18 (America/Los_Angeles).** These are five newly identified defects in VERB itself, not five unrelated projects. They were not injected into the product and are not historical known-fix replays.

## Protocol

Use the next five real agent bug fixes, not replays of known patches. Before editing, timestamp the start of claim/probe work and stop timing when the broken revision verifies. Save the result from the agent's first proposed patch before changing it in response to VERB. Record whether VERB caught a defect missed by ordinary review; if no independent review happened, record `unknown` rather than assuming it would have missed the defect.

For this pass, every row has a successful frozen baseline **before implementation**, an immutable first patch, and a static review by a different automated agent **before the first candidate execution**. Candidate tests were first executed by the required command in the proof. No deliberately weak patches were submitted. The original pre-pilot verifier ran the trials; the updated verifier was subsequently tested separately. The user's Git history was not changed.

## Results

| Fix | Setup minutes | First candidate verdict | Did VERB catch something review missed? | Evidence |
| --- | ---: | --- | --- | --- |
| 1 — Historical snapshot used candidate Git attributes | 0.38 | **Verified (0)** | None observed; reviewer approved | [Summary](../test/agent-pilot/01-attributes/first-candidate.summary.txt) · [Review](../test/agent-pilot/01-attributes/review.json) · [Timing](../test/agent-pilot/01-attributes/trial.json) |
| 2 — Windows lowercase environment override was ignored | 1.96 | **Verified (0)** | None observed; reviewer approved | [Summary](../test/agent-pilot/02-env-case/first-candidate.summary.txt) · [Review](../test/agent-pilot/02-env-case/review.json) · [Timing](../test/agent-pilot/02-env-case/trial.json) |
| 3 — Frozen POSIX fixtures lost executable bits; mode changes did not invalidate baseline | 1.94 | **Verified (0)** | None observed; reviewer approved | [Summary](../test/agent-pilot/03-fixture-modes/first-candidate.summary.txt) · [Review](../test/agent-pilot/03-fixture-modes/review.json) · [Timing](../test/agent-pilot/03-fixture-modes/trial.json) |
| 4 — Linux summary misinterpreted stored Windows receipt paths | 2.23 | **Verified (0)** | None observed; reviewer approved | [Summary](../test/agent-pilot/04-portable-summary/first-candidate.summary.txt) · [Review](../test/agent-pilot/04-portable-summary/review.json) · [Timing](../test/agent-pilot/04-portable-summary/trial.json) |
| 5 — Timeout kept draining a detached descendant's pipes | 1.65 | **Verified (0)** | None observed; reviewer approved | [Summary](../test/agent-pilot/05-timeout-pipes/first-candidate.summary.txt) · [Review](../test/agent-pilot/05-timeout-pipes/review.json) · [Timing](../test/agent-pilot/05-timeout-pipes/trial.json) |

The row IDs are labels, not serial execution order; some work ran in parallel. Exact UTC timestamps, first-patch hashes, raw receipts and frozen inputs are retained. The [evidence guide](../test/agent-pilot/README.md), [baseline Git bundle](../test/agent-pilot/baseline.bundle), [replay harness](../test/agent-pilot/replay.mjs), and [machine-readable results](../test/agent-pilot/results.json) make the original first candidates independently replayable.

### Cost and marginal value

- Median measured claim/probe setup: **1.94 minutes**; sum across trials **8.17 minutes**, range **0.38–2.23**. These are wall-clock intervals including tool latency and scheduling, not human labor estimates. Parallel intervals overlap.
- Discovery, shared harness construction, implementation, independent review, and final integration/package validation are **not included** in those per-claim setup figures. Total shared discovery/harness work was not separately timed. The recorded seed capture precedes the first claim by **6.15 minutes**, and some preparation occurred before that capture. Do not interpret the median as end-to-end adoption cost.
- Original proof times were **29.49, 27.81, 8.14, 10.53, and 33.83 seconds** respectively, including each required full suite; these are small self-hosted repositories, not a general performance benchmark.
- **0/5 first patches were rejected; 0 additional defects missed by the independent static reviewers were observed.** The baseline probes exposed the existing bugs, but those findings are not counted again as review-missed defects in the proposed fixes. This result does not demonstrate superiority to ordinary review or tests. No human-review outcome is inferred.

## Aggressive follow-up validation

- Integrated suite: **47 tests** — Windows **45 passed / 2 POSIX-only skips**, Linux **44 passed / 3 Windows-only skips**, zero failures.
- Original first patches replayed from the archived bundle: **3/3 applicable Windows cases and 4/4 applicable Linux cases** verified, covering all five unique defects. The original recorded digests matched.
- The same matrix also verified the **integrated current source using the updated verifier**, with every declared required suite actually executed. Current digests differ intentionally because executable fixture bits are now part of the frozen inputs.
- Added boundary coverage after the first proofs: read-only executable fixtures under a restrictive POSIX umask, and output-cap behavior after pipe shutdown. First-candidate artifacts were not rewritten to include these later tests.
- Historical Click release gates reran with **10/10 expected outcomes** using an explicit existing Python executable; they remain separate historical evidence, not extra pilot rows.
- Final package: **12 files, 19,206 compressed bytes**, with no pilot/test artifacts. Offline installation with lifecycle scripts disabled passed. Installed runtime bytes matched source, and actual installed baseline/proof/active-status plus inactive/active hook checks passed.
- Snapshot tests cover root and nested Git attributes; environment tests preserve POSIX case sensitivity; summary tests cover drive, UNC, cross-volume and POSIX paths while leaving literal observations untouched. Timeout controls still classify active-root timeouts as inconclusive and preserve successful output.

## Keep the tool lightweight

The five fixes add **22 net runtime lines across three existing files**, **zero dependencies**, **zero public commands**, and **zero claim fields**. The archival bundle, recording artifacts and replay harness stay outside the package payload.

**Decision: continue the small bug-fix verification loop; do not expand its scope on this evidence.** Keep the general-purpose argv/probe interface and optional hooks. Do not add refactor claims, probe promotion, a test framework, sandboxing, signatures, plugins, or CI orchestration. A future adoption assessment should use independently selected fixes in unrelated projects and measure full setup cost and incremental catches. That is a limitation of these results, not an additional uncompleted row in this five-fix pilot.

### Limits and operational notes

- All fixes are self-hosted in one repository, with automated independent static review. There is no cross-project efficacy claim, live Claude stop-session validation, remote CI result, or npm publication.
- The timeout fix bounds pipe draining after a stop. Killing escaped/detached descendants remains best-effort, and Windows process-tree cleanup may add bounded overhead. This is not sandbox containment or hard real-time cancellation.
- Summary formatting handles fully qualified structured paths. Observations, embedded scripts and context-dependent Windows path spellings are not a general privacy scrubber.
- Discovery also observed lossy decoding of legacy non-UTF-8 Windows output. This was **not fixed or counted** in the five trials. Probes must emit UTF-8 JSON; native code-page auto-detection is unsupported. Five completed trials do not mean every possible compatibility issue is closed.
- Existing baselines must be rerun after the fixture-digest format change. Executable bits are now bound alongside names and bytes; source ACLs and read/write permissions are not copied as fixture identity.
- The first two Windows clones initially inherited CRLF checkout conversion. The captured first patches retain that incidental churn; only their semantic fixes were integrated. Later clones configured line endings before checkout. Original evidence was preserved rather than cosmetically rewritten.
- An exploratory Python-selector check unexpectedly invoked the Windows Python install-manager alias. Its output reported an update to manager 26.4 and the start of a Python 3.15.2 install. VERB's timeout stopped its process tree; no Python/manager process remained. Installation-file changes were **not audited or rolled back**. This experiment was removed from the reusable discovery script and excluded from the pilot; later checks used explicit interpreter paths.

## Historical note: the earlier audit was 0/5

The preceding implementation audit reproduced defects and replayed Click, but lacked prospective setup timing and first-candidate proof records. It correctly reported **0/5** then. None of those older fixes or historical Click gates were backfilled into the five rows above.

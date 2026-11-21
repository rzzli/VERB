# VERB measurements

## Paired Click pilot

**Adding a strict VERB proof caught zero additional wrong patches in this six-candidate replay.** On November 20, 2026, Click's full test suite and a diff-aware aisLOP scan blocked three of four deliberately wrong fixes. VERB separately rejected those same three. Both policies accepted the two genuine fixes. Both missed a patch that showed an empty default only when the individual option explicitly enabled default labels. This is a historical comparison on two changes in one library. [Machine-readable results](paired-click-results.json)

| Revision and candidate | Full pytest suite | aisLOP score / 100 | Strict VERB proof | Suite + scan | Suite + scan + VERB |
|---|---|---:|---|---|---|
| Empty default · genuine `d3e3852` | 584 passed | 93 | Verified | Pass | Pass |
| Label absent defaults | 2 failed | 93 | Failed on the unset option | Block | Block |
| Honor only explicitly enabled defaults | 584 passed | 93 | Verified | Pass | Pass |
| Truncated help · genuine `850bffe` | 574 passed | 99 | Verified | Pass | Pass |
| Drop every help string containing a form feed | 1 failed | 99 | Failed on preserved public help | Block | Block |
| Drop later visible paragraphs | 3 failed | 99 | Failed on preserved public paragraphs | Block | Block |

Each component ran once on the same committed candidate, including when another component had already rejected it. The two policies reuse the exact suite and scanner observations. The suite and scan together took **2.31–2.48 seconds** per candidate. Strict proof added **0.88–1.02 seconds**. Pytest used full default discovery on Windows, with 28 skips on the empty-default revision, 27 on the truncated-help revision, and one expected failure per run. The seeded wrong edits and frozen observer logic come from the earlier blind pilot. Each new claim adds an explanation to an existing control and retains the original Python compilation command for strict proof. The candidate tests, observations and expected values were kept fixed. [Challenge definitions](../blind-review/challenges.mjs) · [Original blind trial](../blind-review/README.md)

aislop 0.20.0 ran its format, lint, code-quality, AI-slop, and security engines on the Git diff from each fix's parent, with Ruff 0.15.4 available. Its gate used a score threshold of 70 and blocked on error findings. Each empty-default scan reported six warnings, each truncated-help scan reported two, and none reported errors. Network dependency auditing was disabled. Missing tools, unavailable engines, incomplete test discovery, and inconclusive proofs invalidate the corresponding comparison. The harness disables Ruff auto-fixes while preserving the project's rules, and confirms that each tool left the tracked candidate intact.

**Replay.** Use Node 22+, Git, a local Click clone containing both commits and their parents, and a Python 3.11 virtual environment. Activate that environment so `ruff` is on PATH, and set `VERB_PYTHON` to its absolute Python executable. Run from the VERB checkout with a new output directory. The scanner installation belongs to the pilot.

```sh
python -m pip install pytest==8.4.2 colorama==0.4.6 ruff==0.15.4
npm install --prefix ../verb-pilot-tools --ignore-scripts --no-audit --no-fund aislop@0.20.0
node test/measurement/paired-click.mjs ../click ../verb-pilot-tools/node_modules/aislop/dist/cli.js ../verb-pilot-run
```

The output directory retains the six disposable checkouts, strict claims, command output, and `results.json`. The result records component wall time including process startup. Dependency installation, human wiring time, and subsequent maintenance effort were outside this replay.

## Five historical changes

On November 19, 2026, each run used a disposable clone, froze an existing probe against the fix's parent, ran three focused checks against the fixed working files, and proved the fixed commit. A separate challenge then ran an intentionally overbroad working edit. Every challenge satisfied the distinguishing assertion and failed the neighboring control. These are five seeded challenges, so this pilot gives no estimate of how frequently developers encounter false passes in practice.

All times below are milliseconds. Each pair gives Windows first and Linux second. Windows used Node 22.23.5. Linux used Node 22.14.0 under WSL2 on its native filesystem. Both used Python 3.11.15 for Click. Timings include process startup. Cloning and prerequisite installation took place beforehand.

| Fix | Automated wiring + baseline | Focused check, median of 3 | Full proof | Required command alone | What rejected the plausible wrong edit |
|---|---:|---:|---:|---:|---|
| Click `d3e3852` | 842 / 156 | 461 / 116 | 1,681 / 715 | 648 / 516 | An unset option acquired a default label. |
| Click `850bffe` | 526 / 102 | 368 / 95 | 1,150 / 284 | 329 / 125 | Dropping all help containing a form feed also removed visible help. |
| escape-string-regexp `e76291d` | 297 / 67 | 208 / 64 | 445 / 98 | 37 / 12 | Escaping every character changed plain text. |
| escape-string-regexp `732905d` | 283 / 60 | 223 / 57 | 461 / 93 | 35 / 11 | Unicode-escaping every character changed plain text. |
| escape-string-regexp `ec45c70` | 275 / 62 | 206 / 58 | 446 / 92 | 33 / 11 | Hex-escaping every character changed plain text. |

The slowest of the 30 focused checks took **1.338 s**, within the 30-second target on these checkouts. The two Click proofs ran the relevant upstream pytest modules. The JavaScript proofs ran the behavior probe plus Node's syntax check on the upstream entry point. The upstream AVA suite and both projects' complete test suites were outside these timing measurements.

**Human wiring time is unmeasured.** No first-time participant was available. The wiring column measures copying a prepared probe, writing its claim, and completing the baseline. Probe design and authoring were already complete. A future first-time trial should start when the participant receives a bug report and existing runnable check, and stop when they can show and explain a reproducing baseline and its neighboring control. Record setup, wiring, new probe authoring, and project-suite time separately, along with assistance received and any wrong fix identified by the participant. That trial is needed to assess the 15-minute target.

The [blind review pilot](../blind-review/README.md) revisits these five fixes with fresh reviewers and compares their checks against the upstream authors' targeted tests.

## Larger checkout

The workload used CPython 3.11.9 (`de54cf5be371a6f5e2e9f208c38def5f81d3ef02`), with **4,687 tracked files and 97,688,493 tracked bytes**. The harness seeded a one-line regression in `textwrap.shorten`, restored the upstream implementation as an uncommitted edit, and tested a custom placeholder and a short-input control. The proof ran CPython's `test.test_textwrap` suite. Warm local caches and small project commands characterize this run.

| Operation | Wall time, 3 runs (ms) | Project command time (ms) | Remaining time including VERB, Git and startup (ms) | Required suite (ms) | Sampled process-tree RSS | Sampled temporary disk |
|---|---|---|---|---|---:|---:|
| Focused check | 313, 343, 308 | 40, 41, 39 | 273, 302, 269 | skipped | 106.6 MiB | 104.0 MiB |
| Full proof | 948, 911, 876 | 252, 187, 183 | 696, 724, 693 | 176, 109, 106 | 126.5 MiB | 104.0 MiB |

Timing runs were separate from one instrumented run per operation. The Linux sampler sums live descendant RSS from `/proc` and counts allocated blocks beneath VERB's private temporary root. It took 25 samples during the check and 69 during the proof. Brief peaks can fall between samples, and summed RSS can count shared pages more than once. Disk excludes the user's original checkout, Git's object database and retained receipts. The remaining wall time is an elapsed-time difference, not a CPU measurement.

## Reproduction

Use local Git clones containing the listed [Click](https://github.com/pallets/click) and [escape-string-regexp](https://github.com/sindresorhus/escape-string-regexp) revisions. Set `VERB_PYTHON` to Python 3.11 with pytest 8 and colorama installed.

```sh
node test/measurement/pilot.mjs /path/to/click /path/to/escape-string-regexp
```

For the resource run, use Linux with Node 22, Git, Python 3.11 and a local [CPython](https://github.com/python/cpython) clone containing tag `v3.11.9`. Both harnesses print the individual results as JSON and make their edits only in disposable clones.

```sh
python3.11 test/measurement/cpython.py /path/to/cpython
```

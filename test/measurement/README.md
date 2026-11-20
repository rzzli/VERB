# VERB measurements · November 19, 2026

## Five historical changes

Each run used a disposable clone, froze an existing probe against the fix's parent, ran three focused checks against the fixed working files, and proved the fixed commit. A separate challenge then ran an intentionally overbroad working edit. Every challenge satisfied the distinguishing assertion and failed the neighboring control. These are five seeded challenges, so this pilot gives no estimate of how frequently developers encounter false passes in practice.

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

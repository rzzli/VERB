# Blind review pilot

**Keep blind review opt-in.** The upstream authors' targeted checks accepted seven of ten deliberately wrong edits. Blind review turned three of those seven from a verified genuine fix to a failed proof. A fourth edit broke an additional blind assertion in a case where the genuine fix already failed a different control. The author's checks caught three edits that passed the blind checks. Three edits passed both.

| Report given to reviewer | Genuine fix | What the blind check added on the two challenges |
| --- | --- | --- |
| Click should show an explicit empty-string default in help | `d3e3852` verified | Caught an unset option acquiring a label. Both checks missed a fix that only honored an explicitly enabled default. |
| Click should drop spurious lines when help truncates to empty at a form-feed | `850bffe` verified | Caught both dropping visible help and dropping a later public paragraph. The author's test passed both. |
| A hyphen in escaped text should stay literal in a character class | `e76291d` failed the Unicode control | Caught escaping only the first of two hyphens. The second range remained active. This assertion passed on the genuine fix. |
| A string containing a hyphen should compile and match literally under JavaScript's Unicode flag | `732905d` verified | The Unicode check and its character-class control missed escaping only the first hyphen. |
| Escaped hyphens should work in PCRE patterns as well as JavaScript | `ec45c70` verified | The probe exercised Git's PCRE matcher and JavaScript's Unicode mode. Both checks missed escaping only the first hyphen. |

For each of the three JavaScript fixes, a challenge that escaped every character still matched the blind reviewer's behavioral examples. The author's exact-output assertions rejected it. Keep those assertions when the output representation is part of the contract.

The genuine character-class fix illustrates a different benefit. The independently chosen Unicode control compiled a whole-string pattern using the actual library. It matched the literal on the broken revision and produced an invalid pattern after the fix. The original character-class behavior improved, and the targeted author check passed. A later upstream change addressed Unicode compatibility. The pilot counts the genuine regression separately from the four incremental catches. [Probe](cases/bracket/probe.cjs) · [Recorded observations](results.json)

## How the comparison worked

- A coordinator who knew the historical changes selected the altered or added upstream regression tests and fixed two challenge edits per case before seeing the blind probes. The freeze records pin the [challenge definitions](challenges.mjs) by SHA-256.
- Five separate automated reviewers received fresh sessions, one sanitized symptom brief each, the claim format and access to that fix's broken source export. Their assignment excluded chat history, memory retrieval, web search, candidate refs, author checks added by the fix, and previous verification output. Tool visibility was controlled by instructions in a shared working environment. This was a procedural blind review by automated agents. No outside person or service attested to independence.
- For each trial, the coordinator first fetched the broken revision into a disposable Git repository and ran `baseline`. Only after it passed did the coordinator fetch the fix for scoring. Both phases used the same checkout and VERB state. Each proof matched the frozen digest, base identity and baseline receipt. The designers received no candidate feedback for probe changes. The local raw receipts are retained by the replay command.
- Each targeted author check failed on the broken implementation and passed on the genuine fix. Click ran the upstream pytest cases. For escape-string-regexp, a small Node adapter ran the selected upstream test bodies with AVA's equality and regex assertions. The blind proofs used Python compilation or Node syntax checking as their required command. Full upstream suites were outside this experiment.
- An incremental catch required an author pass and a blind assertion that passed on the genuine fix but failed on the challenged edit. Linux replay reproduced the Windows outcomes. The five fixes came from a prior convenience sample, three from the same JavaScript package. The ten seeded challenges measure differences in these checks' coverage. They do not estimate defect frequency or human review performance.

## Added time

The times below are UTC on November 20, 2026. Each row covers one reviewer. The interval through freeze includes coordinator queueing and baseline execution. Cases overlapped. Packet preparation, selecting author checks, harness implementation, and scoring the candidate are separate costs. Exact dispatch was missed for the first two sessions, so those rows give lower bounds.

| Reviewer / case | First timed event | Design delivered | Baseline frozen | Elapsed through freeze |
| --- | --- | --- | --- | ---: |
| Empty default | Design already delivered | 19:18:11 | 19:19:26.867 | ≥1.26 min |
| Truncated help | Pre-authoring clock 19:18:04 | 19:18:41 | 19:19:27.079 | ≥1.38 min |
| Character class | Reviewer clock 19:18:50 | 19:19:24 | 19:19:52.140 | 1.04 min from reviewer clock |
| Unicode | Dispatch 19:19:02 | 19:19:41 | 19:20:09.306 | 1.12 min |
| PCRE | Dispatch 19:19:45 | 19:21:04 | 19:21:24.545 | 1.66 min |

The five genuine proof commands took **0.50–1.04 seconds** on the Windows pilot host. The machine-readable results include per-command timing, the full base and candidate revisions, claim digests, freeze and reveal times, file hashes for the raw receipts and author tests, and both sets of outcomes. [Results](results.json)

## Replay

Use Node 22+, Git with PCRE support, local clones of [Click](https://github.com/pallets/click) and [escape-string-regexp](https://github.com/sindresorhus/escape-string-regexp) containing the listed commits and their parents, and Python 3.11 with pytest 8 and colorama. Set `VERB_PYTHON` to that interpreter. From the VERB source checkout, pass the two clone paths and a new output directory outside the source clones.

The replay uses its own Git settings and the C locale so the frozen PCRE check can recognize Git's pattern compilation diagnostics on different hosts.

```sh
node test/blind-review/replay.mjs CLICK_CLONE REGEXP_CLONE NEW_OUTPUT_DIRECTORY
```

The output directory contains the disposable checkouts, raw local receipts and case results. Replay runs already-frozen check designs. It measures execution and reproduces the evidence; a new blind design trial requires a fresh reviewer. [Procedure for a new review](../../skills/verb-regression/references/blind-review.md)

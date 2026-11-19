# VERB pilot results

The frozen Click claim distinguished the real fix from the broken version and an overbroad fix on Windows and Linux. Each platform passed four integration tests and ten Click gate cases. The Linux runs used Ubuntu in WSL. The CLI ran with Node 24 on Windows and Node 22 on Linux. The Click pilot used Python 3.11, pytest 8 and colorama. The npm package also installed offline and exposed the `verb` command.

## What the gates caught

- Identical broken code returned exit 1 even though both help commands exited successfully. An overbroad patch that labeled the unset option also returned 1, with the failed control named.
- A working fix with a failing required command returned 1 while preserving both successful behavioral assertions. An already-fixed base, missing observation, and a Click import from an ambient site-packages directory each returned 2.
- The upstream fix verified both as a commit and as local edits. Separate integration cases exercised changed fixtures, conflicting observations, timeout with a child process, concurrent runs, new and deleted inputs, and working-tree receipt freshness.

## Five historical changes in two repositories

Times below are end-to-end wall times for one completed run on each platform with dependencies installed. Focused runs use a saved baseline and current working files. Proofs rebuild the comparison from the first parent and candidate commit and execute the stated required command.

| Candidate | Observation, broken → fixed | Windows focused / proof | Linux focused / proof |
| --- | --- | ---: | ---: |
| Click `d3e3852` | Empty default unlabeled → explicitly labeled | 585 / 1476 ms | 215 / 445 ms |
| Click `850bffe` | Empty lines in help after truncation, 3 → 1 | 479 / 1257 ms | 102 / 333 ms |
| escape-string-regexp `e76291d` | Escaped character class accidentally matches `m` → rejects it | 233 / 475 ms | 62 / 128 ms |
| escape-string-regexp `732905d` | Unicode regex construction throws → matches the literal hyphen | 234 / 491 ms | 64 / 99 ms |
| escape-string-regexp `ec45c70` | Emitted hyphen escape changes from `\u002d` to `\x2d` | 244 / 494 ms | 65 / 99 ms |

Click ran its upstream option or formatting test file. The JavaScript pilot invoked the package's public API through Node, checked a neighboring plain-text input, and syntax-checked the entry point. Its historical AVA suite and downstream PCRE engine were outside the measured commands. Three changes concern successive refinements to the same escape function. These results cover known fixes with prepared probes.

Reproduce the table from this project using `node test/history-pilot.js PATH_TO_CLICK PATH_TO_ESCAPE_STRING_REGEXP` with `VERB_PYTHON` pointing at the prepared Python environment. The harness works in temporary clones. Both input clones must have the historical commits. [Click](https://github.com/pallets/click) · [escape-string-regexp](https://github.com/sindresorhus/escape-string-regexp)

## Usability and open measurements

An independent coding agent followed the README from a fresh Windows clone using existing local Git objects and installed dependencies. Its wrong fix satisfied the symptom and failed the neighboring control. Its proof of the upstream commit ran 113 option tests. Applying just the source change to the broken checkout ran 112 existing option tests and still verified the behavior. The trial exposed a Windows encrypted-temp-directory copy issue; after switching fixture copies to ordinary byte writes, a sandboxed baseline succeeded in 0.78 seconds.

Focused feedback met the 30-second target in these runs. A second human developer's onboarding trial, the 15-minute wiring target, and an estimate of false passes discovered during ordinary code review remain open. Dependency installation and probe authoring were outside the command timings.

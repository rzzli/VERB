# VERB — Verify Expected Runtime Behavior

Give a coding agent a bug it can reproduce. VERB runs the same probe on the broken code and the proposed fix, checks a neighboring behavior, and records what actually happened. It works before commit and has no runtime package dependencies.

## Try it on a real bug

Install Node.js 22 or later and Git. From this project's directory, run `npm link` to expose the `verb` command. You can also run `node /absolute/path/to/bin/verb.js` in place of `verb`. The Click example additionally uses Python 3.11, pytest 8, and colorama. Here is a complete first run in PowerShell, starting in this project's directory.

```powershell
$tool = (Get-Location).Path
git clone https://github.com/pallets/click.git click-demo
Set-Location click-demo
git checkout --detach c021f05
py -3.11 -m venv .venv
$env:VERB_PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
& $env:VERB_PYTHON -m pip install "pytest>=8,<9" colorama
$claim = Join-Path $tool examples/click/claim.json
verb baseline $claim --base c021f05
verb check $claim
verb prove $claim --base c021f05 --candidate d3e3852
```

The middle command deliberately returns **1** on the broken checkout. The final command should return **0**. On Linux the equivalent is:

```sh
tool="$PWD"
git clone https://github.com/pallets/click.git click-demo
cd click-demo
git checkout --detach c021f05
python3.11 -m venv .venv
export VERB_PYTHON="$PWD/.venv/bin/python"
"$VERB_PYTHON" -m pip install 'pytest>=8,<9' colorama
claim="$tool/examples/click/claim.json"
verb baseline "$claim" --base c021f05
verb check "$claim"
verb prove "$claim" --base c021f05 --candidate d3e3852
```

Read the two option rows. The affected option changes from `unlabeled` to `[default: ""]`. The unset option stays `unlabeled` on both revisions. Both help commands exit successfully. The proof also runs Click's `tests/test_options.py`. Each recorded command includes its exit code, output, and duration. [Original issue](https://github.com/pallets/click/issues/2500) · [Upstream fix](https://github.com/pallets/click/commit/d3e3852)

## Use it with your own project

Run the CLI anywhere inside the target Git checkout. Copy [the claim template](templates/claim.json) and write its probe alongside it. For coding agents, point the agent at [the bundled skill](skills/verb-regression/SKILL.md), or copy its directory into the agent's skill-discovery directory. A useful first request is “Reproduce this bug and find a plausible wrong fix that would pass an obvious test.”

| Command | What exit zero establishes |
| --- | --- |
| `verb baseline CLAIM --base REF` | The selected revision exhibited the known symptom and control observations. Saves the frozen inputs for this claim path. |
| `verb check CLAIM` | The saved baseline and current edits match their respective expectations. This focused run skips required suite commands. |
| `verb prove CLAIM --base REF [--candidate REF]` | Both fresh behavioral runs match expectations and every declared required command succeeded. Defaults to current local edits. |
| `verb status RECEIPT` | The working files still match the content digest in that working-tree receipt. This command only checks freshness. |

Add `--json` to any command. The default output includes the absolute receipt path and replay argument vector. Run the replay from the recorded repository. A working-tree replay uses today's files; check the old receipt with `status` first. A commit replay pins commit IDs. Baselines, observations used for conflict detection, and receipts live under the worktree's Git directory in `verb/`. Each run has its own receipt. History is local to that checkout. When upgrading, run `verb baseline CLAIM --base REF` once to populate the new store. You can inspect an earlier working-tree receipt directly with `verb status RECEIPT`.

### Write a probe

Use a trusted script outside the subject snapshot. Its working directory is the snapshot at `VERB_ROOT`, and `VERB_PROFILE` points to a fresh writable profile. Run the real entry point and emit one JSON object on stdout. Return zero when observations were collected, including on the broken version. Send diagnostics to stderr. Make parsing fail if the requested option, row, or response is missing.

```json
{"origin":"/absolute/path/to/tested/checkout/src/app.js","observations":{"saved theme":"dark","unconfigured locale":"en"}}
```

Report the absolute executable or module file **actually used**. For example, read the loaded module's filename or get the path from the launched application. The verifier checks that its resolved file belongs to the snapshot. A trusted probe supplies this provenance. A fabricated path could misrepresent what ran.

- `fixtures` contains regular files relative to the claim file, including the probe. Invoke the script as a `{bundle}/filename` argument. A change to the claim bytes or any declared fixture invalidates the saved baseline.
- `assertions` maps each observation key to literal `base` and `fixed` strings. Use equal values for a control. Keep expected values here and emit observations from the probe.
- `setup` and `required` are arrays of argument vectors. Setup runs in each fresh tree. Required commands run after the candidate passes its assertions during `prove`. The first unsuccessful required command stops the run. Configure runners to fail on empty selections where relevant. A zero suite exit only records what that command reports.
- `probe`, command arguments, and values in optional `env` support `{root}`, `{bundle}`, `{node}`, and `{python}`. The last uses `VERB_PYTHON` or the platform Python command. Invoke executables directly; use an explicit interpreter for shell or batch scripts. Declare project-specific environment variables and dependencies needed by the subject.
- `timeoutMs` defaults to 60 seconds per command. Combined stdout/stderr is limited to 4 MiB per command. Timeout, output overflow, missing evidence, or an unexpected process failure yields incomplete evidence.

### Interpret a result

**Verified (0)** means the requested operation succeeded. **Failed (1)** identifies a violated candidate assertion or an unsuccessful required check. **Inconclusive (2)** explains missing or contradictory evidence, such as an already-fixed baseline, ambient import, setup failure, or timeout. When completed observations disagree for identical claim and input identities on the same platform, the receipt records the conflict. Inspect the run history and address the cause before relying on that input again.

Each execution gets a separate source directory, profile, and temp directory. The working-tree snapshot includes tracked and new nonignored files, disk versions of staged files, and deletions. Git metadata, ignored build products, submodules, and symlink inputs are outside the v1 input model. Use setup to recreate required build artifacts. Commands run locally as the caller and inherit access to the host, including the network. Use trusted repositories, claims, and probes.

## Run the release gates

Run `node --test test/verification.test.js` from the verifier project. From any clone of Click containing the two pilot revisions, with the example Python environment configured, run `node /absolute/path/to/test/click-gate.js`. It edits a disposable clone and checks the committed fix, uncommitted fix, wrong fix, off-tree import, missing observation, and failed suite.

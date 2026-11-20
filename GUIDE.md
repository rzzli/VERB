# VERB usage guide

Start with the [offline demo and command overview](README.md). This guide covers probe design, builds, hooks, receipts, and troubleshooting.

## Write a probe

Run the real CLI from the snapshot at `VERB_ROOT`. Use `VERB_PROFILE` for settings that need a fresh user directory. Emit one **UTF-8 JSON object** on stdout with the absolute path of the application file actually loaded and the values you observed. Legacy Windows code pages are not auto-detected: configure native shells to emit UTF-8. Command diagnostics are also decoded as UTF-8.

```json
{"origin":"/path/to/snapshot/src/app.js","observations":{"saved theme":"dark","unconfigured locale":"en"}}
```

Keep expected values in the claim. Return zero when the probe collected the observations, even on the broken version. Launch the observer from the bundle, for example `["{python}", "{bundle}/observe.py"]`. Include and load its result-parsing helpers from the bundle too. A checkout-local observer with a frozen data argument now produces an inconclusive claim error. To migrate it, move the observer and its helpers into the fixtures, update the probe command, and run a new baseline.

List the probe and its input files under `fixtures` and rerun `verb baseline` when their bytes or executable bits change. POSIX executable fixture bits are preserved in both frozen copies. Use trusted probes and repositories, since commands run with your local permissions.

Use `{node}`, `node`, `{python}`, `python`, `python3`, `sh`, or `/bin/sh` followed immediately by the declared `{bundle}/...` script. Arguments for that script can follow. VERB resolves a named probe interpreter on the host so a similarly named executable in the snapshot cannot replace it.

You can also run a declared executable fixture directly. On Windows, include its exact `.exe` or `.com` filename. For another runtime or interpreter switches, put the invocation in a frozen wrapper and pass the other frozen files to it. After setup, VERB checks the declared fixture bytes and executable bits before starting the observer.

Git pathnames returned for snapshots must be valid UTF-8. On POSIX, VERB reports an inconclusive result if a filename cannot be decoded faithfully.

Use an explicit installed interpreter via `VERB_PYTHON` when using `{python}` on Windows; an operating-system app alias may launch an installer instead of Python. Claim environment overrides follow case-insensitive Windows names and case-sensitive POSIX names. VERB removes the inherited private `NODE_TEST_CONTEXT` recursion marker so an independent required `node --test` invocation cannot silently skip its test files. Other inherited variables, including `NODE_OPTIONS`, are not generally stripped; explicit claim `env` entries still take precedence, including an intentionally supplied `NODE_TEST_CONTEXT`.

## History and recovery

VERB compares completed observations from the same side and frozen inputs. It tracks required commands separately.

- **Observation conflict:** rerun the same probe until the last three completed runs agree. A `check` counts as a completed observation; a timeout or interrupted command does not.
- **Required-command conflict:** the command must agree across its last three **actual completed executions**. Checks, commands skipped after an earlier failure, and timeouts cannot clear it; cached baselines are not reruns.
- **Conflicting history.** Run a fresh `prove` after resolving a contradiction. A focused `check` can confirm the observation again, but only a proof runs the required suite and restores approval. An invalid history record blocks approval.
- **Upgrading existing claims.** For each active claim, run `baseline` again to enable focused checks, then run `prove` to restore status and hook approval. Older receipts remain readable with `summary`.
- **Locks.** Each history append holds a short per-claim lock. Contenders can retire a confirmed dead local owner's lock one at a time. Locks from another host and locks with an unknown owner require manual recovery. [Hook troubleshooting](#if-a-hook-blocks-and-the-fix-is-not-obvious)
- **Retention:** each claim keeps up to 30 receipts and 30 sequenced history records. Within the receipt limit VERB reserves space for the active baseline and the latest working proof attempt, including a failed or inconclusive attempt. Agreeing focused checks preserve the proof and its frozen baseline archive. History for older input identities eventually rotates out; export a summary before older receipts do.

## Projects that need a build

**Snapshots run as source archives.** Setup, probes, and required commands discard inherited Git repository routing and stop Git discovery before it reaches the enclosing checkout. The outer pre-commit hook continues to use the index selected by Git. A build that runs `git describe`, `git rev-parse`, or another repository query may work in the real checkout but fail during VERB setup. Treat that as unsupported until you can configure a genuine application-supported source-archive/version override. Never copy or link the original `.git` into the snapshots: it describes the original checkout and can make both sides consult the wrong revision or modify shared state.

The Node example demonstrates a tested, project-specific option rather than assuming a universal build variable. Its [build script](<examples/node/build.cjs>) normally derives a version from Git. Without an override it reports `Git metadata is unavailable` in a source-only snapshot; its supported `GREETER_BUILD_VERSION` option bypasses the Git query. The [claim](<examples/node/claim.json>) freezes the same value for both sides:

```json
{
  "env": { "GREETER_BUILD_VERSION": "demo-1" },
  "setup": [["{node}", "build.cjs"]],
  "required": [["{node}", "--test", "greeter.test.cjs"]]
}
```

`GREETER_BUILD_VERSION` belongs **only to this demo project's build contract**, not to VERB or other Node/Python toolchains. For a real project, find and test its own documented override, freeze the appropriate value in the claim, and disclose that version derivation itself was not tested. If the build genuinely needs Git history and offers no safe override, report the setup as inconclusive rather than presenting unrelated checks as a verified proof.

Install dependencies once in the real checkout and ensure the directory is Git-ignored. For example, in a TypeScript project with `/node_modules/` ignored, run `npm ci` there. Add these fields to the claim (keeping its probe, fixtures, and assertions):

```json
{
  "link": ["node_modules"],
  "setup": [["{node}", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]],
  "required": [["{node}", "--test"]],
  "timeoutMs": 60000,
  "requiredTimeoutMs": 300000
}
```

Point the probe at the built CLI in its snapshot and report the built entry point as its origin. `setup` runs separately in each snapshot before the probe, so each side builds from its own source. Historical checkouts use their own Git attributes rather than the candidate's attribute files. `timeoutMs` applies to each setup/probe command; `requiredTimeoutMs` overrides it per required command. Interruption, timeout, and output overflow share command-stop teardown: VERB closes captured pipes and attempts process-tree termination. Interruption prevents later setup/probe/required phases and remains inconclusive. Killing escaped/detached descendants is best-effort, and process cleanup can add bounded overhead; this is not sandbox containment or a hard real-time deadline.

Commands are argv arrays, not shell snippets. On Windows, batch files cannot be launched directly by Node's non-shell spawn. Prefer the JavaScript CLI via `{node}` as above, or explicitly opt into the shell with a trusted command such as `["cmd.exe", "/d", "/s", "/c", "npm test"]`. For exactly this switch order and one final command-text argument (case-insensitive; bare or explicit cmd path), VERB applies cmd-specific quoting, including quoted batch paths and arguments. Other argv arrays retain Node's ordinary argument encoding; no shell is enabled implicitly. Launch errors are inconclusive and are recorded with no exit code.

Linked directories are **shared**, not copied or included in the working-tree digest. `link` accepts ignored, untracked directories only; an ignored file such as `.env` cannot be linked, so copy it into the snapshot through the claim's `setup` step or make the application read it from a supported location. Don't write to linked directories during verification or change their contents between sides. Do not share workspace dependencies whose symlinks/junctions load tracked source from the real checkout: that would make the baseline run candidate source. Install or build those dependencies separately in each snapshot instead. Build outputs should be generated in the snapshots, not shared. Symlinks whose targets exist inside the snapshot or a declared shared directory are preserved on hosts that support creating them. Absolute links into the original checkout are rewritten to relative links in the snapshot. Undeclared escaping links, dangling links, and Git submodules are rejected.

### Review a summary

`verb summary RECEIPT` reports both revision identities, each observation, and each required command's exit code (or `not run`/`unavailable`). Claim paths, origins, and fully qualified path arguments, including `--option=PATH`, are repository-relative using the receipt's Windows or POSIX path conventions, even on another OS. Observations and embedded scripts remain literal text; context-dependent path spellings are outside this formatting guarantee. Inspect the output for private data before sharing.

The digest covers the **raw claim bytes, all named fixture bytes, and each fixture's executable bits**, not just the claim file. Baselines created before executable-mode binding must be rerun once. To recompute it for the claim/probe you are reviewing, run this from the VERB checkout and compare with the summary:

```sh
node --input-type=module -e "import { freeze } from './lib/files.js'; console.log(freeze(process.argv[1]).digest)" "/path/to/claim.json"
```

A successful baseline also archives the exact bytes captured while freezing: the claim file unmodified (including compact/pretty formatting, BOM, and line endings) beside `fixtures/`. To reproduce a digest from archived evidence alone, copy the archived claim and fixtures into a normal claim/directory layout and run `freeze` on that claim path. Rewriting the archived claim as freshly serialized JSON changes the raw-byte digest even when the parsed object is identical.

Use the same file bytes (including line endings) and executable bits. Windows does not provide POSIX executable semantics, so moving fixtures across filesystems may change their digest. Source read/write permissions and ACLs are not fixture identity. A matching digest binds the claim and fixtures, not shared dependencies or a trusted attestation; VERB is not a sandbox or signed-receipt system.

### Claim scope and state

Every receipt reports the declared scope: number of observations, how many are unchanged controls, and how many required commands. A claim with no control or no required command is still valid, but VERB prints a `Scope:` warning instead of implying that either was exercised. Invalid claims name the exact field, for example `assertions[1].expected: unknown assertion field`, and unknown top-level keys are rejected rather than silently ignored.

New receipts use `verb-receipt/2` and baseline slots use `verb-baseline/2`. Each publication gets a durable sequence shared across claims in the repository. Status and retention use that order even if receipt timestamps change. Receipts from version 1 and older unversioned receipts remain readable. An old proof can still be inspected by receipt path. Automatic status and active hooks require a fresh `prove` before approving an unsequenced decision, since its original publication order cannot be recovered from a backup. Incomplete decision fields produce an `inconclusive` diagnostic naming the record. `verb summary` includes the verdict reason, failing side and phase, and up to 320 characters of available command diagnostics.


## Wire a hook

Pass exactly one mode, `--stop` or `--pre-commit`. An omitted, unknown, duplicated, or mixed mode exits with code 2, including outside a Git repository.

These examples resolve VERB from the target project’s installed development dependencies. Run the hook inside that Git checkout. The package lookup also works from a nested directory. A successful `baseline` activates its claim; if a later baseline attempt fails, the claim stays active but needs a successful baseline again. Every new baseline needs a subsequent proof; a proof from a previous activation does not count. Proofs made by versions without this baseline binding must be rerun once. A failed attempt stays authoritative even when snapshot cleanup fails: VERB records the inconclusive attempt and its cleanup diagnostic, and both hooks block until a later successful proof. After the proof has served its purpose (for example, after committing), run `verb deactivate CLAIM` so future changes don't require proving the old bug again.

**Agent stop hook (Claude Code):** merge this into `.claude/settings.json`. Exit 2 asks the agent to keep working; the hook tells it what is missing.

```json
{
  "hooks": {
    "Stop": [{"hooks": [{"type": "command", "command": "node -e \"import('verb-runtime-verify/hooks/verify.mjs')\" -- --stop"}]}]
  }
}
```

**Git pre-commit:** put this in `.git/hooks/pre-commit` (or your configured hooks directory) and make it executable with `chmod +x`. With an active claim, stage all verified changes first: a working-tree proof does not approve a partial commit. The hook also rejects `assume-unchanged` and `skip-worktree` index flags, even on otherwise clean files, because they hide unstaged changes from Git. Clear them with `git update-index --no-assume-unchanged -- PATH` and `git update-index --no-skip-worktree -- PATH` before staging/proving. Sparse checkouts using these flags are not supported by this pre-commit gate. It also refuses Git content-filter attributes (including LFS): a clean filter can turn verified working bytes into different staged bytes while `git diff` is empty. Such repositories need a separate candidate-commit verification workflow rather than this working-tree pre-commit gate.

For the remaining cases, an empty normalized `git diff` is not treated as proof that staged bytes equal verified bytes. The hook materializes the staged tree with the *staged* attribute rules and compares its actual checkout bytes, file types, Git executable identity (the owner execute bit), and internal link targets with the working tree. The staged checkout must also match the content digest from the active proofs, and Git’s index tree must stay the same through the comparison. Line-ending (`text`/`eol`), `core.autocrlf`, `ident`, and `working-tree-encoding` conversions are therefore compared as Git would produce them: consistent repositories pass, and a converted difference is blocked before the commit exists. This comparison fails closed if the staged tree cannot be materialized, including tracked aliases into ignored shared directories declared with `link`; prove the commit directly in that case.

```sh
#!/bin/sh
exec node -e "import('verb-runtime-verify/hooks/verify.mjs')" -- --pre-commit
```

#### If a hook blocks and the fix is not obvious

- **A claim or fixture was deleted or moved.** `Claim file is missing` names the claim. `Fixture is missing` names the missing input and the claim that lists it. Restore the missing file, correct the fixture list, or retire the baseline using the printed command. The path is quoted for PowerShell on Windows and a POSIX shell elsewhere. Run the command from any directory in the same checkout.
- **A killed writer left a lock.** VERB can recover a lock in `.git/verb/locks/` when its owner is confirmed gone on the same host. Older PID-and-start-time locks are treated as local. If the owner is foreign, unreadable or still live, or a killed recovery process left a marker for the current lock, VERB waits up to five seconds and reports the lock path. Confirm that all writers using the checkout have stopped before manually removing the named lock and retrying. A subsequent `status` or acquisition clears obsolete recovery markers.
- **The hook runs outside a Git repository.** A user-level Stop hook then has no VERB claims to check, so the hook allows the action with a short note instead of blocking on Git discovery. Wire project hooks to run inside the repository.
- **A command could not be launched.** Its receipt records no exit code and `verb summary` prints `exit unavailable`; the verdict is inconclusive.
- **The agent is blocked repeatedly.** The Stop hook blocks whenever the active gate is not green and does not inspect a harness loop-guard payload. Read the message: each state above names its fix. If the work is genuinely finished, deactivate the claim instead of disabling the hook.


## Replay the Click regression

Return to the VERB repository root for this separate example. Replay a real bug in Click’s `--help` output. Both revisions exit successfully. Only the fix shows `[default: ""]` for an explicitly empty default while leaving an unset option unlabeled.

Start in the VERB repository root with **Node.js 22+, Git, and Python 3.11**. The example uses a local Python environment.

**PowerShell**

```powershell
$verb = (Resolve-Path bin/verb.js).Path
$claim = (Resolve-Path examples/click/claim.json).Path
git clone https://github.com/pallets/click.git click-demo
Set-Location click-demo
py -3.11 -m venv .venv
$env:VERB_PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
& $env:VERB_PYTHON -m pip install "pytest>=8,<9" colorama
node $verb prove $claim --base c021f05 --candidate d3e3852
```

<details>
<summary>Linux commands</summary>

```sh
verb="$PWD/bin/verb.js"
claim="$PWD/examples/click/claim.json"
git clone https://github.com/pallets/click.git click-demo
cd click-demo
python3.11 -m venv .venv
export VERB_PYTHON="$PWD/.venv/bin/python"
"$VERB_PYTHON" -m pip install 'pytest>=8,<9' colorama
node "$verb" prove "$claim" --base c021f05 --candidate d3e3852
```

</details>

**Expected result: `VERIFIED` (exit 0).** The receipt shows both option labels and the result of Click’s option test suite. A patch that labels *every* option fails the unset-option check. [Example claim](examples/click/claim.json) · [Probe](examples/click/probe.py)


## Resource budgets

A working-tree `prove` hashes the current files to record the intended candidate, then reads them again when it builds the candidate snapshot; that content volume — not the installed package — is the real cost driver. `npm run bench:resources` measures a small CLI, a 2,000-file tree, a 12 MiB tracked asset, and verbose output retention, reporting wall time, peak CLI RSS, content bytes, and retained `.git/verb` bytes. On one Windows host (Node 22.23.5, Git 2.53.0) the recorded runs were: 7-byte tree, `prove` 443 ms / 40.8 MiB RSS; 2,001 files, `prove` 6.1 s / 50.5 MiB; one 12 MiB binary asset, `prove` 997 ms / 57.5 MiB. Re-measure on your own filesystems before setting agent timeouts; file count and total bytes, plus antivirus/filesystem behaviour, dominate.

From the source checkout, repeat the optional Click gate by running `node ../test/click-gate.js` from `click-demo` with the Python environment above.

The [five-change pilot and larger-checkout measurements](https://github.com/rzzli/VERB/blob/main/test/measurement/README.md) report focused feedback, project-suite time, sampled process-tree memory and temporary disk, with reproduction commands.

Retained state is bounded to 30 receipts and 30 history records per claim path, but a receipt retains capped command output (up to 4 MiB per command), so verbose required commands are the largest storage risk: a command printing 64 KiB per run produced 69,825-byte receipts (700,771 bytes over 11 runs). Deactivate the claim when it is finished. Replacing or deactivating a baseline releases its reserved evidence for normal rotation.

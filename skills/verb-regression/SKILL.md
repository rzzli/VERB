---
name: verb-regression
description: Design a behavioral claim and use VERB to reproduce a regression and test a proposed fix. Supports optional blind review when a fresh reviewer should design and freeze the check before seeing the candidate.
---

When the developer asks for a **blind review**, the coordinator starts with the [blind review procedure](references/blind-review.md) before sharing project context. For ordinary regression work, continue below.

Start with what the user saw and what they expected. Locate the public entry point and the repository's relevant checks. Identify a plausible wrong patch that satisfies the obvious test. Pick a neighboring input that should behave the same before and after the fix. Put the shortcut it exposes in that assertion's `wrongFix` field. Review the explanation alongside the expected and observed values.

Start with the complete offline [Node example](../../examples/node/claim.json) if you need to learn the protocol; it needs only Node and Git and includes the application, build, probe, controls, and required tests. Its empty-name symptom passes a broad wrong patch, but the missing-name control rejects that patch. The [claim template](../../templates/claim.json) is a starting point to adapt, not a ready-made probe. The optional [Click example](../../examples/click/claim.json) demonstrates Python interoperability and requires its separate environment/network setup.

Write a probe that drives the real public entry point, reports the absolute path of the application it actually loaded, and emits raw observations. Keep expected values in the claim, not in a probe that reimplements the application. Missing output, failed imports, and ambiguous parsing should stop the probe. Keep the claim and probe in the repo for other developers.

Check build compatibility before promising a proof. Snapshots are source-only: they do not contain usable Git metadata. A successful build in the original checkout does not establish that a build invoking Git will work in a snapshot. Use only an actually supported source-archive/version override, freeze it in claim `env`, and test it. The Node example implements `GREETER_BUILD_VERSION` for its own build; this is not a general Node or VERB variable. Do not invent an environment variable for another toolchain or share the original `.git`. If no safe override exists, report the setup as unsupported/inconclusive. Run setup separately for each snapshot; don't share generated artifacts between baseline and candidate.

Run `verb baseline CLAIM --base BROKEN_REF` before editing. During edits use `verb check CLAIM`. If the claim, rationale, or fixture needs a correction, explain why and rerun baseline on the original broken revision. For a strict proof, declare the relevant project test command and run `verb prove CLAIM --base BROKEN_REF --strict`. Use `--candidate COMMIT_SHA` to prove a specific commit. When reporting on a claim with narrower scope, run an ordinary proof and disclose its limitations.

On exit 0, read both observations and the required command outcomes before reporting a fix; `check` skips the required commands. On exit 1, inspect which candidate observation or required command failed, fix the code, and rerun. On exit 2, don't claim success: fix the setup or verify the baseline actually reproduces the bug. For conflicting runs, keep the claim frozen and investigate until the last three completed runs agree. If a required command conflicted, use `prove`: `check`, skipped commands, and timeouts do not count toward that command's last three completed executions.

Inspect required-command output as well as its exit code: confirm that the intended tests actually ran, rather than trusting an empty or skipped suite. VERB isolates the inherited private `NODE_TEST_CONTEXT` marker for independent Node test runs, but that is not a general defense against a project's own skip settings or a no-op command.

When a control captures a lasting product requirement, preserve the assertion in the project's native suite. Confirm the suite catches the wrong edit and passes the fix before retiring the claim. Use project lint rules for structural concerns such as duplication. Run Git-diff-based scans in the actual checkout with its base history.

Return the receipt path, behavior checked, and remaining uncertainty. Use `verb summary RECEIPT` for a pull request. Do not turn a small successful example into a general correctness or portability claim: macOS and native Windows console-control event delivery are unverified here. The Windows cancellation regression is labeled JavaScript-handler simulation; POSIX coverage uses a real OS SIGINT. Interruption remains inconclusive, later command phases must not run, and escaped descendant cleanup remains best-effort.

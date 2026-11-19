---
name: verb-regression
description: Design a behavioral claim and use VERB (Verify Expected Runtime Behavior) to reproduce a reported regression, challenge a plausible false pass, and check a proposed fix against the broken version.
---

Start with what the user saw and what they expected. Locate the public CLI and the repository's relevant checks. Identify a plausible wrong patch that could satisfy the obvious test. Pick a neighboring input whose observed result distinguishes that patch from a correct fix.

Copy the bundled claim template or use the Click example. Write a probe that drives the real entry point, reports the absolute path of the application it actually loaded, and emits raw observations. Keep expected values in the claim. Missing output, failed imports, and ambiguous parsing should stop the probe. Keep the template and probe in the repo for other developers.

Run `verb baseline CLAIM --base BROKEN_REF` before editing. Read the symptom and control. During edits use `verb check CLAIM`. Don't change the probe, fixture, or expectations after baseline just to make a check pass. If a change is necessary, state why and rerun baseline on the original broken revision before continuing. Run `verb prove CLAIM --base BROKEN_REF` after the last edit. If `verb` isn't on PATH, invoke `node "/absolute/path/to/VERB/bin/verb.js"` with the same arguments from the target repo.

On exit 0, read both observations and the required command outcomes before reporting a fix; `check` skips the required commands. On exit 1, inspect which candidate observation or required command failed, fix the code, and rerun. On exit 2, don't claim success: fix the setup or verify the baseline actually reproduces the bug. For conflicting runs, keep the claim frozen and investigate until the last three completed runs agree. If a required command conflicted, use `prove`: `check`, skipped commands, and timeouts do not count toward that command's last three completed executions.

Return the receipt path, behavior checked, and remaining uncertainty. Use `verb summary RECEIPT` for a pull request.

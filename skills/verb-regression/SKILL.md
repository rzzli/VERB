---
name: verb-regression
description: Design a behavioral claim and use VERB (Verify Expected Runtime Behavior) to reproduce a reported regression, challenge a plausible false pass, and check a proposed fix against the broken version.
---

Start with what the user saw and what they expected. Locate the public CLI and the repository's relevant checks. Identify a plausible wrong patch that could satisfy the obvious test. Pick a neighboring input whose observed result distinguishes that patch from a correct fix.

Copy the bundled claim template or use the Click example. Write a probe that drives the real entry point, reports the absolute path of the application it actually loaded, and emits raw observations. Keep expected values in the claim. Missing output, failed imports, and ambiguous parsing should stop the probe. Keep the template and probe in the repo for other developers.

Run `verb baseline CLAIM --base BROKEN_REF` before editing. Read the symptom and control. During edits use `verb check CLAIM`. A change to the fixture or expectation needs a fresh baseline. Run `verb prove CLAIM --base BROKEN_REF` after the last edit. Read both observations and required command outcomes before describing the fix.

Return the receipt path, behavior checked and remaining uncertainty. Explain inconclusive evidence or investigate the cause. A focused check and a matching working-tree digest each answer a narrower question than a full proof.

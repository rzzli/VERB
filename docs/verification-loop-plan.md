# A lightweight verification loop for AI-assisted coding

This was the initial design for VERB (Verify Expected Runtime Behavior). The implemented CLI and current pilot measurements are in the [usage guide](../README.md) and [pilot results](pilot-results.md).

Start with one existing repository, one bug its tests missed, and one command that can tell the broken and fixed versions apart. A developer, their coding agent, and CI should all be able to run that command. Keep it in the project's existing task runner so adoption costs roughly what it takes to write the first meaningful check.

The [seed notes](step0_notes.md.txt) suggest three design choices worth carrying into a small project. Make the expected behavior executable, exercise the surface the user actually touches, and turn recurring review feedback into a test, type, lint rule, or simpler API. Treat the reported token split as one team's experience. The pilot should measure bugs caught and time spent waiting.

## What a coding session looks like

1. **Name the claim.** Before editing, write one observable acceptance condition in the task. For example, “After I save a setting and restart the CLI, reading the setting returns the value I saved.” The developer owns the intended outcome. The agent can write the check.
2. **Show the check can fail.** For a bug, run the new check against the broken version and confirm it fails for the reported reason. For a new capability, use a known-wrong example where practical. An unrelated setup error provides no evidence about the claim.
3. **Edit and rerun the smallest relevant check.** Give the agent the actual command, expected value, observed value, and enough output to locate the failure. After two attempts that produce the same unexplained failure, surface the evidence to the developer. A changed hypothesis or new information can justify another attempt.
4. **Run the completion check after the last edit.** It runs the repo's required static checks and regression suite plus the acceptance check for the task. CI can invoke the same entry point on the proposed revision. A quick check may guide an edit, but only the completion command can report the full result.
5. **Hand back evidence.** Report the behavior exercised, the command that exercised it, the result, and any behavior that still needs human judgment. Preserve the regression check. When a pattern recurs across features, consider enforcing it once at the API or type boundary.

## The smallest implementation worth piloting

| Piece | Proposed behavior |
| --- | --- |
| Entry point | Add a `verb` task to the runner the repo already uses. On an npm project that could be `npm run verb`. Keep the project's usual focused-test command for the inner loop. |
| Behavior check | Write one named test using the existing test framework. Drive the checked-out CLI, public API, or UI and assert an observable result. The test name plus its invocation is the first entry in the feature map. |
| Agent instruction | One line in the existing project instructions: “Before reporting a behavior change complete, run the verification task after your last edit and cite the assertion that covers the request.” |
| Failure handling | The first failing required step returns nonzero and names the remaining steps as unrun. A missing tool, timeout, skipped acceptance case, or empty test selection leaves the change unverified. Configure the project's runner to detect those cases when its defaults allow success. |
| Evidence | Use terminal output and the CI log first. Print the check name and expected/actual values on failure. Attach a trace only when it helps explain a UI failure. A screenshot alone cannot establish that a saved setting survived a restart. |

The completion task runs checks and returns status. The developer's existing coding agent handles edits. This division lets a contributor reproduce the result from a terminal without credentials for an AI provider. A human reviews changes that weaken assertions, add skips, or alter the expected behavior.

### Worked pilot

Take the setting example. Start with a temporary profile directory. Launch the checkout's CLI to set the theme to dark, let the process exit, then launch a second process with the same profile and read the theme. Assert that the returned value is `dark`. A unit test of a setter can pass even if the app only changes memory. Restarting makes the persistence claim testable.

An illustrative failure line is `FAIL settings survive restart | expected dark | observed light`. The agent now has a symptom it can reproduce. After the fix, the reviewer can see the same named assertion pass alongside the existing suite. Each run uses a fresh directory so another run's settings cannot supply the answer.

## Similar projects and what to reuse

| Project | Relevant capability | Decision for the pilot |
| --- | --- | --- |
| pstack | The project in the seed notes generates a repo-specific skill for launching, driving, and observing the actual application. It starts from the project's existing commands. | Closest starting point. Use its discovery questions to author the first behavior check. Expose that check as an ordinary repo command. [Upstream skill](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md) |
| poteto-skills | This pstack-inspired project generates asserted CLI/HTTP recipes, including write-then-read checks, and a shell harness with a proof command. | Closest executable comparison. Try its generated recipe before writing a shared runner. Keep the shell and platform requirements in view for Windows contributors. [Project repository](https://github.com/DipsySu/poteto-skills) |
| Superpowers | Its verification-before-completion skill ties success claims to a fresh command, its output, and its exit status. | Borrow its completion discipline. Supply the specific command and behavior assertion from the repository. [Upstream skill](https://github.com/obra/superpowers/blob/main/skills/verification-before-completion/SKILL.md) |
| Aider | Aider can run a project's test command after edits and use failures to attempt repairs. | Reuse that feedback cycle if Aider is the editor. The same command remains available to other agents and CI. [Linting and testing](https://aider.chat/docs/usage/lint-test.html) |
| Playwright | Browser assertions can wait for an observable state. Traces expose the actions, DOM snapshots, and network activity around failures. | In a web pilot, drive one user journey and keep its trace on failure. [Assertions](https://playwright.dev/docs/test-assertions) · [Trace guidance](https://playwright.dev/docs/best-practices) |
| Bombadil | The tool named in the notes explores UI action sequences and checks properties during exploration. | Add it when a real bug depends on action ordering and a named invariant can detect it. The pilot's fixed reproduction remains the quick check. [Project manual](https://antithesishq.github.io/bombadil/browser/1-introduction.html) |

The closest projects already cover the individual ideas. The question for this project is narrower: can a developer move one reliable acceptance check between their terminal, coding agent, and CI with little setup? That is a usability hypothesis to test on real repos.

## Pilot and decision to package

| Stage | Work | Decision |
| --- | --- | --- |
| First personal repo | Choose a small runnable project with a known regression. Record whether its existing suite catches the bug. Add the behavior check and wire the completion command. | Proceed when the new check fails on the broken revision for the expected reason, passes on the fix, and a teammate can reproduce both results from the command alone. |
| Next five changes | Track setup minutes, time to the first actionable failure, quick-check runtime, false passes found in review, and failures on unchanged code. Record whether anyone skipped the loop and why. | Provisional targets are under 15 minutes to wire an existing test into the loop and under 30 seconds for focused feedback. Time spent authoring a missing test is measured separately. |
| Second repo and second user | Try a different stack or agent. Ask the second developer to reproduce one failure using just the repository instructions. Compare with running the closest existing pstack or poteto-skills recipe. | Share the recipe if repo-native commands suffice. Extract a dependency-free wrapper only for repeated work observed in both pilots, such as inconsistent skip detection or failure reporting. |

This workspace currently contains the seed notes and has no runnable app for a baseline. The CLI example is illustrative. Setup targets, detection rates, and usability remain to be measured.

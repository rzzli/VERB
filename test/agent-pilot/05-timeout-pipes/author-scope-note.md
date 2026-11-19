# Trial 05 author scope note

This is candidate-author context, not an independent review or proof result.

The reproduced defect is waiting for inherited output pipes after the launcher has already exited. The first baseline's real inner CLI took 3395 ms with a 400 ms command timeout because a finite detached worker retained stdout for three seconds. Its neighboring active-root timeout remained inconclusive (750 ms), and ordinary setup plus probe succeeded (314 ms).

The first candidate closes the captured stdout/stderr streams after the existing stop operation. It retains output already collected and the existing timeout/output-limit classification. Normal command completion is unchanged. The regression includes stdout and stderr held by a detached child, an active-root timeout, and complete output from a successful command.

Process-tree termination remains **best-effort**. This change does not promise to find or kill an escaped/detached descendant, introduce native dependencies or Windows job objects, or provide a hard real-time deadline. Existing process-termination overhead still applies, including the bounded Windows taskkill attempt. Its scope is preventing an already-exited launcher's inherited pipes from delaying command completion until the descendant exits. Cancellation behavior is outside this trial.

The behavioral fixture and regression use finite-lived workers. Their working directories are outside the disposable source snapshot, and any fixture cleanup targets only the PID recorded by that fixture. The frozen probe uses a 1500 ms classification threshold for a 400 ms command timeout and a 3000 ms worker lifetime.

No candidate test or proof was run before first-candidate capture. Independent review must precede the first proof. Root production, the seed, and other trial work are not changed by this candidate.

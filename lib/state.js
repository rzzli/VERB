// Persisted formats and read-only validation. A receipt that cannot be understood is
// never treated as absent: ignoring it could expose an older, still-green proof.
import { readJSON } from './files.js';

export const receiptFormat = 'verb-receipt/1';
export const baselineFormat = 'verb-baseline/1';

/**
 * @typedef {object} Claim
 * @property {string} claim Human-readable claim being verified.
 * @property {string[]} probe Argv of the probe; `{node}`, `{python}`, `{bundle}` expand.
 * @property {string[]} fixtures Frozen inputs, relative to the claim, with forward slashes.
 * @property {{key: string, base: string, fixed: string}[]} assertions
 *   `base` is the broken-side expectation, `fixed` the candidate-side expectation;
 *   equal values mark an unchanged neighboring control.
 * @property {string[][]} required Commands that must exit 0 on the candidate.
 * @property {string[][]} [setup] Commands that build each snapshot before the probe.
 * @property {Record<string, string>} [env] Project-specific environment overrides.
 * @property {number} [timeoutMs] Per setup/probe command timeout.
 * @property {number} [requiredTimeoutMs] Per required-command timeout.
 * @property {string[]} [link] Ignored directories shared into both snapshots.
 */

/**
 * @typedef {object} Command
 * @property {'setup'|'probe'|'required'} phase
 * @property {string[]} argv Expanded argv recorded in the receipt.
 * @property {number|null} code Exit code, or null when it never completed.
 * @property {string|null|undefined} error Stop/failure reason.
 * @property {number} ms Elapsed milliseconds.
 * @property {string} stdout Retained (size-capped) output.
 * @property {string} stderr Retained (size-capped) output.
 */

/**
 * @typedef {object} Side
 * @property {'working'|'commit'} kind
 * @property {string} id Content identity: working-tree digest or commit id.
 * @property {boolean} [cached] True for a stored baseline reused by `check`.
 * @property {Record<string, unknown>} [observations] Decoded probe output.
 * @property {{key: string, expected: string, actual: unknown, control: boolean, pass: boolean}[]} [assertions]
 * @property {Command[]} commands
 * @property {'verified'|'failed'|'inconclusive'} verdict
 * @property {string} [reason]
 * @property {string|null} [historyRevision] Invalidating history event id, if any.
 * @property {string} [origin] Probe-reported implementation origin.
 */

/**
 * @typedef {object} Receipt
 * @property {'baseline'|'check'|'prove'} action
 * @property {string} [format] `verb-receipt/1`; absent on legacy receipts.
 * @property {'verified'|'failed'|'inconclusive'} verdict
 * @property {string} claimPath
 * @property {string} digest Claim and fixture digest.
 * @property {string} receipt Own path.
 * @property {Record<string, Side>} sides
 * @property {Command[]} required Expanded required argv.
 * @property {{observations: number, controls: number, requiredCommands: number}} [scope]
 * @property {{code: string, message: string}[]} [warnings]
 * @property {{path: string, message: string}[]} [cleanupErrors]
 * @property {string} [reason]
 * @property {string} [frozen] Archived claim/fixture directory for a baseline.
 * @property {string[]} replay Re-run argv for a working-tree proof.
 */

/**
 * @typedef {object} BaselineRecord
 * @property {string} [format] `verb-baseline/1`; absent on legacy records.
 * @property {string} receipt Saved baseline receipt.
 * @property {string} claimPath
 * @property {'verified'|'failed'|'inconclusive'} verdict
 * @property {string} digest
 * @property {Side} base
 * @property {boolean} [active] Claim remains gated until an explicit deactivate.
 */

function parse(file, read, format, label) {
  let value;
  try { value = read(); }
  catch (error) {
    const message = error.code === 'ENOENT' ? 'Missing' : 'Cannot read';
    throw Object.assign(Error(`${message} ${label} ${file}: ${error.message}`),
      { code: error.code === 'ENOENT' ? 'ENOENT' : 'state_invalid' });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(Error(`Invalid ${label} (expected a JSON object): ${file}`), { code: 'state_invalid' });
  }
  // Legacy records predate explicit format ids and remain readable. A newer format
  // is not guessed at: mixed-version writers must fail closed.
  if (value.format !== undefined && value.format !== format) {
    throw Object.assign(Error(`Unsupported ${label} format ${JSON.stringify(value.format)} ` +
      `(supported: ${format}); upgrade or rerun verification: ${file}`), { code: 'state_unsupported' });
  }
  if (!['verified', 'failed', 'inconclusive'].includes(value.verdict)) {
    throw Object.assign(Error(`Invalid ${label} verdict ${JSON.stringify(value.verdict)}: ${file}`), { code: 'state_invalid' });
  }
  return value;
}

/** Load a receipt; malformed or unsupported receipts fail closed rather than disappearing. */
export function readReceipt(file) {
  return parse(file, () => readJSON(file), receiptFormat, 'receipt');
}

/** Load a baseline slot; `undefined` only when it does not exist. */
export function readBaseline(file, value) {
  const read = value === undefined ? () => readJSON(file) : () => value;
  try { return parse(file, read, baselineFormat, 'baseline record'); }
  catch (error) { if (error.code === 'ENOENT' && value === undefined) return undefined; throw error; }
}

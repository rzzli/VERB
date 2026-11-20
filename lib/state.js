// Persisted formats and read-only validation. A receipt that cannot be understood is
// never treated as absent: ignoring it could expose an older, still-green proof.
import { readJSON } from './files.js';
import path from 'node:path';

export const receiptFormat = 'verb-receipt/2';
export const baselineFormat = 'verb-baseline/2';

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
 * @property {string} [historyGeneration] Identifier for this side's continuous history window.
 * @property {string} [origin] Probe-reported implementation origin.
 */

/**
 * @typedef {object} Receipt
 * @property {string[]} [repoAliases] Windows root spellings used by declared command paths.
 * @property {'baseline'|'check'|'prove'} action
 * @property {string} [format] Versioned receipt format.
 * @property {number} [sequence] Durable publication order starting in v2.
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
 * @property {string} [format] Versioned baseline format.
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
  if (value.format !== undefined && value.format !== format && value.format !== format.replace('/2', '/1')) {
    throw Object.assign(Error(`Unsupported ${label} format ${JSON.stringify(value.format)} ` +
      `(supported: ${format}); upgrade or rerun verification: ${file}`), { code: 'state_unsupported' });
  }
  if (!['verified', 'failed', 'inconclusive'].includes(value.verdict)) {
    throw Object.assign(Error(`Invalid ${label} verdict ${JSON.stringify(value.verdict)}: ${file}`), { code: 'state_invalid' });
  }
  return value;
}

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = v => typeof v === 'string' && v.length > 0;
const argv = v => Array.isArray(v) && v.length > 0 && v.every(a => typeof a === 'string');
function need(ok, field, file) {
  if (!ok) throw Object.assign(Error('Invalid or incomplete ' + field + ': ' + file), { code: 'state_invalid' });
}

function validateSide(side, field, file, detailed) {
  need(object(side) && ['commit', 'working'].includes(side.kind) && string(side.id), field + ' identity', file);
  need(['verified', 'failed', 'inconclusive'].includes(side.verdict), field + ' verdict', file);
  need(Array.isArray(side.commands) && side.commands.every(c => object(c) &&
    ['setup','probe','required'].includes(c.phase) && (c.code === null || Number.isInteger(c.code)) &&
    (!detailed || (argv(c.argv) && typeof c.stdout === 'string' && typeof c.stderr === 'string')) &&
    (side.verdict !== 'verified' || (!c.error && c.code === 0))), field + ' commands', file);
  if (side.verdict === 'verified' || side.verdict === 'failed') {
    need(string(side.origin) && Array.isArray(side.assertions) && side.assertions.length > 0 &&
      side.assertions.every(a => object(a) && string(a.key) && typeof a.control === 'boolean' &&
        typeof a.actual === 'string' && typeof a.expected === 'string' && a.pass === (a.actual === a.expected) &&
        (side.verdict !== 'verified' || a.pass)), field + ' assertions', file);
    need(side.commands.some(c => c.phase === 'probe' && c.code === 0 && !c.error), field + ' probe result', file);
  }
}

/** Load a receipt; malformed or unsupported receipts fail closed rather than disappearing. */
export function readReceipt(file) {
  const r = parse(file, () => readJSON(file), receiptFormat, 'receipt');
  const current = r.format === receiptFormat;
  need(['baseline','check','prove'].includes(r.action), 'receipt action', file);
  need(string(r.repo) && string(r.claimPath ?? r.replay?.[2]), 'receipt claim identity', file);
  need(object(r.sides), 'receipt sides', file);
  if (current) {
    need(Number.isSafeInteger(r.sequence) && r.sequence > 0, 'receipt sequence', file);
    const prefix = /^(\d+)~/.exec(path.basename(file));
    if (prefix) need(Number(prefix[1]) === r.sequence, 'receipt publication sequence', file);
    need(string(r.receipt) && string(r.claimPath) && argv(r.replay) &&
      r.replay[1] === r.action && r.replay[2] === r.claimPath, 'receipt replay identity', file);
    if (r.action === 'prove') need(['working','commit'].includes(r.targetKind), 'receipt target kind', file);
    if (r.targetKind === 'working' && !r.target) need(r.targetUnavailable === true, 'receipt working target', file);
    if (r.targetUnavailable !== undefined) need(r.targetUnavailable === true && r.targetKind === 'working' &&
      r.verdict === 'inconclusive' && !r.target && !r.sides.candidate, 'receipt unresolved target', file);
  }
  for (const [role, side] of Object.entries(r.sides)) {
    need(role === 'candidate' || role === 'base', 'receipt side role', file);
    validateSide(side, role, file, current);
    if (role === 'base') need(side.kind === 'commit', 'base kind', file);
  }
  if (r.target !== undefined) need(object(r.target) && ['working','commit'].includes(r.target.kind) &&
    string(r.target.id) && (!r.targetKind || r.target.kind === r.targetKind), 'receipt target', file);
  const candidate = r.sides.candidate;
  if (r.target && candidate) need(r.target.kind === candidate.kind && r.target.id === candidate.id, 'candidate identity', file);
  if (r.action === 'baseline') need(!candidate, 'baseline sides', file);
  if (r.verdict === 'inconclusive') {
    need(string(r.reason), 'receipt reason', file);
  } else {
    need(string(r.digest) && Array.isArray(r.required) && r.required.every(argv), 'receipt frozen claim', file);
    need(r.sides.base?.verdict === 'verified', 'receipt baseline result', file);
    if (r.action !== 'baseline') need(candidate?.verdict === r.verdict, 'receipt candidate result', file);
    if (current && r.action === 'prove') need(r.target && candidate.kind === r.targetKind, 'receipt proof target', file);
    if (current) {
      need(Number.isInteger(r.scope?.observations) && r.scope.observations > 0 &&
        r.scope.requiredCommands === r.required.length && Object.values(r.sides).every(s =>
          s.assertions.length === r.scope.observations && s.assertions.every(a => s.observations?.[a.key] === a.actual)),
      'receipt observation evidence', file);
    }
    if (r.action === 'prove' && r.verdict === 'verified') {
      const checks = candidate.commands.filter(c => c.phase === 'required');
      need(checks.length === r.required.length && checks.every(c => c.code === 0 && !c.error), 'required command evidence', file);
    }
  }
  return r;
}

/** Load a baseline slot; `undefined` only when it does not exist. */
export function readBaseline(file, value) {
  const read = value === undefined ? () => readJSON(file) : () => value;
  try {
    const b = parse(file, read, baselineFormat, 'baseline record');
    need(string(b.receipt), 'baseline receipt', file);
    if (b.format === baselineFormat) need(string(b.claimPath) && typeof b.active === 'boolean' &&
      (b.verdict !== 'verified' || b.active), 'baseline activation', file);
    if (b.verdict === 'verified') {
      need(string(b.digest), 'baseline digest', file);
      if (b.base || b.format) {
        validateSide(b.base, 'baseline', file, b.format === baselineFormat);
        need(b.base.kind === 'commit' && b.base.verdict === 'verified', 'baseline result', file);
      }
    }
    return b;
  }
  catch (error) { if (error.code === 'ENOENT' && value === undefined) return undefined; throw error; }
}

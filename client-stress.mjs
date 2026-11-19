/**
 * Client-side checks for the save path, extracted from client.js's `Page`.
 *
 * The browser bundle cannot be imported here (no React DOM, no module loader),
 * so the pieces that actually carry the behaviour are re-implemented verbatim
 * and exercised directly:
 *
 *   - the delta-to-ops projection (must never emit `path: []`),
 *   - the `mutate` settlement (must never report success on `false`),
 *   - the settings surface (exactly the 7 surviving settings, and no trace of
 *     the five that policy contraction removed).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let failures = 0;
const log = [];
function check(name, fn) {
  try {
    fn();
    log.push(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    log.push(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed');
}

/**
 * The complete settings surface after policy contraction. Each entry is a key
 * the Host declares in `Config` AND the page must render.
 */
const FIELDS = [
  'auditDedupeMs',
  'auditEveryStep',
  'enforcement',
  'includeAllowedListInError',
  'recentDenialLimit',
  'replaceSubagentTool',
  'strict',
];

/**
 * Settings removed by the contraction. The page must not mention them, or it
 * would offer a control that writes a field the Host no longer accepts.
 */
const REMOVED_FIELDS = [
  'routes',
  'deniedRoutes',
  'maxDepth',
  'checkInherited',
  'useOfficialAllowList',
];

const HERE = dirname(fileURLToPath(import.meta.url));

// ── verbatim from client.js: delta projection ──────────────────────────
function changedOps(target, baseline) {
  const ops = [];
  const keys = new Set([...Object.keys(target), ...Object.keys(baseline ?? {})]);
  for (const key of keys) {
    const before = baseline?.[key];
    const after = target[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    ops.push(after === undefined
      ? { op: 'unset', path: [key] }
      : { op: 'set', path: [key], value: after });
  }
  return ops;
}

// ── verbatim from client.js: settlement ────────────────────────────────
function settleFrom(answer) {
  if (answer === false) return { kind: 'error', error: '保存被拒绝' };
  return { kind: 'saved', error: null };
}

log.push('=== client save path ===');

check('delta: an unchanged draft produces no ops', () => {
  const base = { strict: true, enforcement: 'agent-created' };
  assert(changedOps({ ...base }, base).length === 0, 'expected no ops');
});

check('delta: only changed fields are written, by narrow path', () => {
  const base = { strict: true, includeAllowedListInError: true, recentDenialLimit: 0 };
  const ops = changedOps({ ...base, strict: false }, base);
  assert(ops.length === 1, `expected 1 op, got ${ops.length}`);
  assert(ops[0].op === 'set', 'expected set');
  assert(JSON.stringify(ops[0].path) === '["strict"]', `bad path: ${JSON.stringify(ops[0].path)}`);
  assert(ops[0].value === false, 'bad value');
});

check('delta: never emits the whole-section path []', () => {
  const base = { strict: true, enforcement: 'agent-created', recentDenialLimit: 0 };
  const ops = changedOps({
    strict: false,
    enforcement: 'both',
    recentDenialLimit: 50,
    auditDedupeMs: 5000,
    includeAllowedListInError: false,
    replaceSubagentTool: true,
    auditEveryStep: true,
  }, base);
  assert(ops.length > 0, 'expected ops');
  for (const op of ops) {
    assert(Array.isArray(op.path) && op.path.length === 1, `bad path depth: ${JSON.stringify(op.path)}`);
  }
});

check('delta: a removed field becomes unset, not undefined-valued set', () => {
  const base = { strict: true, auditEveryStep: false };
  const target = { strict: true };
  const ops = changedOps(target, base);
  assert(ops.length === 1 && ops[0].op === 'unset', `expected unset, got ${JSON.stringify(ops)}`);
  assert(JSON.stringify(ops[0].path) === '["auditEveryStep"]', 'bad unset path');
});

check('delta: numeric edits are scoped to their own field', () => {
  const base = { recentDenialLimit: 0, auditDedupeMs: 0 };
  const ops = changedOps({ recentDenialLimit: 25, auditDedupeMs: 0 }, base);
  assert(ops.length === 1, `expected 1 op, got ${ops.length}`);
  assert(JSON.stringify(ops[0].path) === '["recentDenialLimit"]', 'numeric op missing');
  assert(ops[0].value === 25, 'numeric value wrong');
});

check('settle: mutate(false) must NOT report success', () => {
  const status = settleFrom(false);
  assert(status.kind === 'error', `false was reported as ${status.kind}`);
});

check('settle: mutate(true) reports saved', () => {
  assert(settleFrom(true).kind === 'saved', 'true should be saved');
});

log.push('');
log.push('=== settings surface ===');

const clientSource = readFileSync(join(HERE, 'client.js'), 'utf8');

check('surface: the page renders every surviving setting', () => {
  for (const field of FIELDS) {
    // Each control writes its field through `update({ <field>: ... })`.
    const writes = new RegExp(`update\\(\\{\\s*${field}\\s*:`).test(clientSource);
    assert(writes, `client.js does not write "${field}"`);
  }
});

check('surface: the page offers no control for a removed setting', () => {
  for (const field of REMOVED_FIELDS) {
    // `routes` appears as a substring of `deniedRoutes`, so match the whole
    // identifier in a write position to avoid a false positive.
    const writes = new RegExp(`update\\(\\{\\s*${field}\\s*:`).test(clientSource);
    assert(!writes, `client.js still writes the removed setting "${field}"`);
  }
});

check('surface: removed settings are absent as bare identifiers', () => {
  for (const field of REMOVED_FIELDS) {
    const mentioned = new RegExp(`\\b${field}\\b`).test(clientSource);
    assert(!mentioned, `client.js still mentions the removed setting "${field}"`);
  }
});

console.log(log.join('\n'));
console.log('');
console.log(failures === 0 ? `ALL PASS (${log.filter((l) => l.startsWith('PASS')).length} checks)` : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

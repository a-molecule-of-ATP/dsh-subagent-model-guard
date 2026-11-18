/**
 * Client-side checks for the save path, extracted from client.js's `Page`.
 *
 * The browser bundle cannot be imported here (no React DOM, no module loader),
 * so the two pieces that actually carry the bugs are re-implemented verbatim and
 * exercised against a fake `form`: the delta-to-ops projection (must never emit
 * `path: []`) and the `mutate` settlement (must never report success on `false`).
 */
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
  const base = { strict: true, routes: [] };
  assert(changedOps({ ...base }, base).length === 0, 'expected no ops');
});

check('delta: only changed fields are written, by narrow path', () => {
  const base = { strict: true, useOfficialAllowList: true, routes: [], cwd: true };
  const ops = changedOps({ ...base, strict: false }, base);
  assert(ops.length === 1, `expected 1 op, got ${ops.length}`);
  assert(ops[0].op === 'set', 'expected set');
  assert(JSON.stringify(ops[0].path) === '["strict"]', `bad path: ${JSON.stringify(ops[0].path)}`);
  assert(ops[0].value === false, 'bad value');
});

check('delta: never emits the whole-section path []', () => {
  const base = { strict: true, routes: [], cwd: true };
  const ops = changedOps({ strict: false, useOfficialAllowList: false, routes: [{ provider: 'a', model: 'b', note: '' }], cwd: false }, base);
  assert(ops.length > 0, 'expected ops');
  for (const op of ops) {
    assert(Array.isArray(op.path) && op.path.length === 1, `bad path depth: ${JSON.stringify(op.path)}`);
  }
});

check('delta: a removed field becomes unset, not undefined-valued set', () => {
  const base = { strict: true, routes: [] };
  const target = { strict: true };
  const ops = changedOps(target, base);
  assert(ops.length === 1 && ops[0].op === 'unset', `expected unset, got ${JSON.stringify(ops)}`);
  assert(JSON.stringify(ops[0].path) === '["routes"]', 'bad unset path');
});

check('delta: route edits are detected and scoped to routes', () => {
  const base = { routes: [{ provider: 'a', model: 'b', note: '' }] };
  const ops = changedOps({ routes: [{ provider: 'a', model: 'b', note: '' }, { provider: 'c', model: 'd', note: '' }] }, base);
  assert(ops.length === 1 && JSON.stringify(ops[0].path) === '["routes"]', 'routes op missing');
});

check('settle: mutate(false) must NOT report success', () => {
  const status = settleFrom(false);
  assert(status.kind === 'error', `false was reported as ${status.kind}`);
});

check('settle: mutate(true) reports saved', () => {
  assert(settleFrom(true).kind === 'saved', 'true should be saved');
});

console.log(log.join('\n'));
console.log('');
console.log(failures === 0 ? `ALL PASS (${log.filter((l) => l.startsWith('PASS')).length} checks)` : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

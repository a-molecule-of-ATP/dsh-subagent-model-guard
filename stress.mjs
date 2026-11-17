/**
 * Stress harness for the subagent-model-guard replacement tool.
 *
 * It fakes the parts of DSH the plugin touches (tools registry with scoped
 * shadowing, subagents service, sessions) and exercises the paths that a real
 * install would hit. Run with: node stress.mjs
 */
import { apply } from './index.js';

let failures = 0;
const log = [];
function check(name, fn) {
  try {
    const result = fn();
    if (result === false) throw new Error('assertion returned false');
    log.push(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    log.push(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function checkAsync(name, fn) {
  try {
    const result = await fn();
    if (result === false) throw new Error('assertion returned false');
    log.push(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    log.push(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed');
}
function assertThrows(fn, pattern) {
  try {
    const value = fn();
    if (value && typeof value.then === 'function') throw new Error('returned a promise');
    throw new Error('did not throw');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'did not throw') throw error;
    if (pattern && !pattern.test(message)) {
      throw new Error(`threw "${message}" which does not match ${pattern}`);
    }
  }
}
async function assertRejects(fn, pattern) {
  let threw = false;
  try {
    await fn();
  } catch (error) {
    threw = true;
    const message = error instanceof Error ? error.message : String(error);
    if (pattern && !pattern.test(message)) {
      throw new Error(`rejected with "${message}" which does not match ${pattern}`);
    }
  }
  if (!threw) throw new Error('did not reject');
}

// ── fake DSH environment ────────────────────────────────────────────────
function makeSession(provider, model) {
  return {
    header: { origin: 'subagent' },
    requestHeader: () => ({ config: { provider, model } }),
  };
}

function makeAgent(options = {}) {
  const { provider, model, origin } = options;
  const sessionOrigin = Object.hasOwn(options, 'origin') ? origin : 'subagent';
  const registrations = new Map();
  const restrictions = [];
  const scopeCtx = {
    tools: {
      restrict(filter) {
        restrictions.push(filter);
        return () => {};
      },
      register(definition) {
        registrations.set(definition.name, definition);
        return () => registrations.delete(definition.name);
      },
    },
  };
  return {
    registrations,
    restrictions,
    ctx: scopeCtx,
    options: provider !== undefined ? { provider, model } : {},
    session: {
      header: { origin: sessionOrigin },
      requestHeader: () => (provider ? { config: { provider, model } } : undefined),
    },
  };
}

function makeCtx({ routes, subagentCalls = [] } = {}) {
  const listeners = { 'agent/created': [], 'internal/get': [], 'tools/pre-execute': [], 'agent/pre-step': [] };
  const attempts = [];
  const subagents = {
    startActivation: async (spec) => {
      attempts.push(spec);
      subagentCalls.push(spec);
      return { name: spec.name ?? 'agent-1', childId: 'child-1', result: Promise.resolve('ok'), dispose: async () => {} };
    },
    resolveMaxDepth: () => 1,
  };
  const services = { subagents, agentPresets: {} };
  const ctx = {
    on(event, listener) {
      listeners[event].push(listener);
      return () => {};
    },
    get(name) {
      return services[name];
    },
    attempts,
    listeners,
    emitAgentCreated(agent) {
      for (const listener of listeners['agent/created']) listener({ agent });
    },
  };
  return ctx;
}

function config(overrides = {}) {
  return {
    routes: [
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      { provider: 'workbuddy', model: 'hy4flash-free' },
    ],
    enforcement: 'agent-created',
    replaceSubagentTool: true,
    checkInherited: true,
    strict: true,
    ...overrides,
  };
}

// ── scenarios ───────────────────────────────────────────────────────────
log.push('=== replacement tool ===');

await checkAsync('replacement: registers scoped subagent, denies global', async () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent);
  assert(agent.registrations.has('subagent'), 'no scoped subagent registered');
  const denied = agent.restrictions.flatMap((r) => r.deny ?? []);
  assert(denied.includes('subagent'), 'global subagent not denied');
});

await checkAsync('replacement: allowed explicit route reaches startActivation', async () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent);
  const tool = agent.registrations.get('subagent');
  const result = await tool.execute(
    { description: 'test', prompt: 'hi', provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    { agent, signal: { aborted: false } },
  );
  assert(result.kind === 'activation', 'kind not activation');
  const spec = ctx.attempts.at(-1);
  assert(spec.agentOptions.provider === 'workbuddy', 'provider not forwarded');
  assert(spec.agentOptions.model === 'deepseek-v4.1-flash', 'model not forwarded');
  assert(spec.delivery === 'parent', 'delivery must be parent');
  assert(spec.prompt[0].text === 'hi', 'prompt not forwarded');
});

await checkAsync('replacement: inherited route used when args omit provider/model', async () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent);
  const tool = agent.registrations.get('subagent');
  await tool.execute({ description: 'd', prompt: 'p' }, { agent, signal: {} });
  const spec = ctx.attempts.at(-1);
  assert(spec.agentOptions.model === 'hy4flash-free', 'inherited model wrong');
});

await checkAsync('replacement: rejects route outside allow-list', async () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent);
  const tool = agent.registrations.get('subagent');
  await assertRejects(
    () => tool.execute({ description: 'd', prompt: 'p', provider: 'workbuddy', model: 'deepseek-v4-pro' }, { agent, signal: {} }),
    /不在白名单/,
  );
  assert(ctx.attempts.length === 0, 'startActivation must not run on denial');
});

await checkAsync('replacement: rejects inherited route outside allow-list', async () => {
  // Gate A is off here so the REPLACEMENT tool's own check is what denies.
  const ctx = makeCtx();
  apply(ctx, config({ enforcement: 'start-activation' }));
  const agent = makeAgent({ provider: 'deepseek-account', model: 'deepseek-flash' });
  ctx.emitAgentCreated(agent);
  const tool = agent.registrations.get('subagent');
  await assertRejects(
    () => tool.execute({ description: 'd', prompt: 'p' }, { agent, signal: {} }),
    /不在白名单/,
  );
  assert(ctx.attempts.length === 0, 'startActivation must not run on denial');
});

await checkAsync('replacement: empty routes disables enforcement', async () => {
  const ctx = makeCtx();
  apply(ctx, config({ routes: [] }));
  const agent = makeAgent({ provider: 'deepseek-account', model: 'deepseek-flash' });
  ctx.emitAgentCreated(agent);
  const tool = agent.registrations.get('subagent');
  await tool.execute({ description: 'd', prompt: 'p', provider: 'any', model: 'any' }, { agent, signal: {} });
  assert(ctx.attempts.length === 1, 'should pass through when routes empty');
});

await checkAsync('replacement: empty prompt rejected', async () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent);
  const tool = agent.registrations.get('subagent');
  await assertRejects(() => tool.execute({ description: 'd', prompt: '' }, { agent, signal: {} }), /non-empty prompt/);
});

await checkAsync('replacement: half-specified pair rejected', async () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent);
  const tool = agent.registrations.get('subagent');
  await assertRejects(
    () => tool.execute({ description: 'd', prompt: 'p', model: 'deepseek-v4.1-flash' }, { agent, signal: {} }),
    /无法确定/,
  );
});

await checkAsync('replacement: reasoning_effort forwarded', async () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent);
  const tool = agent.registrations.get('subagent');
  await tool.execute(
    { description: 'd', prompt: 'p', provider: 'workbuddy', model: 'hy4flash-free', reasoning_effort: 'high' },
    { agent, signal: {} },
  );
  assert(ctx.attempts.at(-1).agentOptions.reasoningEffort === 'high', 'effort not forwarded');
});

await checkAsync('replacement: agent_preset forwarded', async () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent);
  const tool = agent.registrations.get('subagent');
  await tool.execute(
    { description: 'd', prompt: 'p', agent_preset: 'hub-agent-reviewer' },
    { agent, signal: {} },
  );
  assert(ctx.attempts.at(-1).agentPreset === 'hub-agent-reviewer', 'preset not forwarded');
});

await checkAsync('replacement: agent_preset without service fails loudly', async () => {
  const ctx = makeCtx();
  const original = ctx.get;
  ctx.get = (name) => (name === 'agentPresets' ? undefined : original(name));
  apply(ctx, config());
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent);
  const tool = agent.registrations.get('subagent');
  await assertRejects(
    () => tool.execute({ description: 'd', prompt: 'p', agent_preset: 'x' }, { agent, signal: {} }),
    /agent-presets/,
  );
});

await checkAsync('replacement: recursion — child gets its own tool', async () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const parent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(parent);
  // simulate the child agent DSH would create
  const child = makeAgent({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' });
  ctx.emitAgentCreated(child);
  assert(child.registrations.has('subagent'), 'child did not receive the replacement tool');
});

log.push('');
log.push('=== gate: agent/created (A) ===');

await check('gate A: denied route throws that fails creation', () => {
  const ctx = makeCtx();
  apply(ctx, config({ replaceSubagentTool: false }));
  const agent = makeAgent({ provider: 'workbuddy', model: 'deepseek-v4-pro' });
  assertThrows(() => ctx.emitAgentCreated(agent), /不在白名单/);
});

await check('gate A: allowed route passes', () => {
  const ctx = makeCtx();
  apply(ctx, config({ replaceSubagentTool: false }));
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent); // must not throw
});

await check('gate A: non-subagent sessions ignored', () => {
  const ctx = makeCtx();
  apply(ctx, config({ replaceSubagentTool: false }));
  const agent = makeAgent({ provider: 'other', model: 'other', origin: undefined });
  ctx.emitAgentCreated(agent); // root session, must not throw
});

await check('gate A: guard bug does not block delegation', () => {
  const ctx = makeCtx();
  apply(ctx, config({ replaceSubagentTool: false }));
  const agent = { session: { header: { origin: 'subagent' } }, get options() { throw new Error('boom'); } };
  ctx.emitAgentCreated(agent); // must swallow the internal error
});

log.push('');
log.push('=== gate: internal/get (B) ===');

await checkAsync('gate B: wraps startActivation and denies bad route', async () => {
  const ctx = makeCtx();
  apply(ctx, config({ enforcement: 'start-activation', replaceSubagentTool: false }));
  const listener = ctx.listeners['internal/get'][0];
  const proxy = listener({}, 'subagents', undefined, () => ctx.get('subagents'));
  const parent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  await assertRejects(
    () => proxy.startActivation({ provider: 'spawn', parent, agentOptions: { provider: 'workbuddy', model: 'evil' } }),
    /不在白名单/,
  );
});

await checkAsync('gate B: allows good route', async () => {
  const ctx = makeCtx();
  apply(ctx, config({ enforcement: 'start-activation', replaceSubagentTool: false }));
  const listener = ctx.listeners['internal/get'][0];
  const proxy = listener({}, 'subagents', undefined, () => ctx.get('subagents'));
  const parent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  const result = await proxy.startActivation({ provider: 'spawn', parent, agentOptions: { provider: 'workbuddy', model: 'hy4flash-free' } });
  assert(result.name === 'agent-1', 'activation result wrong');
});

await checkAsync('gate B: other services untouched', async () => {
  const ctx = makeCtx();
  apply(ctx, config({ enforcement: 'start-activation', replaceSubagentTool: false }));
  const listener = ctx.listeners['internal/get'][0];
  const other = { anything: true };
  const same = listener({}, 'llm', undefined, () => other);
  assert(same === other, 'non-subagents service was wrapped');
});

log.push('');
log.push('=== pre-execute UX layer ===');

await checkAsync('pre-execute: denies off-list explicit route', async () => {
  const ctx = makeCtx();
  apply(ctx, config({ replaceSubagentTool: false }));
  const listener = ctx.listeners['tools/pre-execute'][0];
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  const decision = await listener(
    { name: 'subagent', arguments: { provider: 'workbuddy', model: 'evil' }, agent },
    async () => ({ kind: 'allow' }),
  );
  assert(decision.kind === 'deny', 'should deny');
});

await checkAsync('pre-execute: passes allowed route', async () => {
  const ctx = makeCtx();
  apply(ctx, config({ replaceSubagentTool: false }));
  const listener = ctx.listeners['tools/pre-execute'][0];
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  const decision = await listener(
    { name: 'subagent', arguments: { provider: 'workbuddy', model: 'hy4flash-free' }, agent },
    async () => ({ kind: 'allow' }),
  );
  assert(decision.kind === 'allow', 'should allow');
});

await checkAsync('pre-execute: irrelevant tools pass', async () => {
  const ctx = makeCtx();
  apply(ctx, config({ replaceSubagentTool: false }));
  const listener = ctx.listeners['tools/pre-execute'][0];
  const decision = await listener({ name: 'ops_bash', arguments: {} }, async () => ({ kind: 'allow' }));
  assert(decision.kind === 'allow', 'should allow unrelated tool');
});

await checkAsync('pre-execute: disabled when replacement is active', async () => {
  const ctx = makeCtx();
  apply(ctx, config({ replaceSubagentTool: true }));
  const listener = ctx.listeners['tools/pre-execute'][0];
  const decision = await listener(
    { name: 'subagent', arguments: { provider: 'workbuddy', model: 'evil' }, agent: makeAgent() },
    async () => ({ kind: 'allow' }),
  );
  assert(decision.kind === 'allow', 'pre-execute should defer to the replacement tool');
});

await checkAsync('checkInherited:false skips inherited mismatch', async () => {
  const ctx = makeCtx();
  apply(ctx, config({ replaceSubagentTool: false, checkInherited: false }));
  const listener = ctx.listeners['tools/pre-execute'][0];
  const agent = makeAgent({ provider: 'deepseek-account', model: 'deepseek-flash' });
  const decision = await listener({ name: 'subagent', arguments: {}, agent }, async () => ({ kind: 'allow' }));
  assert(decision.kind === 'allow', 'inherited route should be skipped when checkInherited is false');
});

log.push('');
log.push('=== robustness ===');

await check('missing scope tools does not throw', () => {
  const ctx = makeCtx();
  apply(ctx, config());
  // No tool ctx AND no route info: the gate must be skipped for a session that
  // does not look like a subagent, not denied for lacking a route.
  ctx.emitAgentCreated({ session: { header: {} } });
  // A subagent with no route is still denied — that is the designed behaviour.
  assertThrows(() => ctx.emitAgentCreated({ session: { header: { origin: 'subagent' } } }), /无法确认/);
});

await check('strict:false disables everything', () => {
  const ctx = makeCtx();
  apply(ctx, config({ strict: false, replaceSubagentTool: false }));
  const agent = makeAgent({ provider: 'evil', model: 'evil' });
  ctx.emitAgentCreated(agent);
});

await check('register throwing is swallowed', () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const agent = {
    session: { header: { origin: 'subagent' }, requestHeader: () => undefined },
    options: { provider: 'workbuddy', model: 'hy4flash-free' },
    ctx: { tools: { restrict() { throw new Error('nope'); }, register() { throw new Error('nope'); } } },
  };
  ctx.emitAgentCreated(agent);
});

await check('catch-up: existing agents get the replacement tool', () => {
  const existing = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  const services = { agents: { list: () => [existing] } };
  const ctx = makeCtx();
  const originalGet = ctx.get;
  ctx.get = (name) => services[name] ?? originalGet(name);
  apply(ctx, config());
  assert(existing.registrations.has('subagent'), 'existing agent did not get the replacement');
});

await check('catch-up: agents.list throwing is swallowed', () => {
  const ctx = makeCtx();
  const originalGet = ctx.get;
  ctx.get = (name) => (name === 'agents' ? { list() { throw new Error('boom'); } } : originalGet(name));
  apply(ctx, config());
});

await check('audit: off-list step route is logged, not rejected', () => {
  const ctx = makeCtx();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    apply(ctx, config({ auditEveryStep: true }));
    const listener = ctx.listeners['agent/pre-step']?.[0];
    assert(listener !== undefined, 'no pre-step listener registered');
    const decision = listener({
      agent: { id: 'child-1' },
      modelSelection: { provider: 'workbuddy', model: 'evil' },
    });
    assert(decision === undefined, 'audit must not return a decision');
  } finally {
    console.warn = originalWarn;
  }
  assert(warnings.some((w) => w.includes('审计')), 'off-list route was not logged');
});

await check('audit: allowed step route stays silent', () => {
  const ctx = makeCtx();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    apply(ctx, config({ auditEveryStep: true }));
    const listener = ctx.listeners['agent/pre-step'][0];
    listener({ agent: { id: 'c' }, modelSelection: { provider: 'workbuddy', model: 'hy4flash-free' } });
  } finally {
    console.warn = originalWarn;
  }
  assert(!warnings.some((w) => w.includes('审计')), 'allowed route should not be logged');
});

await check('audit: not registered when disabled', () => {
  const ctx = makeCtx();
  apply(ctx, config({ auditEveryStep: false }));
  assert((ctx.listeners['agent/pre-step'] ?? []).length === 0, 'audit listener should not exist');
});

console.log(log.join('\n'));
console.log('');
console.log(failures === 0 ? `ALL PASS (${log.filter((l) => l.startsWith('PASS')).length} checks)` : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

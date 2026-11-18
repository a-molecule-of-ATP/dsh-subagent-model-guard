/**
 * Stress harness for the subagent-model-guard replacement tool.
 *
 * It fakes the parts of DSH the plugin touches (tools registry with scoped
 * shadowing, subagents service, sessions) and exercises the paths that a real
 * install would hit. Run with: node stress.mjs
 */
import { apply, Config } from './index.js';
import { updateVolatile } from '@deepseek-ai/cosmokit';

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
  const logs = [];
  const subagents = {
    startActivation: async (spec) => {
      attempts.push(spec);
      subagentCalls.push(spec);
      return { name: spec.name ?? 'agent-1', childId: 'child-1', result: Promise.resolve('ok'), dispose: async () => {} };
    },
    resolveMaxDepth: () => 1,
  };
  const services = { subagents, agentPresets: {} };
  // Global (non-scoped) tool registrations, e.g. the read-only guard_selfcheck.
  const globalRegistrations = new Map();
  const ctx = {
    on(event, listener) {
      listeners[event].push(listener);
      return () => {};
    },
    get(name) {
      return services[name];
    },
    tools: {
      register(definition) {
        // Mirror the registry's own contract: an `output` block without a
        // `schema` object is rejected in the Host ("unsupported JSON schema"),
        // so a fake registry that accepts it would hide the failure.
        const output = definition.output;
        if (output !== undefined) {
          if (output.schema === null || typeof output.schema !== 'object') {
            throw new Error(`JsonSchemaError: tool "${definition.name}" declares output without a schema object`);
          }
        }
        globalRegistrations.set(definition.name, definition);
        return () => globalRegistrations.delete(definition.name);
      },
    },
    logger: {
      warn(message) { logs.push(String(message)); },
    },
    attempts,
    listeners,
    logs,
    globalRegistrations,
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
await checkAsync('replacement: subagent_fork is NOT denied (only subagent is replaced)', async () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent);
  const denied = agent.restrictions.flatMap((r) => r.deny ?? []);
  assert(!denied.includes('subagent_fork'), 'subagent_fork must keep its official tool');
  assert(denied.includes('subagent'), 'official subagent should be masked');
});

await checkAsync('replacement: a throwing restrict() does not skip register', async () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  // Restrict throwing is exactly what an unknown global tool name does.
  agent.ctx.tools.restrict = () => { throw new Error('tools.restrict() names unknown global tool "subagent"'); };
  ctx.emitAgentCreated(agent);
  assert(agent.registrations.has('subagent'), 'register must run even when restrict throws');
});

await checkAsync('replacement: repeated agent/created is idempotent', async () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent);
  ctx.emitAgentCreated(agent);
  assert(agent.restrictions.length === 1, `restrict ran ${agent.restrictions.length} times`);
  assert(agent.registrations.has('subagent'), 'tool should still be registered');
});

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
log.push('=== official allow-list (subagentModelSelection) ===');

/** Install a fake `subagentModelSelection` service on a fresh ctx. */
function withOfficial(current, throwing) {
  const ctx = makeCtx();
  const originalGet = ctx.get;
  ctx.get = (name) => {
    if (name !== 'subagentModelSelection') return originalGet(name);
    return {
      current() {
        if (throwing !== undefined) throw new Error(throwing);
        return current;
      },
    };
  };
  return ctx;
}

await check('official: allowedModels are enforced without being in routes', () => {
  const ctx = withOfficial({ enabled: true, allowedModels: [{ provider: 'official', model: 'm1' }] });
  apply(ctx, config({ routes: [] }));
  // Only the official list is configured: the guard must be ACTIVE.
  assertThrows(() => ctx.emitAgentCreated(makeAgent({ provider: 'other', model: 'x' })), /不在白名单/);
  ctx.emitAgentCreated(makeAgent({ provider: 'official', model: 'm1' })); // allowed
});

await check('official: enabled=false means NO restriction from that list', () => {
  const ctx = withOfficial({ enabled: false, allowedModels: [{ provider: 'official', model: 'm1' }] });
  apply(ctx, config({ routes: [] }));
  // Disabled official list + empty routes => nothing to enforce => fail open.
  ctx.emitAgentCreated(makeAgent({ provider: 'other', model: 'x' }));
});

await check('official: enabled with empty list falls back to routes (current() throws)', () => {
  const ctx = withOfficial(undefined, 'enabled subagent model selection requires at least one allowed model');
  apply(ctx, config({ routes: [{ provider: 'workbuddy', model: 'hy4flash-free' }] }));
  ctx.emitAgentCreated(makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' }));
  assertThrows(() => ctx.emitAgentCreated(makeAgent({ provider: 'other', model: 'x' })), /不在白名单/);
});

await check('official: a throwing current() is logged once, not silently swallowed', () => {
  const ctx = withOfficial(undefined, 'boom');
  apply(ctx, config({ routes: [{ provider: 'workbuddy', model: 'hy4flash-free' }] }));
  ctx.emitAgentCreated(makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' }));
  ctx.emitAgentCreated(makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' }));
  const hits = ctx.logs.filter((line) => line.includes('读取官方子智能体白名单失败'));
  assert(hits.length === 1, `expected exactly one degradation log, got ${hits.length}`);
});

await check('official: missing service degrades to routes and warns once', () => {
  const ctx = makeCtx(); // no subagentModelSelection in services
  apply(ctx, config({ routes: [{ provider: 'workbuddy', model: 'hy4flash-free' }] }));
  ctx.emitAgentCreated(makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' }));
  assertThrows(() => ctx.emitAgentCreated(makeAgent({ provider: 'other', model: 'x' })), /不在白名单/);
  const hits = ctx.logs.filter((line) => line.includes('subagentModelSelection 服务不可用'));
  assert(hits.length === 1, `expected exactly one degradation log, got ${hits.length}`);
});

await check('official: useOfficialAllowList=false ignores the official list', () => {
  const ctx = withOfficial({ enabled: true, allowedModels: [{ provider: 'official', model: 'm1' }] });
  apply(ctx, config({ routes: [{ provider: 'workbuddy', model: 'hy4flash-free' }], useOfficialAllowList: false }));
  ctx.emitAgentCreated(makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' }));
  assertThrows(() => ctx.emitAgentCreated(makeAgent({ provider: 'official', model: 'm1' })), /不在白名单/);
});

await check('official: routes and official list merge without duplicates', () => {
  const ctx = withOfficial({ enabled: true, allowedModels: [{ provider: 'official', model: 'm1' }] });
  apply(ctx, config({ routes: [{ provider: 'official', model: 'm1' }, { provider: 'workbuddy', model: 'hy4flash-free' }] }));
  const agent = makeAgent({ provider: 'other', model: 'x' });
  try {
    ctx.emitAgentCreated(agent);
  } catch (error) {
    // The same route must appear exactly once in the allowed-list message.
    const count = (error.message.match(/official\/m1/g) ?? []).length;
    assert(count === 1, `duplicate route in allow-list message (${count})`);
    return;
  }
  throw new Error('off-list route should have been denied');
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
  // An unobservable route FAILS OPEN (external acp/SDK backends never expose a
  // local route), so this must not throw — it logs once instead.
  ctx.emitAgentCreated({ session: { header: { origin: 'subagent' } } });
  assert(ctx.logs.some((line) => line.includes('无法确认子智能体路由')), 'fail-open should be logged');
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

await checkAsync('audit: off-list step route is logged, and next() still runs', async () => {
  const ctx = makeCtx();
  apply(ctx, config({ auditEveryStep: true }));
  const listener = ctx.listeners['agent/pre-step']?.[0];
  assert(listener !== undefined, 'no pre-step listener registered');
  // `agent/pre-step` is a WATERFALL: returning without calling next() vetoes the
  // rest of the chain (including the built-in behaviour) and breaks every step.
  let nextCalls = 0;
  const decision = await listener(
    { agent: { id: 'child-1' }, modelSelection: { provider: 'workbuddy', model: 'evil' } },
    async () => {
      nextCalls += 1;
      return { kind: 'enter', messages: [] };
    },
  );
  assert(nextCalls === 1, 'audit must forward to next() exactly once');
  assert(decision?.kind === 'enter', 'audit must return the downstream decision');
  assert(ctx.logs.some((w) => w.includes('审计')), 'off-list route was not logged');
});

await checkAsync('audit: allowed step route stays silent', async () => {
  const ctx = makeCtx();
  apply(ctx, config({ auditEveryStep: true }));
  const listener = ctx.listeners['agent/pre-step'][0];
  let nextCalls = 0;
  await listener(
    { agent: { id: 'c' }, modelSelection: { provider: 'workbuddy', model: 'hy4flash-free' } },
    async () => {
      nextCalls += 1;
      return { kind: 'enter', messages: [] };
    },
  );
  assert(nextCalls === 1, 'allowed route must still forward');
  assert(!ctx.logs.some((w) => w.includes('审计')), 'allowed route should not be logged');
});

await checkAsync('audit: disabled flag forwards without logging', async () => {
  const ctx = makeCtx();
  apply(ctx, config({ auditEveryStep: false }));
  // Registered unconditionally now (a settings write does not re-run apply, so
  // registration cannot be the gate); the FLAG decides at dispatch time.
  const listener = ctx.listeners['agent/pre-step'][0];
  assert(listener !== undefined, 'listener should always be registered');
  let nextCalls = 0;
  await listener(
    { agent: { id: 'c' }, modelSelection: { provider: 'workbuddy', model: 'evil' } },
    async () => {
      nextCalls += 1;
      return { kind: 'enter', messages: [] };
    },
  );
  assert(nextCalls === 1, 'disabled audit must still forward');
  assert(!ctx.logs.some((w) => w.includes('审计')), 'disabled audit must not log');
});

log.push('=== live volatile config (no re-apply) ===');

/** Parse a real Config so the fields are genuine volatile refs. */
function parsedConfig(overrides = {}) {
  return Config({ routes: [{ provider: 'workbuddy', model: 'hy4flash-free' }], ...overrides });
}

await check('live: a volatile write flips strict without re-running apply', () => {
  const parsed = parsedConfig({ strict: true });
  const ctx = makeCtx();
  apply(ctx, parsed);
  const bad = () => makeAgent({ provider: 'zzz', model: 'zzz' });
  assertThrows(() => ctx.emitAgentCreated(bad()), /不在白名单/);
  // This is exactly what the loader does for a settings write: it mutates the
  // ref in place and does NOT re-run apply. A value captured in apply would
  // still say `true` here.
  updateVolatile(parsed.strict, parsedConfig({ strict: false }).strict);
  ctx.emitAgentCreated(bad()); // must now pass
  updateVolatile(parsed.strict, parsedConfig({ strict: true }).strict);
  assertThrows(() => ctx.emitAgentCreated(bad()), /不在白名单/);
});

await check('live: a volatile write to routes takes effect', () => {
  const parsed = parsedConfig();
  const ctx = makeCtx();
  apply(ctx, parsed);
  ctx.emitAgentCreated(makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' }));
  updateVolatile(parsed.routes, parsedConfig({ routes: [{ provider: 'other', model: 'm' }] }).routes);
  assertThrows(
    () => ctx.emitAgentCreated(makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' })),
    /不在白名单/,
  );
  ctx.emitAgentCreated(makeAgent({ provider: 'other', model: 'm' }));
});

log.push('=== settings projection ===');

await check('volatileForm(Config) is not undefined (entry survives describe())', async () => {
  // dsh-settings drops any entry whose volatileForm is undefined; that is what
  // made the whole Configuration page unreachable before.
  const { volatileForm } = await import('./volatile-form.mjs');
  const form = volatileForm(Config);
  assert(form !== undefined, 'Config has no volatile field — the settings entry is dropped');
  const fields = Object.keys(form.dict ?? {}).sort();
  const expected = ['auditEveryStep', 'checkInherited', 'deniedRoutes', 'enforcement', 'includeAllowedListInError', 'maxDepth', 'recentDenialLimit', 'replaceSubagentTool', 'routes', 'strict', 'useOfficialAllowList'];
  assert(
    JSON.stringify(fields) === JSON.stringify(expected.sort()),
    `projected fields mismatch: ${fields.join(',')}`,
  );
});

log.push('=== deniedRoutes (blacklist) ===');

await check('deny: a denied route is refused even when also allow-listed', () => {
  const ctx = makeCtx();
  apply(ctx, config({
    routes: [{ provider: 'workbuddy', model: 'hy4flash-free' }],
    deniedRoutes: [{ provider: 'workbuddy', model: 'hy4flash-free' }],
  }));
  // Explicit denial outranks the allow-list.
  assertThrows(
    () => ctx.emitAgentCreated(makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' })),
    /被显式拒绝/,
  );
});

await check('deny: a denied route is refused even when the official list allows it', () => {
  const ctx = makeCtx();
  const originalGet = ctx.get;
  ctx.get = (name) => (name === 'subagentModelSelection'
    ? { current: () => ({ enabled: true, allowedModels: [{ provider: 'official', model: 'm1' }] }) }
    : originalGet(name));
  apply(ctx, config({ routes: [], deniedRoutes: [{ provider: 'official', model: 'm1' }] }));
  assertThrows(() => ctx.emitAgentCreated(makeAgent({ provider: 'official', model: 'm1' })), /被显式拒绝/);
});

await check('deny: the message distinguishes denial from a plain miss', () => {
  const ctx = makeCtx();
  apply(ctx, config({
    routes: [{ provider: 'workbuddy', model: 'hy4flash-free' }],
    deniedRoutes: [{ provider: 'bad', model: 'x' }],
  }));
  let deniedMessage = '';
  try { ctx.emitAgentCreated(makeAgent({ provider: 'bad', model: 'x' })); } catch (e) { deniedMessage = e.message; }
  let missMessage = '';
  try { ctx.emitAgentCreated(makeAgent({ provider: 'other', model: 'y' })); } catch (e) { missMessage = e.message; }
  assert(deniedMessage.includes('被显式拒绝'), `denied message wrong: ${deniedMessage}`);
  assert(missMessage.includes('不在白名单'), `miss message wrong: ${missMessage}`);
  assert(!missMessage.includes('被显式拒绝'), 'a plain miss must not claim a denial');
});

await check('deny: a deny-only configuration still enforces', () => {
  const ctx = makeCtx();
  // No allow-list at all — only a blacklist. This is a valid "deny these" policy.
  apply(ctx, config({ routes: [], deniedRoutes: [{ provider: 'bad', model: 'x' }] }));
  assertThrows(() => ctx.emitAgentCreated(makeAgent({ provider: 'bad', model: 'x' })), /被显式拒绝/);
  // Everything else passes, because no allow-list restricts it.
  ctx.emitAgentCreated(makeAgent({ provider: 'other', model: 'y' }));
});

await check('deny: empty deniedRoutes leaves the allow-list semantics intact', () => {
  const ctx = makeCtx();
  apply(ctx, config({ routes: [{ provider: 'workbuddy', model: 'hy4flash-free' }] }));
  ctx.emitAgentCreated(makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' }));
  assertThrows(() => ctx.emitAgentCreated(makeAgent({ provider: 'other', model: 'y' })), /不在白名单/);
});

log.push('');
log.push('=== includeAllowedListInError ===');

await check('allow-list in error: on by default', () => {
  const ctx = makeCtx();
  apply(ctx, config({ routes: [{ provider: 'workbuddy', model: 'hy4flash-free' }] }));
  let message = '';
  try { ctx.emitAgentCreated(makeAgent({ provider: 'other', model: 'y' })); } catch (e) { message = e.message; }
  assert(message.includes('允许：'), 'allow-list should be listed by default');
  assert(message.includes('workbuddy/hy4flash-free'), 'allow-list contents missing');
});

await check('allow-list in error: off hides every other model name', () => {
  const ctx = makeCtx();
  apply(ctx, config({
    routes: [{ provider: 'workbuddy', model: 'hy4flash-free' }],
    includeAllowedListInError: false,
  }));
  let message = '';
  try { ctx.emitAgentCreated(makeAgent({ provider: 'other', model: 'y' })); } catch (e) { message = e.message; }
  assert(!message.includes('允许：'), `allow-list leaked: ${message}`);
  assert(!message.includes('hy4flash-free'), `another model name leaked: ${message}`);
  assert(message.includes('other/y'), 'the attempted route must still be named');
});

log.push('');
log.push('=== maxDepth ===');

await check('maxDepth: unset keeps the deployment default', () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent);
  return agent.registrations.get('subagent').execute(
    { description: 'd', prompt: 'p' }, { agent, signal: {} },
  ).then(() => {
    // makeCtx's resolveMaxDepth(undefined) returns 1.
    assert(ctx.attempts.at(-1).maxDepth === 1, 'should fall back to resolveMaxDepth');
  });
});

await check('maxDepth: a configured depth overrides the deployment default', () => {
  const ctx = makeCtx();
  apply(ctx, config({ maxDepth: 3 }));
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent);
  return agent.registrations.get('subagent').execute(
    { description: 'd', prompt: 'p' }, { agent, signal: {} },
  ).then(() => {
    assert(ctx.attempts.at(-1).maxDepth === 3, `expected 3, got ${ctx.attempts.at(-1).maxDepth}`);
  });
});

await check('maxDepth: null is treated as unset, never 0', () => {
  const ctx = makeCtx();
  apply(ctx, config({ maxDepth: null }));
  const agent = makeAgent({ provider: 'workbuddy', model: 'hy4flash-free' });
  ctx.emitAgentCreated(agent);
  return agent.registrations.get('subagent').execute(
    { description: 'd', prompt: 'p' }, { agent, signal: {} },
  ).then(() => {
    assert(ctx.attempts.at(-1).maxDepth === 1, 'null must fall back, not clamp to 0');
  });
});

log.push('');
log.push('=== guard_selfcheck (read-only) ===');

/** Fetch the globally registered selfcheck tool from a ctx. */
function selfcheckOf(ctx) {
  return ctx.globalRegistrations.get('guard_selfcheck');
}

await checkAsync('selfcheck: tool is registered globally with no parameters', async () => {
  const ctx = makeCtx();
  apply(ctx, config());
  const tool = selfcheckOf(ctx);
  assert(tool !== undefined, 'guard_selfcheck was not registered globally');
  assert(Object.keys(tool.parameters.properties).length === 0, 'selfcheck must take no params');
  assert(/只读/.test(tool.description) && /不改任何状态/.test(tool.description),
    'description must state it is read-only and changes no state');
});

await checkAsync('selfcheck: returns full shape and reflects live config', async () => {
  const ctx = makeCtx();
  apply(ctx, config({
    routes: [{ provider: 'workbuddy', model: 'hy4flash-free' }],
    deniedRoutes: [{ provider: 'bad', model: 'x' }],
    enforcement: 'both',
    replaceSubagentTool: true,
  }));
  const tool = selfcheckOf(ctx);
  const report = await tool.execute();
  assert(typeof report.active === 'boolean', 'active must be boolean');
  assert(typeof report.strict === 'boolean', 'strict must be boolean');
  assert(report.enforcement === 'both', 'enforcement must be both');
  assert(typeof report.officialAllowList.available === 'boolean', 'officialAllowList.available must be boolean');
  assert(Array.isArray(report.ownRoutes), 'ownRoutes must be array');
  assert(Array.isArray(report.deniedRoutes), 'deniedRoutes must be array');
  assert(report.deniedRoutes.length === 1 && report.deniedRoutes[0].provider === 'bad', 'deniedRoutes content wrong');
  assert(typeof report.effectiveRouteCount === 'number', 'effectiveRouteCount must be number');
  assert(report.gates.agentCreated === true && report.gates.startActivation === true, 'both gates should be on');
  assert(report.replacement.installed === false, 'replacement not installed until an agent is created');
  assert(typeof report.recentDenials === 'number', 'recentDenials must be number');
  assert(Array.isArray(report.checks) && report.checks.length > 0, 'checks must be a non-empty array');
  for (const c of report.checks) {
    assert(typeof c.name === 'string' && typeof c.ok === 'boolean' && 'detail' in c && 'hint' in c,
      `malformed check entry: ${JSON.stringify(c)}`);
  }
});

await checkAsync('selfcheck: service unavailable -> available:false, error set, NO throw', async () => {
  const ctx = makeCtx(); // no subagentModelSelection service
  apply(ctx, config({ routes: [{ provider: 'workbuddy', model: 'hy4flash-free' }] }));
  const tool = selfcheckOf(ctx);
  let report;
  try {
    report = await tool.execute(); // must not throw
  } catch (error) {
    throw new Error(`selfcheck threw when service unavailable: ${error.message}`);
  }
  assert(report.officialAllowList.available === false, 'available must be false when service missing');
  assert(typeof report.officialAllowList.error === 'string' && report.officialAllowList.error.length > 0,
    'error must be set when service missing');
  assert(report.officialAllowList.routes.length === 0, 'routes must be empty when service missing');
});

await checkAsync('selfcheck: official enabled=false -> no error, routes empty, NO throw', async () => {
  const ctx = withOfficial({ enabled: false, allowedModels: [{ provider: 'official', model: 'm1' }] });
  apply(ctx, config({ routes: [] }));
  const tool = selfcheckOf(ctx);
  let report;
  try {
    report = await tool.execute();
  } catch (error) {
    throw new Error(`selfcheck threw on enabled=false: ${error.message}`);
  }
  assert(report.officialAllowList.available === true, 'service exists -> available true');
  assert(report.officialAllowList.enabled === false, 'enabled must mirror official false');
  assert(report.officialAllowList.error === undefined, 'enabled=false is normal: must NOT set error');
  assert(report.officialAllowList.routes.length === 0, 'routes must be empty when disabled');
});

await checkAsync('selfcheck: official enabled but empty (current() throws) -> error set', async () => {
  const ctx = withOfficial(undefined, 'enabled subagent model selection requires at least one allowed model');
  apply(ctx, config({ routes: [{ provider: 'workbuddy', model: 'hy4flash-free' }] }));
  const tool = selfcheckOf(ctx);
  let report;
  try {
    report = await tool.execute(); // must not throw
  } catch (error) {
    throw new Error(`selfcheck threw on current() failure: ${error.message}`);
  }
  assert(report.officialAllowList.available === true, 'service exists -> available true');
  assert(typeof report.officialAllowList.error === 'string' && /current\(\)/.test(report.officialAllowList.error),
    'error must capture the current() throw');
  assert(report.officialAllowList.routes.length === 0, 'routes must be empty when current() throws');
});

await checkAsync('selfcheck: three error categories are distinguishable', async () => {
  // build the three reports
  const ctxMissing = makeCtx();
  apply(ctxMissing, config());
  const rMissing = await selfcheckOf(ctxMissing).execute();

  const ctxDisabled = withOfficial({ enabled: false, allowedModels: [] });
  apply(ctxDisabled, config());
  const rDisabled = await selfcheckOf(ctxDisabled).execute();

  const ctxThrowing = withOfficial(undefined, 'empty list');
  apply(ctxThrowing, config());
  const rThrowing = await selfcheckOf(ctxThrowing).execute();

  assert(rMissing.officialAllowList.available === false && rMissing.officialAllowList.error, 'category 1: unavailable');
  assert(rDisabled.officialAllowList.available === true && rDisabled.officialAllowList.enabled === false
    && rDisabled.officialAllowList.error === undefined, 'category 2: disabled is not an error');
  assert(rThrowing.officialAllowList.available === true && rThrowing.officialAllowList.error, 'category 3: current() throw');
});

await checkAsync('selfcheck: never throws even when get()/logger are hostile', async () => {
  const ctx = makeCtx();
  ctx.get = () => { throw new Error('get exploded'); };
  ctx.logger = { warn() { throw new Error('logger exploded'); } };
  apply(ctx, config());
  const tool = selfcheckOf(ctx);
  let report;
  try {
    report = await tool.execute();
  } catch (error) {
    throw new Error(`selfcheck must never throw: ${error.message}`);
  }
  assert(report && Array.isArray(report.checks), 'report shape must survive hostile env');
});

console.log(log.join('\n'));
console.log('');
console.log(failures === 0 ? `ALL PASS (${log.filter((l) => l.startsWith('PASS')).length} checks)` : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

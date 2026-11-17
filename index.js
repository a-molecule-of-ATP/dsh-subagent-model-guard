/**
 * Subagent route guard.
 *
 * Two independent parts:
 *
 * 1. **Gate** (`enforcement`) — validate the route a child will actually run on
 *    at `agent/created` (A) and/or by wrapping `ctx.subagents` (B). Covers the
 *    `subagent` tool AND workflow's `agent()`, which bypasses the tool layer.
 *
 * 2. **Replacement** (`replaceSubagentTool`) — shadow the official `subagent`
 *    tool with our own, which calls `ctx.subagents.startActivation()` directly.
 *    The official tool validates against a session-frozen allow-list BEFORE
 *    `agent/created`, so a newly published model can never be used in an old
 *    session through it. The direct route has no such check.
 *
 * An empty `routes` list disables enforcement, matching DSH's native behaviour.
 */
import Schema from '@deepseek-ai/schemastery';

export const name = 'subagent-model-guard';

export const inject = ['tools'];

/** Tool names the gate observes and the replacement shadows. */
const DELEGATION_TOOLS = ['subagent', 'subagent_fork'];

/** Session origin that marks a subagent child (`parentSession` alone is not proof). */
const SUBAGENT_ORIGIN = 'subagent';

export const Config = Schema.object({
  routes: Schema.array(Schema.object({
    provider: Schema.string().required(),
    model: Schema.string().required(),
    note: Schema.string(),
  })).default([])
    .description('允许子智能体使用的 provider/model，精确匹配。为空表示不拦截。'),

  enforcement: Schema.union([
    Schema.const('agent-created'),
    Schema.const('start-activation'),
    Schema.const('both'),
  ]).default('agent-created')
    .description(
      'agent-created：在 agent/created 处校验，契约稳定、覆盖 workflow；被拒会留下一个空 session 记录。'
      + 'start-activation：包住 ctx.subagents，在 agent 构造前拒绝，零残留；依赖 internal/get。'
      + 'both：两处都校验。',
    ),

  replaceSubagentTool: Schema.boolean().default(false)
    .description(
      '用本插件实现的 subagent 取代官方工具（scoped shadow）。'
      + '开启后子智能体直接走 startActivation，绕开 DSH 的会话模型快照，新上架的模型立即可用。'
      + '关闭则保留官方工具（受快照限制）。',
    ),

  cwd: Schema.boolean().default(true)
    .description('替换工具时是否接受 cwd 参数。'),

  checkInherited: Schema.boolean().default(true)
    .description('是否检查「省略模型、回退父级」的继承路径。'),

  auditEveryStep: Schema.boolean().default(false)
    .description('在每一步模型调用时检查路由是否在白名单内，只记录不拦截。'
      + '走到这一步说明创建阶段的校验已漏网（例如子智能体运行中被切了模型），'
      + '此时拒绝会让它"创建成功但立刻失败"，所以只写 host 日志留痕。'),

  strict: Schema.boolean().default(true)
    .description('关闭后整段守卫失效。'),
}).description('子智能体路由守卫：白名单 + 可选的官方工具替换。');

function routeKey(provider, model) {
  return `${provider}/${model}`;
}

/**
 * Read a route field that may be a plain value, a getter, or a volatile ref.
 * `agent.options` documents "live accessors apply until the Session records a
 * selection", so a plain property read is not enough.
 */
function routeValue(value) {
  let out = value;
  if (typeof out === 'function') {
    try {
      out = out();
    } catch {
      return undefined;
    }
  }
  if (out !== null && typeof out === 'object' && typeof out.get === 'function') {
    try {
      out = out.get();
    } catch {
      return undefined;
    }
  }
  return typeof out === 'string' && out !== '' ? out : undefined;
}

/** The route a Session currently runs on, from its newest request header. */
function sessionRoute(session) {
  if (!session || typeof session.requestHeader !== 'function') return undefined;
  let header;
  try {
    header = session.requestHeader();
  } catch {
    return undefined;
  }
  const config = header?.config;
  if (!config) return undefined;
  const provider = routeValue(config.provider);
  const model = routeValue(config.model);
  if (provider === undefined || model === undefined) return undefined;
  return { provider, model };
}

/** The route an Agent was created with (already merged: explicit + inherited). */
function agentRoute(agent) {
  const options = agent?.options;
  if (!options || typeof options !== 'object') return undefined;
  const provider = routeValue(options.provider);
  const model = routeValue(options.model);
  if (provider === undefined || model === undefined) return undefined;
  return { provider, model };
}

function describeRoutes(routes) {
  return routes.map((route) => (route.note
    ? `${routeKey(route.provider, route.model)}（${route.note}）`
    : routeKey(route.provider, route.model))).join('、');
}

function denial(message) {
  return Object.assign(new Error(`[subagent-model-guard] ${message}`), { guardDenial: true });
}

function warn(context, error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    console.warn(`[subagent-model-guard] ${context}：${message}`);
  } catch {
    // A logger that throws must never fail a delegation.
  }
}

/**
 * Resolve the route a delegation would run on.
 * Explicit arguments win; otherwise the parent's current route is inherited.
 */
function resolveDelegationRoute(args, parent) {
  const explicitProvider = routeValue(args?.provider);
  const explicitModel = routeValue(args?.model);
  if (explicitProvider !== undefined && explicitModel !== undefined) {
    return { provider: explicitProvider, model: explicitModel, explicit: true };
  }
  if (explicitModel !== undefined || explicitProvider !== undefined) {
    return undefined; // a half-specified pair cannot be resolved here
  }
  const inherited = sessionRoute(parent?.session) ?? agentRoute(parent);
  return inherited === undefined ? undefined : { ...inherited, explicit: false };
}

/**
 * @param ctx - plugin context.
 * @param config - see {@link Config}.
 */
export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {};
  const routes = Array.isArray(settings.routes) ? settings.routes : [];
  const rules = routes.filter((route) => route && typeof route.provider === 'string'
    && typeof route.model === 'string' && route.provider !== '' && route.model !== '');
  const keys = new Set(rules.map((route) => routeKey(route.provider, route.model)));
  const strict = settings.strict !== false;
  const checkInherited = settings.checkInherited !== false;
  const enforcement = typeof settings.enforcement === 'string' ? settings.enforcement : 'agent-created';
  const useGateA = enforcement === 'agent-created' || enforcement === 'both';
  const useGateB = enforcement === 'start-activation' || enforcement === 'both';
  const replaceTool = settings.replaceSubagentTool === true;
  const acceptCwd = settings.cwd !== false;
  const auditEveryStep = settings.auditEveryStep === true;
  const active = strict && keys.size > 0;
  const allow = (route) => keys.has(routeKey(route.provider, route.model));

  // ── Gate A: agent/created ──────────────────────────────────────────────
  if (useGateA) {
    ctx.on('agent/created', ({ agent }) => {
      if (!active) return;
      try {
        if (agent?.session?.header?.origin !== SUBAGENT_ORIGIN) return;
        const route = agentRoute(agent);
        if (route === undefined) {
          throw denial('无法确认子智能体路由（provider/model 缺失），拒绝启动。');
        }
        if (!allow(route)) {
          throw denial(`拒绝创建子智能体：${routeKey(route.provider, route.model)} 不在白名单内`
            + `（允许：${describeRoutes(rules)}）。`);
        }
      } catch (error) {
        // A guard bug must never block delegation; a denial must.
        if (error && error.guardDenial === true) throw error;
        warn('agent/created 闸门内部错误，放行', error);
      }
    }, { prepend: true });
  }

  // ── Gate B: wrap ctx.subagents ────────────────────────────────────────
  if (useGateB) {
    const proxies = new WeakMap();
    ctx.on('internal/get', (caller, serviceName, error, next) => {
      const service = next();
      if (!active) return service;
      if (serviceName !== 'subagents' || !service || typeof service.startActivation !== 'function') {
        return service;
      }
      const cached = proxies.get(service);
      if (cached !== undefined) return cached;
      let proxy;
      try {
        proxy = new Proxy(service, {
          get(target, prop, receiver) {
            if (prop !== 'startActivation') {
              const value = Reflect.get(target, prop, target);
              return typeof value === 'function' ? value.bind(target) : value;
            }
            return async (spec) => {
              const explicit = spec?.agentOptions;
              const explicitProvider = routeValue(explicit?.provider);
              const explicitModel = routeValue(explicit?.model);
              let route;
              if (explicitProvider !== undefined && explicitModel !== undefined) {
                route = { provider: explicitProvider, model: explicitModel };
              } else {
                route = sessionRoute(spec?.parent?.session) ?? agentRoute(spec?.parent);
              }
              if (route !== undefined && !allow(route)) {
                throw denial(`${routeKey(route.provider, route.model)} 不在白名单内`
                  + `（允许：${describeRoutes(rules)}）。`);
              }
              return Reflect.apply(target.startActivation, target, [spec]);
            };
          },
        });
      } catch (error) {
        warn('无法包装 subagents 服务，跳过 start-activation 闸门', error);
        return service;
      }
      proxies.set(service, proxy);
      return proxy;
    });
  }

  // ── Replacement: our own subagent tool ────────────────────────────────
  if (replaceTool) {
    const toolParameters = {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the delegated task, for display. Use the language of the user\'s current request.',
        },
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.',
        },
        name: {
          type: 'string',
          description: 'Optional short name, unique among the subagents you create: lower-case letters, digits, and hyphens, starting with a letter, at most 32 characters.',
        },
        ...(acceptCwd ? {
          cwd: {
            type: 'string',
            description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
          },
        } : {}),
        provider: {
          type: 'string',
          description: 'Child LLM provider id; requires `model`.',
        },
        model: {
          type: 'string',
          description: 'Model id within that provider; requires `provider`.',
        },
        reasoning_effort: {
          type: 'string',
          description: 'Reasoning effort id; requires `provider` and `model`.',
        },
        agent_preset: {
          type: 'string',
          description: 'Agent preset for this child. Omit to inherit the parent agent\'s current preset.',
        },
      },
      required: ['description', 'prompt'],
    };

    const toolDescription =
      'Create an independently managed subagent and immediately return its name. '
      + 'If you are still online when it finishes, the runtime automatically delivers its completion notice. '
      + 'Use `send_message` to steer it while running or continue its conversation after it finishes. '
      + 'Pass `provider` and `model` to choose the child LLM route explicitly; omit both to inherit this conversation\'s route.';

    const registerReplacement = (agent) => {
      const scoped = agent?.ctx;
      if (!scoped || !scoped.tools || typeof scoped.tools.register !== 'function') return;
      try {
        // The official tool is a GLOBAL registration; deny it for this scope and
        // register our own — scoped registrations shadow globals and are exempt
        // from the restriction above them.
        if (typeof scoped.tools.restrict === 'function') {
          scoped.tools.restrict({ deny: DELEGATION_TOOLS });
        }
        scoped.tools.register({
          name: 'subagent',
          description: toolDescription,
          parameters: toolParameters,
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string' },
                name: { type: 'string' },
              },
              required: ['kind', 'name'],
            },
            render: (_args, value) => [{
              type: 'text',
              text: value && value.name ? `已启动子智能体：${value.name}（完成后会通知本会话）` : '已启动子智能体',
            }],
          },
          async execute(args, exec) {
            const parent = exec?.agent;
            if (!parent) throw new Error('subagent tool requires a calling agent');
            const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
            if (prompt === '') throw new Error('subagent requires a non-empty prompt');

            const route = resolveDelegationRoute(args, parent);
            if (route === undefined) {
              throw denial('无法确定子智能体路由：请显式提供 provider 与 model。');
            }
            if (active && !allow(route)) {
              throw denial(`${routeKey(route.provider, route.model)} 不在白名单内`
                + `（允许：${describeRoutes(rules)}）。`);
            }

            const subagents = ctx.get('subagents');
            if (!subagents || typeof subagents.startActivation !== 'function') {
              throw new Error('subagents 服务不可用');
            }

            let agentPreset;
            if (typeof args?.agent_preset === 'string' && args.agent_preset !== '') {
              const presets = ctx.get('agentPresets');
              if (!presets) throw new Error('agent_preset 需要 agent-presets 服务');
              agentPreset = args.agent_preset;
            }

            const agentOptions = { provider: route.provider, model: route.model };
            const effort = routeValue(args?.reasoning_effort);
            if (effort !== undefined) agentOptions.reasoningEffort = effort;

            const started = await subagents.startActivation({
              provider: 'spawn',
              label: typeof args?.description === 'string' && args.description !== ''
                ? args.description
                : 'subagent',
              ...(typeof args?.name === 'string' && args.name !== '' ? { name: args.name } : {}),
              ...(acceptCwd && typeof args?.cwd === 'string' && args.cwd !== '' ? { cwd: args.cwd } : {}),
              prompt: [{ type: 'text', text: prompt }],
              parent,
              agentOptions,
              ...(agentPreset !== undefined ? { agentPreset } : {}),
              maxDepth: subagents.resolveMaxDepth(undefined),
              signal: exec.signal,
              delivery: 'parent',
            });
            return { kind: 'activation', name: started.name };
          },
        });
      } catch (error) {
        warn('注册替换用的 subagent 工具失败', error);
      }
    };

    if (typeof ctx.on === 'function') {
      ctx.on('agent/created', ({ agent }) => {
        try {
          registerReplacement(agent);
        } catch (error) {
          warn('替换 subagent 工具时出错', error);
        }
      }, { prepend: true });
    }

    // `agent/created` only fires for NEW agents, so the session that loaded this
    // plugin would keep the official tool until it restarts. Migrate the agents
    // that already exist (the same catch-up the permission presets do).
    try {
      const agents = ctx.get('agents');
      const live = typeof agents?.list === 'function' ? agents.list() : [];
      for (const agent of live) {
        try {
          registerReplacement(agent);
        } catch (error) {
          warn(`补齐已有 agent 的替换工具失败（${agent?.id ?? '?'}）`, error);
        }
      }
    } catch (error) {
      warn('枚举已有 agent 失败，当前会话仍用官方 subagent 工具', error);
    }
  }

  // ── Optional audit: record off-list routes on every step ──────────────
  if (auditEveryStep) {
    ctx.on('agent/pre-step', (payload) => {
      if (!active) return;
      try {
        const selection = payload?.modelSelection;
        const provider = routeValue(selection?.provider);
        const model = routeValue(selection?.model);
        if (provider === undefined || model === undefined) return;
        if (allow({ provider, model })) return;
        // Deliberately NOT a rejection: by this point the child already exists,
        // so declining would surface as `stopReason: 'refusal'` with no reason.
        warn(
          `审计：白名单外调用 ${routeKey(provider, model)}`
          + `（agent ${String(payload?.agent?.id ?? '?')}，允许：${describeRoutes(rules)}）`,
        );
      } catch (error) {
        warn('审计钩子内部错误', error);
      }
    });
  }

  // ── Pre-execute UX layer: readable errors for the official tool ───────
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!strict) return next();
    const toolName = String(exec?.name ?? '');
    if (!DELEGATION_TOOLS.includes(toolName)) return next();
    if (!active || replaceTool) return next();
    let route;
    try {
      route = resolveDelegationRoute(exec?.arguments, exec?.agent);
    } catch (error) {
      warn('pre-execute 解析路由失败，放行', error);
      return next();
    }
    if (route === undefined) return next();
    if (!route.explicit && !checkInherited) return next();
    if (allow(route)) return next();
    return {
      kind: 'deny',
      reason: `路由 ${routeKey(route.provider, route.model)} 不在子智能体白名单内`
        + `（允许：${describeRoutes(rules)}）。`
        + (route.explicit
          ? '请改用白名单内的 provider/model。'
          : '请显式提供白名单内的 provider 与 model，或换一个父级模型。'),
      info: { name: 'subagent-model-guard', code: 'route-not-allowed' },
    };
  });
}

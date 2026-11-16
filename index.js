/**
 * Route guard for subagent delegation.
 *
 * DSH only validates the child allow-list when a call names `provider` and
 * `model` explicitly. A call that omits them falls back to the parent route
 * without a check, so delegation can silently run a model the profile never
 * allowed — the exact gap this plugin closes.
 *
 * Modelled on dsh-subagent-hub's route guard:
 * - a non-empty `routes` list is the allow-list;
 * - explicit `provider`/`model` must be in it;
 * - an omitted route inherits the parent's route, which must also be in it
 *   (refused when it cannot be confirmed);
 * - a named role may narrow the route it is allowed to run on.
 *
 * An empty `routes` list keeps the native behaviour (nothing is enforced),
 * matching the hub's "empty list keeps native inheritance" rule.
 */
import Schema from '@deepseek-ai/schemastery';

export const name = 'subagent-model-guard';

/** Only the tool registry is required. */
export const inject = ['tools'];

const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork']);

export const Config = Schema.object({
  routes: Schema.array(Schema.object({
    provider: Schema.string().required(),
    model: Schema.string().required(),
    note: Schema.string(),
  })).default([])
    .description('允许子智能体使用的路由白名单；为空表示不拦截（保留原生继承）。'),
  strict: Schema.boolean().default(true)
    .description('关闭后整段守卫失效。'),
  checkInherited: Schema.boolean().default(true)
    .description('是否检查“省略模型、回退父级”的继承路径。'),
}).description('子智能体路由守卫：阻止派发跑到白名单之外的模型。');

function routeKey(provider, model) {
  return `${provider}/${model}`;
}

/** Read the newest durable allow-list recorded by DSH for a session. */
function sessionAllowList(session) {
  if (!session || typeof session.ownEvents !== 'function') return undefined;
  let events;
  try {
    events = session.ownEvents();
  } catch {
    return undefined;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'subagent/model-selection-policy') continue;
    const allowed = event.data?.allowedModels;
    if (Array.isArray(allowed) && allowed.length > 0) {
      return allowed.map((entry) => routeKey(entry.provider, entry.model));
    }
  }
  return undefined;
}

/** The route the parent conversation currently runs on. */
function parentRoute(session) {
  if (!session || typeof session.requestHeader !== 'function') return undefined;
  let header;
  try {
    header = session.requestHeader();
  } catch {
    return undefined;
  }
  const config = header?.config;
  if (!config || typeof config.provider !== 'string' || typeof config.model !== 'string') return undefined;
  return { provider: config.provider, model: config.model };
}

function describeRoutes(routes) {
  if (routes.length === 0) return '（空）';
  return routes.map((route) => (route.note ? `${routeKey(route.provider, route.model)}（${route.note}）` : routeKey(route.provider, route.model))).join('、');
}

function retryHint() {
  return '可用的写法：subagent(model: "<model>", ...)；工具 schema 若还接受 provider / reasoning_effort，可一并传入。';
}

function deny(reason, code) {
  return {
    kind: 'deny',
    reason,
    info: { name: 'subagent-model-guard', code },
  };
}

/**
 * @param ctx - tool registry.
 * @param config - `{ routes, agents, strict, checkInherited }`.
 */
export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {};
  const routes = Array.isArray(settings.routes) ? settings.routes : [];
  const strict = settings.strict !== false;
  const checkInherited = settings.checkInherited !== false;
  const allowedKeys = new Set(routes.map((route) => routeKey(route.provider, route.model)));

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!strict) return next();
    const toolName = String(exec?.name ?? '');
    if (!DELEGATION_TOOLS.has(toolName)) return next();
    // An empty allow-list means "not configured": keep the native behaviour.
    if (allowedKeys.size === 0) return next();

    const args = exec?.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
    const explicitProvider = typeof args.provider === 'string' && args.provider !== '' ? args.provider : undefined;
    const explicitModel = typeof args.model === 'string' && args.model !== '' ? args.model : undefined;

    // Explicit route: DSH checks its own official allow-list; ours is the hub-style one.
    // The tool schema does not always expose `provider`, so a model name alone is
    // a complete request: resolve it against the configured routes.
    if (explicitModel !== undefined) {
      const matches = routes.filter((route) => route.model === explicitModel
        && (explicitProvider === undefined || route.provider === explicitProvider));
      if (matches.length === 0) {
        const label = explicitProvider === undefined ? explicitModel : `${explicitProvider}/${explicitModel}`;
        return deny(
          `路由 ${label} 不在子智能体白名单里（允许：${describeRoutes(routes)}）。${retryHint()}`,
          'route-not-allowed',
        );
      }
      return next();
    }

    // Inherited route: the parent's model is what a child would actually run on.
    if (!checkInherited) return next();
    const route = parentRoute(exec?.agent?.session);
    if (route === undefined) {
      return deny(
        `这次派发没有指定 provider/model，会继承父级模型，但无法确认父级模型是什么。`
        + `请在调用里显式指定白名单内的路由（允许：${describeRoutes(routes)}）。${retryHint()}`,
        'inherited-route-unknown',
      );
    }
    const key = routeKey(route.provider, route.model);
    if (!allowedKeys.has(key)) {
      const recorded = sessionAllowList(exec?.agent?.session);
      const layerHint = recorded && recorded.length > 0
        ? `（本会话记录的官方白名单：${recorded.join('、')}）`
        : '';
      const debug = `［调试：args 键=${Object.keys(args).join(',') || '(空)'}］`;
      return deny(
        `这次派发没有指定 provider/model，会继承父级模型 ${key}，但它不在子智能体白名单里`
        + `（允许：${describeRoutes(routes)}）${layerHint}。${retryHint()}${debug}`,
        'inherited-route-not-allowed',
      );
    }
    return next();
  });
}

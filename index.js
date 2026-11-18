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

/**
 * Delegation tools the gate observes (`tools/pre-execute` UX layer).
 *
 * Both stay listed even though only `subagent` is replaced: the pre-execute
 * layer must still explain a refusal for the official `subagent_fork`, which
 * this plugin never shadows.
 */
const DELEGATION_TOOLS = ['subagent', 'subagent_fork'];

/**
 * The ONE official global tool this plugin replaces with its own scoped
 * registration.
 *
 * `subagent_fork` is deliberately NOT replaced. Its provider is `fork`, whose
 * provider differs from `spawn` in ways this tool does not reproduce (it seeds
 * the child with the parent's completed turns), and a half-implemented fork
 * shadow would be worse than the official tool. The previous code denied BOTH
 * names but re-registered only `subagent`, which deleted `subagent_fork` from
 * every agent's tool set.
 */
const REPLACED_TOOL = 'subagent';

/** Session origin that marks a subagent child (`parentSession` alone is not proof). */
const SUBAGENT_ORIGIN = 'subagent';

/**
 * Every field is `.volatile()`: `dsh-settings` only projects an entry that
 * declares at least one volatile field (`volatileForm` returns undefined
 * otherwise), so without this the whole Configuration form is dropped and the
 * page can never read or write this plugin. A volatile write commits into the
 * running fiber's references and does NOT re-run `apply`, so every value below
 * is read through {@link configValue} at call time instead of being captured
 * once in `apply`.
 */
export const Config = Schema.object({
  strict: Schema.boolean().default(true).volatile()
    .description('关闭后整段守卫失效，所有路由一律放行。'),

  useOfficialAllowList: Schema.boolean().default(true).volatile()
    .description(
      '直接采用 DSH 官方的子智能体白名单（subagent-model-selection-settings 的 allowedModels）作为放行依据，'
      + '不必在这里重复维护一份。开启后下方 routes 只作为额外补充。',
    ),

  routes: Schema.array(Schema.object({
    provider: Schema.string().required(),
    model: Schema.string().required(),
    note: Schema.string(),
  })).default([]).volatile()
    .description('额外的允许路由（在官方白名单之外补充）。两者都为空表示不拦截。'),

  deniedRoutes: Schema.array(Schema.object({
    provider: Schema.string().required(),
    model: Schema.string().required(),
    note: Schema.string(),
  })).default([]).volatile()
    .description(
      '显式拒绝的路由，优先级高于一切白名单（含官方 allowedModels）。'
      + '命中这里的组合一律拒绝，即使它同时出现在白名单里。',
    ),

  includeAllowedListInError: Schema.boolean().default(true).volatile()
    .description(
      '拒绝时是否在错误信息里列出当前生效的名单。'
      + '关闭后错误只说明被拒的路由，不暴露其余模型名。',
    ),

  recentDenialLimit: Schema.number().step(1).min(0).default(0).volatile()
    .description(
      '内存里保留最近 N 条拒绝记录（0 = 不记录）。'
      + '只活在进程内存里，绝不落盘：拒绝原因包含模型名，属于隐私。',
    ),

  auditDedupeMs: Schema.number().step(1).min(0).default(0).volatile()
    .description(
      '同一个人 agent+路由在这个时间窗内只记一条审计日志（0 = 不去重），避免审计刷屏。',
    ),

  enforcement: Schema.union([
    Schema.const('agent-created'),
    Schema.const('start-activation'),
    Schema.const('both'),
  ]).default('agent-created').volatile()
    .description(
      'agent-created：在 agent/created 处校验，契约稳定、覆盖 workflow；被拒会留下一个空 session 记录。'
      + 'start-activation：包住 ctx.subagents，在 agent 构造前拒绝，零残留；依赖 internal/get。'
      + 'both：两处都校验。',
    ),

  replaceSubagentTool: Schema.boolean().default(false).volatile()
    .description(
      '用本插件实现的 subagent 取代官方工具（scoped shadow）。'
      + '开启后子智能体直接走 startActivation，绕开 DSH 的会话模型快照，新上架的模型立即可用。'
      + '关闭则保留官方工具（受快照限制）。',
    ),

  cwd: Schema.boolean().default(true).volatile()
    .description('替换工具时是否接受 cwd 参数。'),

  maxDepth: Schema.union([
    Schema.natural().min(1),
    Schema.const(null),
  ]).default(null).volatile()
    .description(
      '替换工具派发子智能体时使用的最大递归深度。留空（null）表示沿用 DSH 的部署默认；'
      + '填 1 表示子智能体不能再派子智能体。',
    ),

  checkInherited: Schema.boolean().default(true).volatile()
    .description('是否检查「省略模型、回退父级」的继承路径。'),

  auditEveryStep: Schema.boolean().default(false).volatile()
    .description('在每一步模型调用时检查路由是否在白名单内，只记录不拦截。'
      + '走到这一步说明创建阶段的校验已漏网（例如子智能体运行中被切了模型），'
      + '此时拒绝会让它"创建成功但立刻失败"，所以只写 host 日志留痕。'),
}).description('子智能体路由守卫：白名单 + 可选的官方工具替换。');

function routeKey(provider, model) {
  return `${provider}/${model}`;
}

/**
 * Unwrap a value that may be a plain value, a getter, or a volatile ref.
 *
 * A `.volatile()` Config field is a ref OBJECT, not the value: the loader
 * updates that ref in place on a settings write (`cordis-plugin-loader`
 * `_commitVolatile` → `updateVolatile`) and does NOT re-run `apply`. So a
 * `field !== false` test would be true for every ref, and a value captured in
 * `apply` would freeze at activation. Config fields must therefore be read
 * through this helper at the moment of use.
 *
 * @param value - candidate value, accessor, or ref.
 * @returns the current value, or `undefined` when it cannot be read.
 */
function deref(value) {
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
  return out;
}

/**
 * Read a route field that may be a plain value, a getter, or a volatile ref.
 * `agent.options` documents "live accessors apply until the Session records a
 * selection", so a plain property read is not enough.
 */
function routeValue(value) {
  const out = deref(value);
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

/**
 * A bounded, in-memory record of recent denials.
 *
 * Deliberately NOT persisted: a denial carries the attempted model name, and a
 * model name in a settings document (or session log) is durable privacy. This
 * lives in the plugin instance and dies with it.
 *
 * The buffer is a plain array capped at `limit`, newest last. `limit` is read
 * from LIVE config on every push, so lowering the setting shrinks the buffer
 * immediately instead of waiting for the next N denials to evict old entries.
 */
function createDenialLog() {
  /** @type {Array<{at: number, parentRoute: string|null, childRoute: string|null, kind: 'denied'|'unknown', reason: string}>} */
  let entries = [];
  return {
    /**
     * @param limit - current cap; `<= 0` disables recording and CLEARS the buffer.
     * @param entry - the denial to record.
     * @returns whether the entry was kept.
     */
    push(limit, entry) {
      if (!Number.isInteger(limit) || limit <= 0) {
        // Turning recording off must free what was already collected, otherwise
        // stale model names keep living in memory after the user opted out.
        if (entries.length > 0) entries = [];
        return false;
      }
      entries.push(entry);
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
      return true;
    },
    /** @param limit - current cap, applied before reading. @returns a detached copy. */
    snapshot(limit) {
      if (!Number.isInteger(limit) || limit <= 0) {
        if (entries.length > 0) entries = [];
        return [];
      }
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
      return entries.map((entry) => ({ ...entry }));
    },
    /** @returns how many entries are held right now. */
    size() {
      return entries.length;
    },
  };
}

/**
 * Quantize a wall-clock timestamp to whole seconds.
 *
 * Two denials of the same route inside one second are the same observable
 * event, so they dedupe together; a millisecond timestamp would make every
 * call distinct and defeat `auditDedupeMs` for the very burst it targets.
 *
 * @param ms - epoch milliseconds.
 * @returns epoch seconds.
 */
function toSecond(ms) {
  return Math.floor(ms / 1000);
}

function denial(message) {
  return Object.assign(new Error(`[subagent-model-guard] ${message}`), { guardDenial: true });
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
 * Read the native subagent allow-list from the `subagentModelSelection` service.
 *
 * That service (mounted as the `subagent-model-selection-settings` loader entry)
 * owns the official preference and exposes `current()`, which reads its own
 * volatile refs and returns `{ enabled, allowedModels }`. Reading it directly is
 * what makes an official edit take effect immediately: no `settings.describe()`
 * snapshot, no dependence on the wire envelope shape (`describe()` returns a
 * bare ARRAY; `{ namespaces }` is only the remote controller's envelope), and no
 * `describe()` side effects (it re-stamps revisions and emits
 * `settings/document-updated`).
 *
 * `enabled === false` means the official feature imposes NO restriction, so its
 * `allowedModels` must not be used as an allow-list.
 *
 * @param ctx - plugin context.
 * @param warnOnce - reports a single degradation instead of failing silently.
 * @returns the official routes, or `[]` when unavailable or disabled.
 */
function officialRoutes(ctx, warnOnce) {
  let service;
  try {
    service = ctx.get('subagentModelSelection');
  } catch (error) {
    warnOnce('读取 subagentModelSelection 服务失败，官方白名单不可用', error);
    return [];
  }
  if (!service || typeof service.current !== 'function') {
    warnOnce('subagentModelSelection 服务不可用，本次只按本插件的 routes 校验');
    return [];
  }
  let current;
  try {
    current = service.current();
  } catch (error) {
    // `current()` throws when it is enabled with an empty list, and when the
    // stored routes are malformed. Either way the official list is unusable.
    warnOnce('读取官方子智能体白名单失败，本次只按本插件的 routes 校验', error);
    return [];
  }
  if (current?.enabled !== true) return [];
  const allowed = Array.isArray(current?.allowedModels) ? current.allowedModels : [];
  return allowed
    .filter((entry) => entry && typeof entry.provider === 'string' && typeof entry.model === 'string')
    .map((entry) => ({ provider: entry.provider, model: entry.model, note: '官方' }));
}

/**
 * @param ctx - plugin context.
 * @param config - see {@link Config}.
 */
export function apply(ctx, config) {
  const captured = config && typeof config === 'object' ? config : {};

  // ── Config access ──────────────────────────────────────────────────────
  // Every field is `.volatile()`, so `config.strict` is a ref object and a
  // settings write only updates that ref in place — `apply` does NOT re-run.
  // Reading through `deref` at each use is what makes the Configuration page
  // actually control anything. `captured` is only the schema-default fallback
  // for an embedder that composes this plugin outside a profile row.
  const flag = (key, fallback) => {
    const value = deref(captured[key]);
    return typeof value === 'boolean' ? value : fallback;
  };
  const readRoutes = () => {
    const value = deref(captured.routes);
    return Array.isArray(value) ? value : [];
  };
  const readDeniedRoutes = () => {
    const value = deref(captured.deniedRoutes);
    return Array.isArray(value) ? value : [];
  };
  /** A non-negative integer count, or `fallback` for anything else. */
  const count = (key, fallback) => {
    const value = deref(captured[key]);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
  };
  const readEnforcement = () => {
    const value = deref(captured.enforcement);
    return value === 'agent-created' || value === 'start-activation' || value === 'both'
      ? value
      : 'agent-created';
  };
  const strict = () => flag('strict', true);
  const useOfficialAllowList = () => flag('useOfficialAllowList', true);
  const checkInherited = () => flag('checkInherited', true);
  const replaceTool = () => flag('replaceSubagentTool', false);
  const acceptCwd = () => flag('cwd', true);
  const auditEveryStep = () => flag('auditEveryStep', false);
  const includeAllowList = () => flag('includeAllowedListInError', true);
  const recentDenialLimit = () => count('recentDenialLimit', 0);
  const auditDedupeMs = () => count('auditDedupeMs', 0);
  /**
   * The configured delegation depth, or `undefined` to keep DSH's deployment
   * default. `null` is the documented "not set" value and must NOT become 0.
   */
  const configuredMaxDepth = () => {
    const value = deref(captured.maxDepth);
    return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
  };

  /** Route diagnostics go through `ctx.logger`, not `console`. */
  const warn = (context, error) => {
    const detail = error === undefined ? '' : `：${error instanceof Error ? error.message : String(error)}`;
    try {
      ctx.logger.warn(`[subagent-model-guard] ${context}${detail}`);
    } catch {
      // A logger that throws must never fail a delegation.
    }
  };

  // Report each distinct degradation once per activation instead of on every
  // dispatch (the allow-list is recomputed per call now).
  const reported = new Set();
  const warnOnce = (context, error) => {
    if (reported.has(context)) return;
    reported.add(context);
    warn(context, error);
  };

  /**
   * The effective allow-list: official routes plus this plugin's own extras.
   * Deliberately evaluated on EVERY call so an official edit, a settings write,
   * or a routes change is honoured without a reload.
   */
  const ownRules = () => readRoutes().filter((route) => route && typeof route.provider === 'string'
    && typeof route.model === 'string' && route.provider !== '' && route.model !== '');
  const effectiveRules = () => {
    const merged = [];
    const seen = new Set();
    const official = useOfficialAllowList() ? officialRoutes(ctx, warnOnce) : [];
    for (const route of [...official, ...ownRules()]) {
      const key = routeKey(route.provider, route.model);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(route);
    }
    return merged;
  };
  const keysOf = () => new Set(effectiveRules().map((route) => routeKey(route.provider, route.model)));
  /** The explicit denials, which outrank every allow-list. */
  const deniedKeys = () => new Set(readDeniedRoutes()
    .filter((route) => route && typeof route.provider === 'string' && typeof route.model === 'string')
    .map((route) => routeKey(route.provider, route.model)));

  /**
   * Decide one route.
   *
   * `denied` wins over `allowed`: an explicit denial is a deliberate "no", so a
   * route that also appears in the official list or in `routes` stays refused.
   *
   * When NO allow-list exists at all but denials do, the policy is "everything
   * except these", not "nothing is allowed" — otherwise a deny-only setup would
   * silently block every delegation and the blacklist would be unusable alone.
   *
   * @param route - candidate provider/model.
   * @returns `{ outcome: 'allowed' | 'denied' | 'not-allowed' }`.
   */
  const judge = (route) => {
    const key = routeKey(route.provider, route.model);
    if (deniedKeys().has(key)) return { outcome: 'denied' };
    const allowed = keysOf();
    if (allowed.has(key)) return { outcome: 'allowed' };
    // Deny-only policy: nothing is allow-listed, so absence is not a violation.
    if (allowed.size === 0 && deniedKeys().size > 0) return { outcome: 'allowed' };
    return { outcome: 'not-allowed' };
  };

  /**
   * Enforcement is live only while enabled with at least one allow-listed rule.
   * A denial-only configuration still enforces: an all-denied setup is a valid
   * "nothing may be delegated" policy, not a disabled guard.
   */
  const active = () => strict()
    && (keysOf().size > 0 || deniedKeys().size > 0);

  const allowedText = () => describeRoutes(effectiveRules());

  /**
   * The reason a route was refused, phrased by WHY it was refused.
   * The allow-list is appended only when `includeAllowedListInError` is on: the
   * list can name models the operator does not want echoed back.
   */
  const refusalOf = (route, outcome) => {
    const key = routeKey(route.provider, route.model);
    const allowList = includeAllowList() ? `（允许：${allowedText()}）` : '';
    if (outcome === 'denied') {
      return `${key} 被显式拒绝（在 deniedRoutes 中）${allowList}。`;
    }
    return `${key} 不在白名单内${allowList}。`;
  };

  /** The one place a denial is recorded, shared by every enforcement point. */
  const denialLog = createDenialLog();
  /**
   * @param kind - `denied` (explicitly refused) or `unknown` (route unresolvable).
   * @param parentRoute - the delegating agent's route, when known.
   * @param childRoute - the attempted child route, when known.
   * @param reason - human-readable reason.
   */
  const recordDenial = (kind, parentRoute, childRoute, reason) => {
    const entry = {
      at: toSecond(Date.now()),
      parentRoute: parentRoute === undefined ? null : routeKey(parentRoute.provider, parentRoute.model),
      childRoute: childRoute === undefined ? null : routeKey(childRoute.provider, childRoute.model),
      kind,
      reason,
    };
    if (denialLog.push(recentDenialLimit(), entry)) {
      warn(`拒绝记录：${reason}`);
    }
  };

  /**
   * Offer the read-only denial list to any renderer that can reach this
   * instance. The browser half is a separate bundle with no Host channel, so
   * this is best-effort: it is attached to the service object rather than
   * published as a config field (a config field would be persisted, and model
   * names in a settings document are exactly what must not be stored).
   */
  const denials = {
    /** @returns the current records, newest last. */
    snapshot: () => denialLog.snapshot(recentDenialLimit()),
    /** @returns the configured cap. */
    limit: recentDenialLimit,
  };

  // ── Gate A: agent/created ──────────────────────────────────────────────
  // Both gates are ALWAYS registered and decide from live config: a settings
  // write does not re-run `apply`, so making registration conditional on
  // `enforcement` would freeze the mode at activation.
  ctx.on('agent/created', ({ agent }) => {
    if (!active()) return;
    const mode = readEnforcement();
    if (mode !== 'agent-created' && mode !== 'both') return;
    try {
      if (agent?.session?.header?.origin !== SUBAGENT_ORIGIN) return;
      const route = agentRoute(agent);
      if (route === undefined) {
        // An external backend (acp/SDK) does not expose a local route here.
        // Denying would break delegation the guard cannot even observe, so
        // this fails open — matching Gate B's `route !== undefined` condition.
        warnOnce('agent/created 无法确认子智能体路由（provider/model 缺失），放行', undefined);
        recordDenial('unknown', undefined, undefined, 'agent/created 无法确认子智能体路由，放行');
        return;
      }
      const { outcome } = judge(route);
      if (outcome !== 'allowed') {
        const reason = refusalOf(route, outcome);
        recordDenial(outcome === 'denied' ? 'denied' : 'unknown', undefined, route, reason);
        throw denial(`拒绝创建子智能体：${reason}`);
      }
    } catch (error) {
      // A guard bug must never block delegation; a denial must.
      if (error && error.guardDenial === true) throw error;
      warn('agent/created 闸门内部错误，放行', error);
    }
  }, { prepend: true });

  // ── Gate B: wrap ctx.subagents ────────────────────────────────────────
  const proxies = new WeakMap();
  ctx.on('internal/get', (caller, serviceName, error, next) => {
    const service = next();
    const mode = readEnforcement();
    if (mode !== 'start-activation' && mode !== 'both') return service;
    if (!active()) return service;
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
            if (route === undefined) {
              // Same fail-open rule as Gate A: an unobservable route is not a
              // violation, and this proxy may not be able to see one at all.
              warnOnce('startActivation 无法确认子智能体路由，放行', undefined);
              recordDenial('unknown', undefined, undefined, 'startActivation 无法确认子智能体路由，放行');
            } else {
              const { outcome } = judge(route);
              if (outcome !== 'allowed') {
                const reason = refusalOf(route, outcome);
                recordDenial(outcome === 'denied' ? 'denied' : 'unknown', undefined, route, reason);
                throw denial(reason);
              }
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

  // ── Replacement: our own subagent tool ────────────────────────────────
  // ── Replacement: our own subagent tool ────────────────────────────────
  // Registered unconditionally and decided live: a settings write does not
  // re-run `apply`, so gating registration on `replaceSubagentTool` would pin
  // the choice to activation time.
  {
    const toolDescription =
      'Create an independently managed subagent and immediately return its name. '
      + 'If you are still online when it finishes, the runtime automatically delivers its completion notice. '
      + 'Use `send_message` to steer it while running or continue its conversation after it finishes. '
      + 'Pass `provider` and `model` to choose the child LLM route explicitly; omit both to inherit this conversation\'s route.';

    /** Parameters are rebuilt per registration so a `cwd` toggle applies to new agents. */
    const replacementParameters = () => {
      const parameters = {
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
      if (acceptCwd()) {
        parameters.properties.cwd = {
          type: 'string',
          description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
        };
      }
      return parameters;
    };

    const replacementDefinition = () => ({
      name: 'subagent',
      description: toolDescription,
      parameters: replacementParameters(),
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

        const guardOn = active();
        const route = resolveDelegationRoute(args, parent);
        if (route === undefined && guardOn) {
          // With the guard on, an unresolvable route cannot be validated, and
          // inheriting silently would defeat the allow-list. With it off this
          // must stay a pass-through so the tool matches the official one.
          const reason = '无法确定子智能体路由：请显式提供 provider 与 model。';
          recordDenial('unknown', sessionRoute(parent?.session) ?? agentRoute(parent), undefined, reason);
          throw denial(reason);
        }
        if (route !== undefined && guardOn) {
          const { outcome } = judge(route);
          if (outcome !== 'allowed') {
            const reason = refusalOf(route, outcome);
            recordDenial(outcome === 'denied' ? 'denied' : 'unknown',
              sessionRoute(parent?.session) ?? agentRoute(parent), route, reason);
            throw denial(reason);
          }
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

        // Omit `agentOptions` entirely when no route was resolved: the child
        // then inherits exactly like the official tool's omitted pair.
        let agentOptions;
        if (route !== undefined) {
          agentOptions = { provider: route.provider, model: route.model };
          const effort = routeValue(args?.reasoning_effort);
          if (effort !== undefined) agentOptions.reasoningEffort = effort;
        }

        const started = await subagents.startActivation({
          provider: 'spawn',
          label: typeof args?.description === 'string' && args.description !== ''
            ? args.description
            : 'subagent',
          ...(typeof args?.name === 'string' && args.name !== '' ? { name: args.name } : {}),
          ...(acceptCwd() && typeof args?.cwd === 'string' && args.cwd !== '' ? { cwd: args.cwd } : {}),
          prompt: [{ type: 'text', text: prompt }],
          parent,
          ...(agentOptions !== undefined ? { agentOptions } : {}),
          ...(agentPreset !== undefined ? { agentPreset } : {}),
          // `configuredMaxDepth()` returns undefined when unset, so `??` keeps
          // the deployment default instead of forcing 0 (a hard block).
          maxDepth: configuredMaxDepth() ?? subagents.resolveMaxDepth(undefined),
          signal: exec.signal,
          delivery: 'parent',
        });
        return { kind: 'activation', name: started.name };
      },
    });

    /** Agents already shadowed, so a repeated `agent/created` is a no-op. */
    const shadowed = new WeakSet();

    const registerReplacement = (agent) => {
      const scoped = agent?.ctx;
      if (!scoped || !scoped.tools) return;
      if (typeof scoped.tools.register !== 'function') return;
      if (shadowed.has(agent)) return;
      shadowed.add(agent);

      // 1. Mask the official GLOBAL registration this plugin replaces.
      //    `restrict()` THROWS when a name is not a known global tool in this
      //    scope, so this is its own step with its own try: one absent tool
      //    must never abort the rest, and must never skip step 2 — skipping it
      //    would silently fall back to the official tool.
      if (typeof scoped.tools.restrict === 'function') {
        try {
          scoped.tools.restrict({ deny: [REPLACED_TOOL] });
        } catch (error) {
          warn(`屏蔽官方 ${REPLACED_TOOL} 失败（该 scope 可能没有这个全局工具）`, error);
        }
      }

      // 2. Register our own — scoped registrations shadow globals and are
      //    exempt from the restriction above them.
      try {
        scoped.tools.register(replacementDefinition());
      } catch (error) {
        warn('注册替换用的 subagent 工具失败', error);
      }
    };

    ctx.on('agent/created', ({ agent }) => {
      if (!replaceTool()) return;
      try {
        registerReplacement(agent);
      } catch (error) {
        warn('替换 subagent 工具时出错', error);
      }
    }, { prepend: true });

    // `agent/created` only fires for NEW agents, so the session that loaded this
    // plugin would keep the official tool until it restarts. Migrate the agents
    // that already exist (the same catch-up the permission presets do).
    try {
      const agents = ctx.get('agents');
      const live = typeof agents?.list === 'function' ? agents.list() : [];
      for (const agent of live) {
        try {
          if (!replaceTool()) break;
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
  // `agent/pre-step` is a WATERFALL: a listener that returns without calling
  // `next()` vetoes the rest of the chain, including the built-in behaviour,
  // which makes every step fail. This hook only observes, so it must always
  // forward. Registration is unconditional and the flag is read live.
  /**
   * Last audit timestamp per `agent|route`, at whole-second resolution.
   * Pruned on every consult so a long-lived process cannot grow it without
   * bound; the window is read live, so lowering it takes effect immediately.
   */
  const auditSeen = new Map();
  ctx.on('agent/pre-step', async (payload, next) => {
    if (!auditEveryStep() || !active()) return next();
    try {
      const selection = payload?.modelSelection;
      const provider = routeValue(selection?.provider);
      const model = routeValue(selection?.model);
      if (provider === undefined || model === undefined) return next();
      const route = { provider, model };
      const { outcome } = judge(route);
      if (outcome === 'allowed') return next();

      const now = toSecond(Date.now());
      const window = auditDedupeMs();
      const agentId = String(payload?.agent?.id ?? '?');
      const dedupeKey = `${agentId}|${routeKey(provider, model)}`;
      if (window > 0) {
        const last = auditSeen.get(dedupeKey);
        if (last !== undefined && now - last < window) return next();
        // Drop expired keys on every consult; the map then stays proportional
        // to the distinct agent/route pairs inside the current window.
        for (const [key, at] of auditSeen) {
          if (now - at >= window) auditSeen.delete(key);
        }
        auditSeen.set(dedupeKey, now);
      }

      // Deliberately NOT a rejection: by this point the child already exists,
      // so declining would surface as `stopReason: 'refusal'` with no reason.
      const reason = `审计：${refusalOf(route, outcome)}（agent ${agentId}）`;
      warn(reason);
      recordDenial(outcome === 'denied' ? 'denied' : 'unknown', undefined, route, reason);
    } catch (error) {
      warn('审计钩子内部错误', error);
    }
    return next();
  });

  // ── Pre-execute UX layer: readable errors for the official tool ───────
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!strict()) return next();
    const toolName = String(exec?.name ?? '');
    if (!DELEGATION_TOOLS.includes(toolName)) return next();
    // Our own tool is already authoritative about the route; deferring keeps a
    // single error format. Checked live so the toggle is honest.
    if (!active() || replaceTool()) return next();
    let route;
    try {
      route = resolveDelegationRoute(exec?.arguments, exec?.agent);
    } catch (error) {
      warn('pre-execute 解析路由失败，放行', error);
      return next();
    }
    if (route === undefined) return next();
    if (!route.explicit && !checkInherited()) return next();
    const { outcome } = judge(route);
    if (outcome === 'allowed') return next();
    const reason = refusalOf(route, outcome);
    recordDenial(outcome === 'denied' ? 'denied' : 'unknown',
      sessionRoute(exec?.agent?.session) ?? agentRoute(exec?.agent), route, reason);
    return {
      kind: 'deny',
      reason: `路由 ${reason}`
        + (outcome === 'denied'
          ? '该组合已被显式拒绝，请改用它之外的路由。'
          : (route.explicit
            ? '请改用白名单内的 provider/model。'
            : '请显式提供白名单内的 provider 与 model，或换一个父级模型。')),
      info: { name: 'subagent-model-guard', code: 'route-not-allowed' },
    };
  });

  // Hand the read-only denial list to a Host-side caller (or a future Remote
  // endpoint) without persisting anything: it lives only in this instance.
  return denials;
}
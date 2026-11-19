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

  auditEveryStep: Schema.boolean().default(false).volatile()
    .description('在每一步模型调用时检查路由是否在官方白名单内，只记录不拦截。'
      + '走到这一步说明创建阶段的校验已漏网（例如子智能体运行中被切了模型），'
      + '此时拒绝会让它"创建成功但立刻失败"，所以只写 host 日志留痕。'),
}).description('子智能体路由守卫：以 DSH 官方白名单为唯一放行依据，可选替换官方工具。');

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
  const replaceTool = () => flag('replaceSubagentTool', false);
  const auditEveryStep = () => flag('auditEveryStep', false);
  const includeAllowList = () => flag('includeAllowedListInError', true);
  const recentDenialLimit = () => count('recentDenialLimit', 0);
  const auditDedupeMs = () => count('auditDedupeMs', 0);

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
  /**
   * The official allow-list, recomputed on every call so an edit in the DSH
   * settings takes effect without a reload. This plugin deliberately keeps no
   * list of its own: the official `allowedModels` is the single source of truth.
   */
  const officialRules = () => officialRoutes(ctx, warnOnce);
  const officialKeys = () => new Set(officialRules().map((route) => routeKey(route.provider, route.model)));

  /**
   * Decide one route against the official list.
   *
   * An empty or unavailable official list means "no restriction" in DSH itself,
   * which is why {@link active} is false then and this verdict is never used to
   * refuse anything: the guard never invents a policy the user did not configure.
   *
   * @param route - candidate provider/model.
   * @returns `{ outcome: 'allowed' | 'not-allowed' }`.
   */
  const judge = (route) => {
    const key = routeKey(route.provider, route.model);
    return officialKeys().has(key) ? { outcome: 'allowed' } : { outcome: 'not-allowed' };
  };

  /** Live only while the master switch is on and the official list restricts something. */
  const active = () => strict() && officialKeys().size > 0;

  const allowedText = () => describeRoutes(officialRules());

  /**
   * The reason a route was refused there is exactly one reason now: it is not in
   * the official list. The list is appended only when `includeAllowedListInError`
   * is on — it can name models the operator does not want echoed back.
   */
  const refusalOf = (route) => {
    const key = routeKey(route.provider, route.model);
    const allowList = includeAllowList() ? `（允许：${allowedText()}）` : '';
    return `${key} 不在 DSH 官方的子智能体白名单内${allowList}。`;
  };

  /** The one place a denial is recorded, shared by every enforcement point. */
  const denialLog = createDenialLog();
  /**
   * @param kind - `denied` (a route outside the official list) or `unknown` (route unresolvable).
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

  // ── Read-only self-check tool ─────────────────────────────────────────
  // Diagnoses the state of THIS plugin instance. Every probe is independently
  // guarded and the whole execute() has an outer catch: diagnosis must be
  // strictly observational and must never throw, even when a config ref or a
  // service is broken. All route logic is reused from the helpers above — this
  // is a mirror, not a second implementation.
  const selfcheckDefinition = () => ({
    name: 'guard_selfcheck',
    description: '只读诊断，不改任何状态：报告子智能体路由守卫的当前生效状态（严格/启用标志、enforcement 模式、'
      + '官方白名单的读取结果、闸门与替换工具安装情况、最近拒绝计数），供排查为何某个路由被放行或拒绝。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      // A schema object is mandatory: the registry rejects an output that only
      // carries `render`, so the shape is declared even though it is diagnostic.
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          active: { type: 'boolean' },
          strict: { type: 'boolean' },
          enforcement: { type: 'string' },
          effectiveRouteCount: { type: 'number' },
          recentDenials: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `guard_selfcheck: active=${value?.active}, strict=${value?.strict}, enforcement=${value?.enforcement}`,
      }],
    },
    async execute() {
      // The outer net guarantees the tool never rejects, whatever happens.
      try {
        const checks = [];
        /** Run one probe; record its outcome and never let it throw. */
        const probe = (name, fn, hint) => {
          try {
            const value = fn();
            checks.push({ name, ok: true, detail: '', hint });
            return value;
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            checks.push({ name, ok: false, detail, hint });
            return undefined;
          }
        };
        const brief = (routes) => (Array.isArray(routes) && routes.length > 0
          ? routes.map((r) => routeKey(r.provider, r.model)).join('、')
          : '（空）');

        // ── official allow-list: three distinguishable outcomes ────────
        // 1) service missing/unusable → available:false + error
        // 2) enabled=false            → available:true, enabled:false, no error, routes:[]
        // 3) enabled with empty list  → current() throws → available:true + error, routes:[]
        const officialAllowList = { available: false, enabled: false, routes: [] };
        const officialHint = '检查 subagentModelSelection 是否挂载、enabled 是否为 true、allowedModels 是否非空';
        try {
          let service;
          try {
            service = ctx.get('subagentModelSelection');
          } catch (error) {
            officialAllowList.error = `读取服务失败：${error instanceof Error ? error.message : String(error)}`;
          }
          if (!service || typeof service.current !== 'function') {
            if (officialAllowList.error === undefined) {
              officialAllowList.error = 'subagentModelSelection 服务不可用（未挂载或缺少 current()）';
            }
            checks.push({ name: 'officialAllowList', ok: false, detail: officialAllowList.error, hint: officialHint });
          } else {
            officialAllowList.available = true;
            let current;
            try {
              current = service.current();
            } catch (error) {
              officialAllowList.error = `current() 抛错：${error instanceof Error ? error.message : String(error)}`;
              checks.push({ name: 'officialAllowList', ok: false, detail: officialAllowList.error, hint: officialHint });
              current = undefined;
            }
            if (current !== undefined) {
              officialAllowList.enabled = current?.enabled === true;
              if (!officialAllowList.enabled) {
                // A disabled official list imposes NO restriction. This is a
                // normal state, so there is deliberately no `error` field.
                checks.push({
                  name: 'officialAllowList', ok: true,
                  detail: '官方白名单已禁用（enabled=false），不施加限制', hint: officialHint,
                });
              } else {
                const allowed = Array.isArray(current.allowedModels) ? current.allowedModels : [];
                officialAllowList.routes = allowed
                  .filter((entry) => entry && typeof entry.provider === 'string' && typeof entry.model === 'string')
                  .map((entry) => ({ provider: entry.provider, model: entry.model }));
                checks.push({
                  name: 'officialAllowList', ok: true,
                  detail: `官方白名单生效，${officialAllowList.routes.length} 条：${brief(officialAllowList.routes)}`,
                  hint: officialHint,
                });
              }
            }
          }
        } catch (error) {
          officialAllowList.error = `读取官方白名单失败：${error instanceof Error ? error.message : String(error)}`;
          checks.push({ name: 'officialAllowList', ok: false, detail: officialAllowList.error, hint: officialHint });
        }

        // ── every other field, each independently guarded ──────────────
        const activeValue = probe('active', () => active(), 'strict=true 且官方白名单非空时守卫才生效');
        const strictValue = probe('strict', () => strict(), '关闭后整段守卫失效，所有路由放行');
        const enforcementValue = probe('enforcement', () => readEnforcement(), 'agent-created | start-activation | both');
        const effectiveRulesValue = probe('officialRoutes', () => officialRules(),
          '官方 allowedModels（本插件不再维护自己的名单）');
        const effectiveRouteCount = effectiveRulesValue === undefined ? 0 : effectiveRulesValue.length;
        const gates = probe('gates', () => {
          const mode = readEnforcement();
          return {
            agentCreated: mode === 'agent-created' || mode === 'both',
            startActivation: mode === 'start-activation' || mode === 'both',
          };
        }, '当前 enforcement 模式下哪几道闸门处于启用状态')
          ?? { agentCreated: false, startActivation: false };
        const replacement = probe('replacement', () => ({
          installed: replacementRegistered > 0,
          note: `替换工具已在 ${replacementRegistered} 个 agent scope 注册；开关 replaceSubagentTool=${replaceTool()}`,
        }), '替换工具让子智能体直接走 startActivation，绕开会话模型快照')
          ?? { installed: false, note: '无法读取替换工具状态' };
        const recentDenials = probe('recentDenials',
          () => denialLog.snapshot(recentDenialLimit()).length,
          '内存中保留的最近拒绝记录条数（recentDenialLimit=0 时不记录）');

        return {
          active: activeValue === undefined ? false : activeValue,
          strict: strictValue === undefined ? false : strictValue,
          enforcement: enforcementValue === undefined ? 'unknown' : enforcementValue,
          officialAllowList,
          effectiveRouteCount,
          gates,
          replacement,
          recentDenials: recentDenials ?? 0,
          checks,
        };
      } catch (error) {
        // Last-resort fallback: even a completely broken probe must yield a
        // well-shaped report instead of a rejected tool call.
        const detail = error instanceof Error ? error.message : String(error);
        return {
          active: false,
          strict: false,
          enforcement: 'unknown',
          officialAllowList: { available: false, enabled: false, routes: [], error: `自检内部错误：${detail}` },
          effectiveRouteCount: 0,
          gates: { agentCreated: false, startActivation: false },
          replacement: { installed: false, note: '自检内部错误' },
          recentDenials: 0,
          checks: [{ name: 'selfcheck', ok: false, detail, hint: '请查看插件日志' }],
        };
      }
    },
  });

  // Global, always-available registration. Optional chaining keeps embedders
  // that compose apply() without the injected `tools` service working (e.g.
  // minimal harnesses), and the catch keeps a bad registry from breaking apply.
  try {
    ctx.tools?.register?.(selfcheckDefinition());
  } catch (error) {
    warn('注册 guard_selfcheck 只读自检工具失败', error);
  }

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
        const reason = refusalOf(route);
        recordDenial('denied', undefined, route, reason);
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
                const reason = refusalOf(route);
                recordDenial('denied', undefined, route, reason);
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

  /** How many agent scopes had the replacement `subagent` tool registered. */
  let replacementRegistered = 0;

  {
    const toolDescription =
      'Create an independently managed subagent and immediately return its name. '
      + 'If you are still online when it finishes, the runtime automatically delivers its completion notice. '
      + 'Use `send_message` to steer it while running or continue its conversation after it finishes. '
      + 'Pass `provider` and `model` to choose the child LLM route explicitly; omit both to inherit this conversation\'s route.';

    /** Parameters are rebuilt per registration so schema changes apply to new agents. */
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
          cwd: {
            type: 'string',
            description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
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
        // A half-specified pair is a malformed call, not an unresolvable one: the
        // caller named a provider but no model (or the reverse), so refusing is
        // the only honest answer. Both-omitted is the documented "inherit".
        const explicitProvider = routeValue(args?.provider);
        const explicitModel = routeValue(args?.model);
        if ((explicitProvider === undefined) !== (explicitModel === undefined)) {
          recordDenial('unknown', sessionRoute(parent?.session) ?? agentRoute(parent), undefined,
            'provider 与 model 只给了其中一个');
          throw denial('provider 与 model 必须同时提供，或两者都省略以继承父级路由。');
        }
        const route = resolveDelegationRoute(args, parent);
        if (route === undefined && guardOn) {
          // Same policy as both gates: an unresolvable route cannot be checked,
          // so the call passes through with a record instead of failing.
          warnOnce('替身工具无法确认子智能体路由（provider/model 缺失），放行', undefined);
          recordDenial('unknown', sessionRoute(parent?.session) ?? agentRoute(parent), undefined,
            '替身工具无法确认子智能体路由，放行');
        }
        if (route !== undefined && guardOn) {
          const { outcome } = judge(route);
          if (outcome !== 'allowed') {
            const reason = refusalOf(route);
            recordDenial('denied',
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
          ...(typeof args?.cwd === 'string' && args.cwd !== '' ? { cwd: args.cwd } : {}),
          prompt: [{ type: 'text', text: prompt }],
          parent,
          ...(agentOptions !== undefined ? { agentOptions } : {}),
          ...(agentPreset !== undefined ? { agentPreset } : {}),
          // No depth rule belongs to this plugin any more: always defer to the
          // deployment default rather than forcing a value.
          maxDepth: subagents.resolveMaxDepth(undefined),
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
        replacementRegistered += 1;
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
      const reason = `审计：${refusalOf(route)}（agent ${agentId}）`;
      warn(reason);
      recordDenial('denied', undefined, route, reason);
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
    const { outcome } = judge(route);
    if (outcome === 'allowed') return next();
    const reason = refusalOf(route);
    recordDenial('denied',
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
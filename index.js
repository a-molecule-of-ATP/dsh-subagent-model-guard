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
 *
 * Optional take-over (`takeOverNativeAllowList`): DSH appends one durable
 * `subagent/model-selection-policy` event per Session and its projection keeps
 * only the first one, so a Session that started while
 * `subagent-model-selection-settings.enabled` was true keeps that frozen
 * snapshot forever. Turning the native switch off at runtime leaves `routes`
 * as the only live allow-list. `enabled` and `allowedModels` are declared with
 * `.volatile()`, so `Entry.update()` commits the change into the running
 * service without a remount and — because this bypasses `EntryTree.update` —
 * without journalling anything back into the profile's cordis.patch.yml.
 */
import Schema from '@deepseek-ai/schemastery';

export const name = 'subagent-model-guard';

/** Only the tool registry is required; the loader is read opportunistically. */
export const inject = ['tools'];

const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork']);

/** Tree-local id the profile patch gives the native settings entry. */
const NATIVE_SETTINGS_ID = 'subagent-model-selection-settings';

/** Package name of the native settings entry, matched when the id differs. */
const NATIVE_SETTINGS_NAME = '@deepseek-ai/dsh-tool-subagent/model-selection-settings';

/** Bounded wait for the native settings entry to be created by the loader. */
const LOCATE_ATTEMPTS = 40;
const LOCATE_INTERVAL_MS = 100;

/** Actionable fallback when the runtime take-over cannot be done. */
const MANUAL_HINT = '需要手动把 profile 的 cordis.patch.yml 里 `- id: subagent-model-selection-settings` 的 config.enabled 改为 false，然后重启 DSH。';

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
  takeOverNativeAllowList: Schema.boolean().default(false)
    .description('是否在运行时接管 DSH 原生子智能体模型白名单：开启后本插件把 subagent-model-selection-settings 的 enabled 在运行时置为 false（只改运行时内存，不写 profile 配置文件），白名单改由本插件 routes 实时把关。'
      + `若运行时接管失败，本插件只打一条 console.warn：${MANUAL_HINT}`),
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

/** Resolve a value that may be a schema-declared volatile reference. */
function readSetting(value) {
  return value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/** Raw entry config normalized to a plain object. */
function rawConfigOf(entry) {
  const config = entry?.options?.config;
  return config && typeof config === 'object' && !Array.isArray(config) ? { ...config } : {};
}

/** The live `enabled` of the native setting, or undefined when unreadable. */
function liveEnabled(entry) {
  const effective = entry?.fiber?.effectiveConfig;
  if (!effective || typeof effective !== 'object') return undefined;
  const value = readSetting(effective.enabled);
  return typeof value === 'boolean' ? value : undefined;
}

/** Locate the live native settings entry: tree-local id first, package name second. */
function findNativeSettingsEntry(loader) {
  for (const entry of loader.entries()) {
    const options = entry?.options;
    if (!options) continue;
    if (options.id === NATIVE_SETTINGS_ID || options.name === NATIVE_SETTINGS_NAME) return entry;
  }
  return undefined;
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref();
  });
}

/** Wait (bounded) for the loader to create the native settings entry. */
async function waitForNativeEntry(loader) {
  for (let attempt = 0; attempt < LOCATE_ATTEMPTS; attempt += 1) {
    const entry = findNativeSettingsEntry(loader);
    if (entry !== undefined) return entry;
    await delay(LOCATE_INTERVAL_MS);
  }
  return undefined;
}

/**
 * Turn the native Session allow-list off at runtime.
 *
 * The native setting declares `enabled` and `allowedModels` with
 * `.volatile()`, so `Entry.update` takes its volatile-only path: the new value
 * is committed into the running service (no remount, no service churn) and,
 * because `Entry.update` is called instead of `EntryTree.update`, no journal
 * record is produced and the profile file is never rewritten.
 * @param ctx - Host context of this plugin.
 * @returns a short outcome tag for the log.
 */
async function takeOverNativeAllowList(ctx) {
  const loader = ctx.get('loader');
  if (!loader || typeof loader.entries !== 'function') {
    console.warn(`[subagent-model-guard] 无法接管原生白名单：Host 没有 Loader 服务。${MANUAL_HINT}`);
    return 'no-loader';
  }
  const entry = await waitForNativeEntry(loader);
  if (entry === undefined) {
    console.warn(`[subagent-model-guard] 找不到 ${NATIVE_SETTINGS_ID} 条目（profile 可能没有启用它），原生白名单本来就不会写入。`);
    return 'no-entry';
  }
  if (entry.disabled) return 'entry-disabled';
  if (liveEnabled(entry) === false) return 'already-off';

  // Keep every other key (notably allowedModels) exactly as configured: the
  // native setting throws when `enabled` is on with an empty route list, and a
  // leftover list is harmless while the switch is off.
  await entry.update({ config: { ...rawConfigOf(entry), enabled: false } });

  const after = liveEnabled(entry);
  if (after === false) {
    console.warn('[subagent-model-guard] 已在运行时把原生子智能体模型白名单设为 enabled: false（仅内存生效，未写配置文件）。');
    return 'taken-over';
  }
  console.warn(`[subagent-model-guard] 已提交 enabled: false，但原生设置没有确认生效（活值：${String(after)}）。${MANUAL_HINT}`);
  return 'unconfirmed';
}

/**
 * @param ctx - tool registry.
 * @param config - `{ routes, strict, checkInherited, takeOverNativeAllowList }`.
 */
export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {};
  const routes = Array.isArray(settings.routes) ? settings.routes : [];
  const strict = settings.strict !== false;
  const checkInherited = settings.checkInherited !== false;
  const allowedKeys = new Set(routes.map((route) => routeKey(route.provider, route.model)));

  if (settings.takeOverNativeAllowList === true) {
    // One-shot mutation, never fatal: a failure is reported as a warning and
    // the routes check below keeps working.
    Promise.resolve()
      .then(() => takeOverNativeAllowList(ctx))
      .catch((error) => {
        console.warn(`[subagent-model-guard] 接管原生白名单失败：${error instanceof Error ? error.message : String(error)}。${MANUAL_HINT}`);
      });
  }

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
      return deny(
        `这次派发没有指定 provider/model，会继承父级模型 ${key}，但它不在子智能体白名单里`
        + `（允许：${describeRoutes(routes)}）${layerHint}。${retryHint()}`,
        'inherited-route-not-allowed',
      );
    }
    return next();
  });
}

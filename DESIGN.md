# 子智能体路由守卫 · 设计文档

> 版本：v0.3 草案　·　目标插件：`@local/dsh-subagent-model-guard`
> 编写时间：2026-11-17　·　基于 DSH 0.2.2-rc.3

---

## 0. 一句话

**用户维护一张白名单，子智能体实际会用的模型必须精确命中其中一条，否则不允许启动。**
不管它来自 `subagent` 工具、`workflow` 的 `agent()`、显式指定还是继承父级。

---

## 0.1 方案全景（最终版）

本方案由**两个独立部件**组成，各自可开关：

| 部件 | 解决什么 | 默认 |
|---|---|---|
| **部件一：闸门**（A / B / both） | 在官方路径上加白名单校验，覆盖 `subagent` 工具与 `workflow` | 开（`enforcement: 'agent-created'`） |
| **部件二：替身**（`replaceSubagentTool`） | 用自己实现的 `subagent` 替换官方那个，**从根上绕开会话快照** | 关（`false`） |

- **只开部件一**：白名单管住了，但新上架的模型在旧会话里仍会被官方快照拦（不是我们拦的）。
- **再开部件二**：模型照常调 `subagent`，实际走 `startActivation`（无快照），新模型立即可用。

---

## 0.2 为什么需要"替身"（部件二）

官方 `subagent` 工具的执行链路：

```
subagent 调用
  → assertAllowedModelSelection(policy, ...)   ← 查会话启动时冻结的快照
  → startActivation → agent/created
```

**官方检查在 `agent/created` 之前**，用的是那个永久冻结的快照。我们的闸门（部件一）完全够不到它，因为：

- Session 日志只追加，无删改 API；
- 投影"第一条胜"，append 第二条被忽略；
- `firstLiveSeq === 0` 采样闸门对老会话永久关闭；
- fork / resume / 重开全部沿用旧值。

**所以只要不换掉那个工具，新模型 + 旧会话就永远用不了。**

替身的做法：在 agent scope 里注册同名工具，**shadow 掉全局的官方工具**（官方源码：`Scoped tools shadow globals`），然后在自己的实现里直调 `ctx.subagents.startActivation()` —— 那条路上没有任何快照检查。

---

## 1. 要解决的问题

### 1.1 现状

DSH 自带的子模型白名单（`subagent-model-selection-settings`）有三个硬伤：

| 问题 | 原因 |
|---|---|
| **白名单刷新不及时** | 会话启动时写一条 `subagent/model-selection-policy` 事件，投影"只取第一条"（`model-selection-state.ts`：`if (policy !== null) return policy`），**之后永久冻结**。改配置、刷新模型目录都不影响已存在会话。 |
| **继承路径不校验** | `assertAllowedModelSelection` 只在**显式指定** provider/model 时调用；省略模型走继承父级，**完全不检查**。 |
| **workflow 完全绕过** | workflow 的 `agent()` 走 `ctx.subagents.startActivation()`，全 asar 扫描确认 `assertAllowedModelSelection` 只存在于 `dsh-tool-subagent` 一个包，**workflow 一次都没调用**。 |

实测佐证：

| 调用方式 | 白名单外路由 | 结果 |
|---|---|---|
| `subagent(provider, model)` | `deepseek-account/deepseek-flash` | ❌ 被拒（查冻结快照） |
| `workflow` → `agent({provider, model})` | 同上 | ✅ **跑通了** |

### 1.2 本插件要做的

1. 白名单**由用户完全掌控**，精确匹配，无通配符、无后门、无自动加入；
2. 覆盖**所有**创建子智能体的路径，尤其是 workflow 这条暗道；
3. 拒绝时给出**可操作**的错误信息（列出白名单内容）。

### 1.3 明确不做

| 不做 | 理由 |
|---|---|
| `model: '*'` 通配 | 等于对某个 provider 完全放手，违背"授权清单"的语义 |
| 自动把新模型加进白名单 | 新模型未经批准就不该跑；要用就手动加一行，这是功能不是缺陷 |
| 改写已冻结会话的白名单 | Session 日志只追加（`handle.ts`："committed events are never rewritten"），无删除/改写 API |
| 抢先替官方写 policy | 技术上可行（`{prepend:true}` + `llm.listModels()`），但仍是"每会话快照"，照样过期，且写入**永久不可撤销**，会盖掉用户设置 |

---

## 2. 判定逻辑

```
派发子智能体
   ↓
取得它「实际会用」的 provider/model
   ↓
在白名单 routes 里精确查找
   ├─ 命中 → 放行
   └─ 未命中 → 拒绝（错误信息列出白名单内容）
```

**规则只有这一条。** 显式指定、继承父级、workflow 派发，一视同仁。

---

## 3. 两个挂载点

| 挂载点 | 管什么 | 状态 |
|---|---|---|
| `tools/pre-execute` | `subagent` / `subagent_fork` 工具调用 | 已实现，保留作为 **UX 层** |
| `agent/created` | **所有**创建路径（含 workflow） | 新增，**方案 A** |
| `internal/get` 包装 | 同上，但更早 | 新增，**方案 B** |

---

## 4. 方案 A：`agent/created` 事件闸门

### 4.1 原理

`agent/created` 是 cordis 的 **serial** 事件：监听器**按注册顺序逐个 await**，`agent-loop` 用 `await ctx.serial(...)` 调用它。

官方文档（`dsh-agent/src/runtime-types.ts`）原文：

> Listeners run in order and are **awaited before creation resolves**. AgentLoop **holds queued input until all listeners finish**. **A throw or rejection fails creation** and skips later listeners.

也就是说：**在这个监听器里 `throw`，子智能体就创建失败并回滚**。

### 4.2 为什么它能拿到正确的模型

`agent.options` 里**已经是最终路由**：

```ts
// dsh-subagent/src/manager.ts
const agentOptions = resolveChildAgentOptions(parent, spec.agentOptions, childDepth)
```

`resolveChildAgentOptions` 的逻辑是"父级路由打底 + 显式值覆盖"，所以：

- **显式指定** → `agent.options` 就是那个指定值；
- **省略继承** → `agent.options` 是父级当前路由。

**一条判据覆盖两种路径**，比现有 `tools/pre-execute` 里"自己推断父级"更准确。

### 4.3 时机优势：token 不烧

调用链顺序（`dsh-agent-loop/src/index.ts`）：

```
agents.enter(agent)
  → agents.announce(...)        ← agent/created 在这里，我们抛错
  → ready = true
  → submitMaterialized(prompt)  ← prompt 在这之后才投递
```

所以拒绝时**子智能体一辈子没被 prompt 过**，一次 LLM 请求都不会发。

### 4.4 实现草案

```js
ctx.on('agent/created', ({ agent }) => {
  let denial;
  try {
    if (!strict) return;
    if (routes.length === 0) return;                      // 空 = 不拦截

    const header = agent?.session?.header;
    // origin 是官方判别位；parentSession 存在 ≠ 子智能体
    if (header?.origin !== 'subagent') return;

    const provider = readRouteValue(agent.options?.provider);
    const model = readRouteValue(agent.options?.model);
    if (!provider || !model) {
      denial = fail('无法确认子智能体路由（provider/model 缺失）');
    } else if (!routes.some((r) => r.provider === provider && r.model === model)) {
      denial = fail(`拒绝创建子智能体：${provider}/${model} 不在白名单内（允许：${describeRoutes(routes)}）`);
    }
  } catch (error) {
    // 守卫自身出错：fail-open，不让 bug 变成"全都创建不了"
    console.warn('[subagent-model-guard] agent/created 闸门内部错误，放行：', error);
    return;
  }
  if (denial !== undefined) throw denial;                 // 业务拒绝 → 创建失败
}, { prepend: true });
```

配套工具函数：

```js
/** `agent.options` 的字段可能是 live accessor，也可能是纯值。 */
function readRouteValue(value) {
  const v = typeof value === 'function' ? value() : value;
  if (v && typeof v === 'object' && typeof v.get === 'function') return v.get();
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** 标记业务拒绝，与内部错误区分。 */
function fail(message) {
  return Object.assign(new Error(`[subagent-model-guard] ${message}`), { guardDenial: true });
}
```

### 4.5 优点

| 优点 | 说明 |
|---|---|
| **契约稳定** | `agent/created`、`origin`、`agent.options`、可 throw 都是**文档化契约**，不是内部实现 |
| **官方自己在用** | `dsh-permission-presets` 就用 `{prepend:true}` 在同一事件里做策略拒绝 |
| **一次挂载全覆盖** | `subagent` 工具、`workflow.agent()`、`create_personalized_page` 等所有走 `startActivation` 的路径都触发 |
| **拿得到真实路由** | 显式与继承都已合并完毕 |
| **token 零消耗** | prompt 尚未投递 |
| **代码量小** | 约 25 行，无需 import 内部包 |

### 4.6 缺点与边界

| 缺点 | 说明 | 应对 |
|---|---|---|
| **会留下空 session 记录** | `agent/created` 触发时 `setup()` 已 append `subagent/descriptor`；`dispose()` 只 flush/close，**不删文件**；持久层无删除 API | 见 §6；或用方案 B |
| **拦不住 `subagent` 的官方便检查** | 官方 `assertAllowedModelSelection` 在 `agent/created` **之前**执行，用冻结快照 | 官方拒了就是拒了，守卫只能提供更友好的错误；想用新模型 + 旧会话 → 用 workflow 派 |
| **外部后端拦不到** | `acp` / SDK provider 没有本地 Agent，`agent/created` 不触发 | 在 locale 里注明这个已知边界，不假装能拦 |
| **`prepend` 不是绝对第一** | 更晚 prepend 的插件会插到我们前面 | 影响极小：官方从不 prepend；即使被插队，我们仍是最后一道 |
| **resume 也会触发** | 冷恢复 continuable 子智能体会走同一路径 | 按配置决定（见 §5） |

---

## 5. 方案 B：`internal/get` 包装 `ctx.subagents`

### 5.1 原理

cordis 的服务读取会经过 `internal/get` waterfall。我们可以在别人拿到 `subagents` 服务时返回一个 **Proxy**，把 `startActivation` 包一层：

```js
ctx.on('internal/get', (caller, name, error, next) => {
  const service = next();
  if (name !== 'subagents' || typeof service?.startActivation !== 'function') return service;
  // ...返回包装后的 proxy
});
```

### 5.2 为什么它更早

`agent/created` 的时机是 "agent 对象已构造、session 已 prepare、descriptor 已 append"。
`startActivation` 的时机是 **"agent 还不存在"**——所以在这里拒绝是**真正的零残留**。

### 5.3 需要自己算路由

因为 agent 还没创建，`agent.options` 不存在，必须镜像 `resolveChildAgentOptions` 的逻辑：

```js
function resolveRoute(parent, spec) {
  // 父级路由优先取 request/header（这是父级"此刻实际在跑"的模型）
  const header = parent?.session?.requestHeader?.()?.config;
  const base = (header?.provider && header?.model)
    ? { provider: header.provider, model: header.model }
    : (parent?.options ?? {});
  // 显式值覆盖
  const provider = spec?.agentOptions?.provider ?? base.provider;
  const model = spec?.agentOptions?.model ?? base.model;
  return provider && model ? { provider, model } : undefined;
}
```

### 5.4 实现草案

```js
const proxies = new WeakMap();

export function apply(ctx, config) {
  ctx.on('internal/get', (caller, name, error, next) => {
    const service = next();
    if (name !== 'subagents' || !service || typeof service.startActivation !== 'function') return service;

    const cached = proxies.get(service);
    if (cached !== undefined) return cached;

    const proxy = new Proxy(service, {
      get(target, prop) {
        if (prop !== 'startActivation') {
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (spec) => {
          const route = resolveRoute(spec?.parent, spec);
          if (route !== undefined && rules.length > 0
              && !rules.some((r) => r.provider === route.provider && r.model === route.model)) {
            throw fail(`${route.provider}/${route.model} 不在白名单内（允许：${describeRoutes(rules)}）`);
          }
          return Reflect.apply(service.startActivation, service, [spec]);
        };
      },
    });

    proxies.set(service, proxy);
    return proxy;
  });
}
```

### 5.5 优点

| 优点 | 说明 |
|---|---|
| **零残留** | agent 根本没被构造，不会有空 session 文件 |
| **覆盖 workflow** | 它同样走 `startActivation` |
| **比 A 更早** | 拒绝时系统状态完全干净 |

### 5.6 缺点与边界

| 缺点 | 说明 |
|---|---|
| **依赖 `@experimental` 区域** | `internal/get` 在 cordis 源码里属实验区，未来可能变 |
| **拦不到跨进程调用** | typert Remote 在构造时就绑定了原始 service 引用（`dsh-typert-protocol`：`Object.freeze({service, ...})`），走 Remote 的调用**绕过 proxy** |
| **需要自己镜像路由合并逻辑** | 与 `resolveChildAgentOptions` 有分叉风险（DSH 升级改逻辑时不会同步） |
| **proxy 身份语义** | 每次读取返回不同对象会出问题；用 WeakMap 缓存缓解 |
| **代码量更大** | 约 45 行 |

---

## 5.5 部件二：替身 `subagent` 工具

### 5.5.1 原理

官方源码明确两件事：

- **`Scoped tools shadow globals`** —— agent scope 里注册的同名工具会盖掉全局的；
- **`Restrictions intersect; scoped registrations remain visible`** —— `restrict` 的 deny 不影响本 scope 自己注册的工具。

所以两步完成替换：

```js
ctx.on('agent/created', ({ agent }) => {
  if (!replaceSubagentTool) return;

  // 1. 挡掉官方的（作用于全局工具）
  agent.ctx.tools.restrict({ deny: ['subagent'] });

  // 2. 注册自己的同名工具（scoped 盖掉全局，且不受上面的 deny 影响）
  agent.ctx.tools.register({
    name: 'subagent',
    description: '...',
    parameters: { /* 与官方一致 */ },
    output: { schema: ..., render: ... },
    async execute(args, exec) { /* 见 5.5.3 */ },
  });
}, { prepend: true });
```

### 5.5.2 为什么不"转 workflow"

| 方案 | 问题 |
|---|---|
| 替身 → 拼 workflow 脚本 | **多一层 VM + 字符串拼接**：prompt 里的引号/反引号/换行要转义，长 prompt 还有脚本长度问题 |
| **替身 → 直调 `startActivation`** | 直接传对象，无转义、无额外 VM，**约 80 行** |

「直调」与「仿写」内核相同：都调 `ctx.subagents.startActivation()`。区别只在实现完整度。而 `startActivation` **本身就返回带 `result` 的 activation**，**生命周期由 DSH 管理，无需重写**。

### 5.5.3 执行逻辑（核心约 60 行）

```js
async execute(args, exec) {
  const parent = exec.agent;
  if (!parent) throw new Error('subagent tool requires a calling agent');

  // ① 路由：显式优先，否则继承父级
  const parentRoute = routeOf(parent);                 // session.requestHeader().config
  const provider = args.provider ?? parentRoute?.provider;
  const model = args.model ?? parentRoute?.model;
  if (!provider || !model) throw new Error('无法确定子智能体路由');

  // ② 白名单校验（官方快照检查在这里被彻底替换）
  if (!routes.some((r) => r.provider === provider && r.model === model)) {
    throw new Error(`路由 ${provider}/${model} 不在白名单内（允许：${describeRoutes(routes)}）。`);
  }

  // ③ 前置校验：provider/model 是否真实存在
  const llm = ctx.get('llm');
  if (llm !== undefined) {
    const models = await llm.listModels(provider);      // 凭据缺失返回 []
    if (!models.some((m) => m.id === model)) {
      throw new Error(`provider ${provider} 下没有模型 ${model}`);
    }
  }

  // ④ agent preset（v0.4）
  let agentPreset;
  if (args.agent_preset !== undefined) {
    if (ctx.get('agentPresets') === undefined) throw new Error('agent_preset 需要 agent-presets 服务');
    agentPreset = args.agent_preset;
  }

  // ⑤ 创建（生命周期由 DSH 管理）
  const started = await ctx.subagents.startActivation({
    provider: 'spawn',                       // 子智能体后端名，不是 LLM provider
    label: args.description,
    ...(args.name !== undefined ? { name: args.name } : {}),
    prompt: [{ type: 'text', text: args.prompt }],
    parent,
    agentOptions: {
      provider,
      model,
      ...(args.reasoning_effort !== undefined ? { reasoningEffort: args.reasoning_effort } : {}),
    },
    ...(agentPreset !== undefined ? { agentPreset } : {}),
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    maxDepth: ctx.subagents.resolveMaxDepth(undefined),
    signal: exec.signal,
    delivery: 'parent',                      // 必须：完成后通知父级
  });

  return { kind: 'activation', name: started.name };
}
```

### 5.5.4 递归天然受控

子智能体创建后 `agent/created` 会再执行一遍 → 给子智能体也注册替身 → 每层都受同一套白名单约束。无需额外处理。

### 5.5.5 `agent_preset` 透传（v0.4）

官方通过 `SubagentPresetSelection` 消费 `agentPresets` 服务：

- 服务名：`ctx.agentPresets`（`dsh-agent-preset-registry` 提供）
- 传递方式：`startActivation({ agentPreset })`

接入要点：
- `ctx.get('agentPresets')` 可选依赖，缺失时报错而非崩溃；
- 参数声明用 `enum` 列出可选预设 id（若注册表能列出）；
- 值直接放进 `startActivation` 的 `agentPreset` 字段。

### 5.5.6 优点

| 优点 | 说明 |
|---|---|
| **彻底绕开快照** | `startActivation` 链路上没有任何模型白名单检查（全 asar 确认） |
| **新模型立即可用** | 不用开新会话、不用等快照刷新 |
| **模型零学习成本** | 工具名、参数、返回值与官方一致 |
| **白名单唯一** | 不再有"官方一套 + 我们一套" |
| **零残留** | 拒绝时 agent 尚未创建 |
| **递归受控** | 每层都走同一闸门 |

### 5.5.7 缺点与风险

| 风险 | 说明 | 应对 |
|---|---|---|
| **依赖 `startActivation` 契约** | 文档化服务方法，但仍需跟随升级 | 版本锚定 + 升级后回归 |
| **无法完全复刻官方语义** | `delegationTools`、`subagent/provider-added` 监听、preset 解析细节 | 第一版不做，按需补 |
| **`maxDepth` 语义** | `resolveMaxDepth(undefined)` 取部署默认 | 若不希望孙智能体，显式传 `1` |
| **同名注册冲突** | 若同 scope 已有注册 | 先 `restrict` deny 全局，再 register scoped |
| **shadow 是否真生效** | 未实测 | **必须实测** `ctx.tools.listTools()` 确认只有一个 `subagent` |

## 6. 空 session 记录问题

### 6.1 事实

| 环节 | 行为 | 证据 |
|---|---|---|
| `agent/created` 抛错 | 走 `dispose()` → `teardown()` | `dsh-agent-loop/src/index.ts` catch 分支 |
| `teardown()` | 只 flush / close，**不删文件** | 读 dispose 实现，无 unlink |
| 持久层 API | `open` / `read` / `append` / `flush` / `close` —— **没有 delete** | `dsh-session-persistence-jsonl/src/storage.ts` |
| `close()` | 会 `drainLive()` 落盘 | 所以文件真的会留下 |

**结论：方案 A 被拒后会留下一个孤儿 session 文件（含 `subagent/descriptor` 等几条事件）。**

### 6.2 三级应对

| 方案 | 做法 | 评价 |
|---|---|---|
| **改选 B** | `start-activation` 在 agent 构造前拒绝 | ✅ **推荐**：零残留是设计保证，不是事后擦屁股 |
| 事后清理 | 记下被拒 session id，稍后确认未运行 → 删目录 + 删投影缓存行 | ⚠️ 需要磁盘手术，违背不变量，风险大于收益 |
| 定时清扫 | 启动时扫"只有 descriptor、无真实对话、超 N 天"的目录 | ⚠️ 可能误删真正空的会话 |

**本鱼建议：不清。** 一个空 session 文件几 KB，不出现在会话列表里，不干扰使用。真要零残留 → 让用户选 B。

---

## 7. 配置项

```js
export const Config = Schema.object({
  // ── 白名单（核心）──────────────────────
  routes: Schema.array(Schema.object({
    provider: Schema.string().required(),
    model: Schema.string().required(),
  })).default([])
    .description('允许子智能体使用的 provider/model，精确匹配。为空表示不拦截。'),

  // ── 拦截方式（用户可选）────────────────
  enforcement: Schema.union([
    Schema.const('agent-created'),
    Schema.const('start-activation'),
    Schema.const('both'),
  ]).default('agent-created')
    .description(
      'agent-created：官方契约最稳，覆盖 subagent 与 workflow；被拒会留下一个空 session 记录（不影响使用）。'
      + 'start-activation：在 agent 构造前拒绝，零残留；依赖 internal/get 内部机制，且拦不到跨进程调用。'
      + 'both：两处都拦，A 失败由 B 兜底，最严。',
    ),

  // ── 校验范围 ───────────────────────────
  checkInherited: Schema.boolean().default(true)
    .description('是否也校验「省略模型 → 继承父级」这条路径。关闭后只拦显式指定。'),

  // ── 部件二：替身（用户可选）────────────
  replaceSubagentTool: Schema.boolean().default(false)
    .description(
      '用本插件实现的 subagent 替换官方工具（scoped shadow）。'
      + '开启后子智能体走 startActivation，完全绕开 DSH 的会话快照，新上架模型立即可用；'
      + '关闭则保留官方工具（受快照限制，但契约最稳）。',
    ),

  // ── 每步兜底（用户可选）────────────────
  guardEveryStep: Schema.boolean().default(false)
    .description(
      '开启后在每一步模型调用前也校验（agent/pre-step）。'
      + '能拦住"agent 创建后被切到白名单外模型"的情况，代价是每个 step 多一次检查。',
    ),

  // ── 行为 ───────────────────────────────
  strict: Schema.boolean().default(true)
    .description('总开关，关闭后整段守卫失效。'),
})
```

### 7.1 用户可选的组合

| 配置 | 效果 | 适合谁 |
|---|---|---|
| `agent-created` + 白名单（默认） | 稳、覆盖全部路径；被拒可能留空记录 | 大多数人 |
| `start-activation` + 白名单 | 同效果、**零残留** | 在意会话目录干净 |
| `both` + 白名单 | 双保险 | 极度在意 |
| **`replaceSubagentTool: true`** | **绕开快照，新模型立即可用** | 想用最新模型且不想开新会话 |
| `guardEveryStep: true` | 连"创建后换模型"也拦 | 最严 |
| `checkInherited: false` | 只拦显式指定，继承随便 | 认为继承本就该放行 |
| `strict: false` | 完全关闭 | 临时排障 |

### 7.2 插件页表现

`export const Config` 会被 DSH 自动渲染成表单（与 `dsh-win-pwsh7` 的 `overridePath` 同一机制）：

```
子智能体路由守卫
├─ 白名单 routes                [可增删条目：provider / model]
├─ 拦截方式 enforcement         [下拉：agent-created / start-activation / both]
├─ 替换 subagent 工具           [开关]  ← 绕开快照
├─ 每步兜底 guardEveryStep      [开关]
├─ 检查继承 checkInherited      [开关]
└─ 总开关 strict                [开关]
```

---

## 8. 内部处理（不给用户配置，但必须做对）

| 情况 | 处理 | 理由 |
|---|---|---|
| 守卫自身代码出错 | **放行** + `console.warn` | 守卫崩溃不该变成"子智能体全都创建不了" |
| 业务拒绝 | 抛带 `guardDenial` 标记的错误 | 与内部错误区分，避免 fail-open 吞掉真拒绝 |
| 读 fork 继承的 policy | 用 `session.snapshotEvents()` 而非 `ownEvents()` | `ownEvents()` 剔除继承前缀，对 fork 子会话是瞎的（**现有 bug**） |
| `agent.options` 字段 | 兼容 live accessor / getter / 纯值 | 源码注释："live accessors apply until the Session records a selection" |
| 外部后端（acp/SDK） | 拦不到，locale 里注明 | 不能假装能拦 |

---

## 9. 三层职责

```
第一层  tools/pre-execute   →  UX：给模型早期、可读的错误 + 重试提示（保留）
第二层  agent/created       →  硬闸门 A（enforcement 决定）
第三层  internal/get 包装   →  硬闸门 B（enforcement 决定）
```

---

## 10. 实施与验证

| 步 | 内容 | 验证方式 |
|---|---|---|
| 1 | 加 `enforcement` 配置项 | 插件页能渲染出表单 |
| 2 | 实现 `agent/created` 闸门 | workflow 派白名单外 → 被拒；派白名单内 → 放行 |
| 3 | 实现 `internal/get` 包装 | 切到 B 模式，行为一致且无空 session |
| 4 | 修 `ownEvents` → `snapshotEvents` | fork 子会话能读到父 policy |
| 5 | 重装 + 三种 enforcement 各测一遍 + 提交 | 全通 |

---

## 11. 已知边界（诚实清单）

| 边界 | 影响 |
|---|---|
| `subagent` 工具的官方便检查在上游 | 新模型在旧会话里用 `subagent` 工具**仍被官方拒**；想用新模型 + 旧会话 → 用 workflow |
| 外部后端（acp/SDK） | `agent/created` 不触发，拦不到 |
| B 的跨进程缺口 | typert Remote 调用绕过 proxy |
| 空 session 记录（A） | DSH 无删除 API，只能靠选 B 规避 |
| 已冻结会话 | 无法从程序改写（日志只追加） |

---

## 12. 附录：关键代码事实索引

| 事实 | 位置 |
|---|---|
| `agent/created` 是 serial，抛错失败创建 | `dsh-agent/src/runtime-types.ts`、`dsh-agent/src/index.ts`（`ctx.serial(...)`） |
| `origin === 'subagent'` 是官方子智能体判别位 | `dsh-session/src/types.ts` |
| `agent.options` 含最终路由（显式+继承已合并） | `dsh-subagent/src/manager.ts` → `resolveChildAgentOptions` |
| prompt 在 `agent/created` 之后投递 | `dsh-agent-loop/src/index.ts` |
| workflow 走 `startActivation`，无白名单校验 | `dsh-workflow-ptc/src/host.ts` |
| `assertAllowedModelSelection` 只在 `dsh-tool-subagent` | 全 asar 扫描确认 |
| policy 投影"第一条胜" | `dsh-tool-subagent/src/model-selection-state.ts` |
| Session 日志只追加，无删除 API | `dsh-session-persistence/src/handle.ts` |
| `ownEvents()` 剔除继承前缀 | `dsh-session/src/index.ts` |
| `internal/get` 可拦截服务读取 | `cordis/src/reflect.ts` |
| typert Remote 绑定原始 service | `dsh-typert-protocol/src/index.ts` |

---

## 13. 决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 是否支持通配符 | **否** | 白名单是授权清单，逐条授权；通配等于开后门 |
| 是否自动加新模型 | **否** | 新模型未经批准不该跑 |
| 是否抢先写官方 policy | **否** | 仍是快照、照样过期、永久不可撤销、会盖用户设置 |
| 默认 enforcement | `agent-created` | 契约最稳，官方自己也在用 |
| 空 session 是否清理 | **不清理** | 收益小风险大；要零残留就选 B |

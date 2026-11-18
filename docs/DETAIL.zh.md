# 子智能体路由守卫

子智能体路由守卫在子智能体派发前校验它实际会运行的 `provider/model`，用白名单、黑名单和两个可选拦截点控制「谁能派给谁」。

## 它解决什么问题

DSH 官方的子智能体白名单（`subagent-model-selection-settings` 的 `allowedModels`）在会话启动时被冻结成一份快照：会话开着的时候新上架的模型，在老会话里用不了。这个插件要解决的就是这件事，并额外提供一套「谁能派给谁」的显式策略——哪些路由允许、哪些显式拒绝，都由你说了算。官方名单通过 `subagentModelSelection.current()` 实时读取，每次校验都重算，所以官方白名单的改动和本插件配置的改动都能立刻生效，无需重载。

## 一次派发要过哪几道关

```
  subagent / subagent_fork 派发
             |
             v
  +---------------------------+
  | 1. 路由能否确定？          |
  |    provider/model 缺失？   |
  +------------+--------------+
       yes(确定) | no(不确定)
               v            v
   +----------------+   +---------------------------+
   | 2. deniedRoutes|   | 放行 + 记录（不硬拒）      |
   |    黑名单？     |   | 外部 acp/SDK 后端不触发    |
   +-------+--------+   | agent/created，无法观察    |
   命中   |   未命中    +---------------------------+
     v        v
   拒绝    +------------------------------------+
           | 3. 白名单：官方 allowedModels        |
           |    + 本插件 routes，实时合并去重     |
           |    （两者都为空 => 不拦截）          |
           +------------+-----------------------+
                命中   |   未命中
                  v       v
               +-------------+
               | 4. 拦截点   |
               | agent-created|
               | 或          |
               | start-activation (可选 both) |
               +------+------+
                      v
                 放行 / 拒绝
```

## 白名单与黑名单的优先级

放行名单来自两个来源：`useOfficialAllowList`（默认开启）读取的官方 `allowedModels`，加上本插件自己的 `routes`，两者实时合并、去重。只有两者都为空时才不拦截。

`deniedRoutes` 是显式黑名单，优先级高于一切白名单（包括官方 `allowedModels`）：命中这里的组合一律拒绝，即使它同时出现在白名单里。原因是「显式拒绝」代表一个刻意的「不」——当你特意把某条路由列为拒绝时，它出现在任何放行名单里都只是遗漏，不应该反过来把拒绝给覆盖掉。

## 两个拦截点怎么选

`enforcement` 决定在哪儿校验，默认 `agent-created`：

- **`agent-created`**：在 `agent/created` 事件处校验。契约稳定、覆盖 workflow 里的 `agent()`；代价是被拒时会留下一个空的 session 记录。
- **`start-activation`**：包住 `ctx.subagents`，在 agent 构造之前拒绝，零残留；代价是依赖内部的 `internal/get` 钩子。
- **`both`**：两处都校验，用零残留换取双重保障。

两处闸门始终注册，由 `enforcement` 实时决定行为；改配置写的是 volatile 字段，不需要重载。

## 替身工具

`replaceSubagentTool`（默认关闭）用本插件自己的 `subagent` 工具取代官方工具（一个 scoped shadow），让子智能体直接走 `startActivation`，绕开会话启动时冻结的模型快照——新上架的模型在老会话里也能立即可用。

代价是它只 shadow `subagent` 这一个工具：`subagent_fork` 仍然使用官方工具，继续受同一份会话模型快照限制。替身工具在 `agent/created` 时注册到各个 agent scope，并对已存在的 agent 做一次补齐。

## 典型用法

**只允许某一个模型**（并保留官方名单）：
```json
{
  "useOfficialAllowList": true,
  "routes": [{ "provider": "workbuddy", "model": "hy4flash-free" }]
}
```

**禁止某一族 provider**（黑名单优先，即使它在白名单里）：
```json
{
  "deniedRoutes": [{ "provider": "untrusted", "model": "*" }],
  "routes": [{ "provider": "untrusted", "model": "*" }]
}
```

**新模型上线后老会话立刻可用**（开启替身工具，绕开冻结快照）：
```json
{
  "replaceSubagentTool": true,
  "routes": [{ "provider": "workbuddy", "model": "brand-new-model" }]
}
```

## 自查

`guard_selfcheck` 是一个只读诊断工具，无参数、不改变任何状态。它返回：守卫是否生效（`active`）、严格模式与 `enforcement` 模式、官方与本插件的白名单、`deniedRoutes` 黑名单、生效路由数、两道闸门与替身工具的安装情况、最近拒绝计数，以及逐项的 `checks`。

其中 `officialAllowList` 能区分三种状态，方便排查「为什么这个路由被放行/拒绝」：

1. **服务不可用**：`available:false`，并带 `error`（`subagentModelSelection` 未挂载或缺少 `current()`）；
2. **官方 `enabled:false`**：`available:true, enabled:false`，`routes` 为空，**没有** `error`（这是正常状态，官方名单不施加限制）；
3. **官方 enabled 但列表为空**（`current()` 抛错）：`available:true`，`error` 有值，`routes` 为空。

当新模型用不了、某个路由意外被放行、或想确认守卫是否真的生效时，用它看一眼最省事。

## 已知限制

- 外部 acp/SDK 后端不触发 `agent/created`，而且不暴露本地的 provider/model；这种情况下守卫无法确定路由，选择**放行并记录**（fail-open），不会硬拒。
- 每步审计（`auditEveryStep`，默认关闭）只写日志、不拦截：走到模型调用这一步说明创建阶段的校验已漏网，此时拒绝会变成「创建成功但立刻失败」，所以只留痕。
- 最近拒绝记录只存在于进程内存（`recentDenialLimit` 默认 0），绝不落盘——拒绝原因含模型名，属于隐私。

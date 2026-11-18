# 子智能体模型路由守卫（dsh-subagent-model-guard）

一个为 DeepSeek Harness 的「派发子智能体」把门的 DSH 插件：按 provider/model 白名单拦截子智能体路由，堵住「省略模型就静默回退父级模型」这条绕过口子，并可选替换官方 `subagent` 工具让新上架模型立即可用。**它不新增业务工具，只守卫与替换已有的派发能力，另提供一个只读诊断工具。**

## 它提供什么

它对 DSH 已有的派发链路做四件事：

- **路由校验（Gate）**：在 `agent/created` 和/或包住 `ctx.subagents`（由 `enforcement` 决定 `agent-created` / `start-activation` / `both`）校验子智能体真正要跑的 provider/model。两条路径都覆盖——既管官方 `subagent` 工具，也管 workflow 里绕过工具层的 `agent()`。守卫对象包括官方 `subagent` 与 `subagent_fork` 两个派发工具（`tools/pre-execute` 层负责给出可读的拒绝原因）。
- **可选替换官方 `subagent` 工具**（`replaceSubagentTool:true`）：用本插件自己的 `subagent` 影子实现（scoped shadow）取代官方全局工具，直接走 `ctx.subagents.startActivation()`，绕开官方工具在会话创建时冻结的模型白名单快照，让新发布的模型在旧会话里也能立刻使用；`subagent_fork` 刻意不替换（它的 `fork` provider 行为不同，半吊子的影子只会更糟）。影子工具的 `cwd` 参数**始终可用**（它早已不再是设置项），用于指定子智能体的初始工作目录；`maxDepth` 可以是设置项形式的递归深度上限。
- **审计与拒绝记录**：可选的每步审计（`auditEveryStep`，只记不拦）与内存中的最近拒绝记录（`recentDenialLimit`，绝不落盘，因为包含模型名）；审计可按 `auditDedupeMs` 去重。
- **只读自检工具 `guard_selfcheck`**：无参数、严格只读、不改任何状态；报告本插件实例的当前生效状态（严格/启用标志、enforcement 模式、官方与本插件白名单、显式拒绝名单、闸门与替换工具安装情况、最近拒绝计数），供排查「某个路由为何被放行或拒绝」。它是诊断工具，不是业务工具。

默认放行依据是 DSH 官方的子智能体白名单（`useOfficialAllowList:true`，读 `subagentModelSelection` 服务的 `allowedModels`），本插件的 `routes` 作为额外补充；`deniedRoutes` 是显式拒绝，优先级高于一切白名单。空白名单 = 不拦截（与 DSH 原生行为一致），但「只有拒绝项」的配置仍然生效（黑名单模式）。

它带**设置页**：总开关、白名单来源、允许/拒绝路由列表、错误信息是否暴露名单、审计与去重、执行点（三选一）、工具替换及其参数（`maxDepth`、`checkInherited`）。原设置项 `cwd` 已移除；`cwd` 现在是子智能体工具始终可用的参数。

## 安装（本地 bundle）

本插件以 `link:` 方式装进你的 profile（vendored 依赖必须随目录链接，见下方「已知限制」）。插件包自带的 `cordis.patch.yml` 内容为：

```yaml
- insert:
    - id: subagent-model-guard
      name: '@local/dsh-subagent-model-guard'
```

在 profile 的 `cordis.patch.yml` 里插入同样一条，即可把 `@local/dsh-subagent-model-guard` 这一行挂到 Loader：

```yaml
- insert:
    - id: subagent-model-guard
      name: '@local/dsh-subagent-model-guard'
```

`id` 是 Loader 行 id，`name` 必须与 `package.json` 的 `name` 一致。装好后到插件页配置白名单/黑名单与执行点；若要用新上架模型，打开 `replaceSubagentTool`。

## 配置项

与 `index.js` 中的 `Config`（Schemastery schema）完全一致，共 **12 项**；全部为 `.volatile()`，保存后立即生效，无需重启插件：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `strict` | boolean | `true` | 关闭后整段守卫失效，所有路由一律放行。 |
| `useOfficialAllowList` | boolean | `true` | 直接采用 DSH 官方子智能体白名单（`subagent-model-selection-settings` 的 `allowedModels`）作为放行依据；开启后下方 `routes` 只作额外补充。 |
| `routes` | object[] | `[]` | 额外的允许路由；每项 `{ provider, model, note? }`（provider/model 必填）。与官方白名单都为空表示不拦截。 |
| `deniedRoutes` | object[] | `[]` | 显式拒绝的路由；每项 `{ provider, model, note? }`。优先级高于一切白名单（含官方 `allowedModels`），命中一律拒绝。 |
| `includeAllowedListInError` | boolean | `true` | 拒绝时是否在错误信息里列出当前生效的名单；关闭后只说明被拒路由，不暴露其余模型名。 |
| `recentDenialLimit` | number | `0` | 内存里保留最近 N 条拒绝记录（0 = 不记录）；只活在进程内存里，绝不落盘。 |
| `auditDedupeMs` | number | `0` | 同一个 agent + 路由在此时间窗（毫秒）内只记一条审计日志（0 = 不去重），避免刷屏。 |
| `enforcement` | enum | `"agent-created"` | 校验点：`agent-created`（契约稳定、覆盖 workflow，但被拒会留一个空 session 记录）/ `start-activation`（agent 构造前拒绝、零残留，依赖 internal/get）/ `both`（两处都校验）。 |
| `replaceSubagentTool` | boolean | `false` | 用本插件实现的 `subagent` 取代官方工具（scoped shadow）；开启后直接走 `startActivation`，绕开会话模型快照，新模型立即可用；关闭则保留官方工具。 |
| `maxDepth` | natural 或 null | `null` | 替换工具派发子智能体时使用的**最大递归深度上限**；留空（null）沿用 DSH 部署默认，填 1 表示子智能体不能再派子智能体。注意它只是上限（cap），实际深度仍不超过 DSH 自身限制。 |
| `checkInherited` | boolean | `true` | 是否检查「省略模型、回退父级」的继承路径。 |
| `auditEveryStep` | boolean | `false` | 在每一步模型调用时检查路由是否在白名单内，只记录不拦截（此时拒绝会导致「创建成功却立刻失败」，故只写 host 日志）。 |

> 原第 13 项 `cwd` 已删除：`cwd` 不再是配置字段，影子 `subagent` 工具的 `cwd` 参数现在始终可用，无需先开启某个设置。

## 已知限制 / 注意事项

- **vendored 依赖**：`node_modules/@deepseek-ai/schemastery` 与 `@deepseek-ai/cosmokit` 随包附带（见 `VENDORED.md`），只能用 `link:` 安装；`npm pack` / 仓库安装会丢掉 `node_modules` 导致配置表单失效。升级 DSH 后需从新 `app.asar` 重新提取对齐版本。
- **执行点有取舍**：`agent-created` 被拒会留下一个空 session 记录；`start-activation` 依赖内部 `internal/get` 服务，可能在未来 DSH 版本变动；按需选择 `both`。
- **替换工具仅覆盖 `subagent`**：`subagent_fork` 因 provider 语义不同刻意不替换；`tools/pre-execute` 层仍会对官方 `subagent_fork` 给出拒绝说明，但它本身不会被影子实现接管。影子工具支持 `cwd` 参数（始终可用），但不支持 `fork` provider。
- **官方白名单读取依赖 `subagentModelSelection` 服务**；服务不可用、官方开关未启用（`enabled !== true`）或其 `current()` 抛错时，本次只按本插件自己的 `routes` 校验，并通过 `ctx.logger` 单次告警。
- **拒绝记录不落盘**：`recentDenialLimit` 只影响内存缓冲，重启即清空——这是刻意设计（模型名属于隐私）。`guard_selfcheck` 读取的拒绝计数同样只反映当前进程内存。
- `maxDepth:null` 表示「未设置」（沿用部署默认），不要误解为 0（0 会被解读成硬禁止递归）；它是上限语义，不会突破 DSH 自身的深度限制。
- `guard_selfcheck` 只报告状态、不修改任何配置或队列；即使某个配置引用或服务损坏，其外层捕获也保证它不会抛错（会以 `ok:false` 的 check 呈现）。

## 安全说明（哪些操作有破坏性）

- 本插件**不删除文件、不联网、不执行 shell**；最坏影响是拒绝一次子智能体派发（在 `tools/pre-execute` 返回 `kind:'deny'`，或替换工具的 `execute` 抛错）。`guard_selfcheck` 完全只读。
- 开启 `replaceSubagentTool` 会**屏蔽官方全局 `subagent` 工具并注册自己的影子版本**，影响所有 agent（含当前会话已存在的 agent）。影子实现只支持 `spawn` provider，不支持 `fork`；如依赖 fork 语义，请保持关闭。
- 关闭 `strict` 会让整段守卫失效、所有路由放行；`enforcement`/白名单设置仍在但不起作用，请勿误以为仍受保护。
- `deniedRoutes` 是显式拒绝，命中即拒（即使同组合在白名单里）；配置错误可能导致合法派发被拒。
- `includeAllowedListInError:true` 会在拒绝信息里列出允许的模型名；若不愿暴露模型名，请关闭。

## License

MIT © 2026 dafeiyu。详见 [LICENSE](LICENSE)。

---

**English summary:** A DeepSeek Harness plugin that gates subagent delegation by provider/model allow-list, covering both the official `subagent` tool and workflow `agent()` calls. It can optionally shadow the official `subagent` tool so newly published models work in old sessions, provides audit logging plus in-memory denial records (never persisted), and adds a read-only `guard_selfcheck` diagnostic tool with no parameters. It registers no new business tool; twelve volatile settings (the former `cwd` setting is gone — `cwd` is now always available as a tool parameter, and `maxDepth` is a depth cap) control the allow/deny lists, enforcement point, and tool replacement. Link-installed with vendored Schemastery; licensed MIT.

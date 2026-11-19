# 发布到 GitHub 的清单（dsh-subagent-model-guard）

> 本文件只是发布操作说明。**准备阶段不执行其中任何命令**；确认无误后由维护者手动发布。

## 建议的远端仓库

- 仓库名：`dsh-subagent-model-guard`
- 描述：`DeepSeek Harness plugin that gates subagent delegation by provider/model allow-list, including the silent parent-route fallback, with optional official-tool replacement.`
- License：MIT
- 建议 topic：`deepseek-harness`、`dsh-plugin`、`subagent`、`model-guard`

## 发布前要改的占位符

- `package.json` 的 `repository.url` / `bugs.url` / `homepage` 目前指向 `https://github.com/a-molecule-of-ATP/dsh-subagent-model-guard.git`，确认 GitHub 用户名 `a-molecule-of-ATP` 与仓库名无误；若实际账号不同，全局替换 `a-molecule-of-ATP/dsh-subagent-model-guard`。
- `LICENSE` 的版权行为 `Copyright (c) 2026 a-molecule-of-ATP`，确认年份与署名。
- `README.md` 安装段落里的 `name: '@local/dsh-subagent-model-guard'` 与 `package.json` 的 `name` 必须一致（当前一致）。
- **确认 vendored 依赖会随仓库提交**：`package.json` 的 `files` 用 `node_modules/**` 声明，`.gitignore` 只忽略 `node_modules/.cache`，不会忽略 schemastery / cosmokit。仓库必须带上 `node_modules/@deepseek-ai/{schemastery,cosmokit}`，否则 clone 后无法使用。
- 仓库里还有 `DESIGN.md`、`stress.mjs`、`client-stress.mjs`、`volatile-form.mjs` 等开发/压测文件，确认是否要一并发布（任务只要求动 5 个文件，其余保持原样）。

## 发布命令（仅文档，勿在此阶段执行）

```bash
cd dsh-subagent-model-guard
git add -A && git commit -m "chore: prepare dsh-subagent-model-guard for GitHub release"
git remote add origin https://github.com/a-molecule-of-ATP/dsh-subagent-model-guard.git
git push -u origin main
```

发布 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

## 建议的 tag 名

- `v0.1.0`（与 `package.json` 的 `version` 一致）

## 发布后核对

- GitHub 仓库页面的 License 被识别为 MIT。
- `README.md` 渲染正常，13 项配置表格齐全。
- 仓库包含 `node_modules/@deepseek-ai/{schemastery,cosmokit}`，用户 `link:` 安装后可正常使用设置页。
- `VENDORED.md` 中的版本与 DSH 安装里的 schemastery / cosmokit 对齐。

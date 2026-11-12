# Batch Replace for JSON & YAML

不用写 yq/jq/sed 命令，在界面里按路径或正则批量改多个 JSON/YAML/任意文本文件，逐条预览 diff，一次 Ctrl+Z 全部撤销。

安装插件即可使用全部功能，**不需要**在机器上额外安装 Node.js、npm、jq、yq、sed、Git Bash、Python 或任何外部命令行工具。JSON/JSONC 由 `jsonc-parser`、YAML 由 `yaml` 在插件内解析，sed 风格替换由进程内 JS 正则执行；所有依赖随 `.vsix` 一起分发。

> 当前状态：开发中（M1 核心引擎阶段）。此版本提供可运行的扩展骨架、命令注册与核心类型定义。

## 它能做什么

- **结构化引擎**：按路径对 JSON/JSONC、YAML/YML 批量 `set` / `delete` / `insert`，最小补丁写回，注释、键序、缩进、引号风格、行尾逐字节保留。
- **文本引擎**：`s/…/…/flags` 替换、`/pat/d` 删除行，适用于所有文本类型。
- **文件范围三层管道**：目录/路径选择 → 扩展名策略（结构化固定只读、文本全部或自定义）→ 树筛选与跨目录批量勾选、逐个审阅。
- **统一预览**：每条命中一个 diff，勾选后一次 `workspace.applyEdit` 应用，一次撤销全部还原。

## 命令

| 命令 | 说明 |
|---|---|
| `Batch Replace for JSON & YAML: Open Batch Edit Panel` | 打开批量编辑面板 |
| `Batch Replace for JSON & YAML: Use Cursor Path` | 编辑器右键：光标路径填入面板（结构化） |
| `Batch Replace for JSON & YAML: Use Selection as Pattern` | 编辑器右键：选区转义为文本 pattern |
| `Batch Replace for JSON & YAML: Apply Expression Set File` | 直接应用某个 `.structedit.json` |
| `Batch Replace for JSON & YAML: Show Last Report` | 查看上次执行报告 |
| `Batch Replace for JSON & YAML: Select All Filter Matches` | 全选当前筛选命中的文件 |
| `Batch Replace for JSON & YAML: Review Matches One by One` | 进入依次选择 / 逐个审阅 |

## 开发

以下命令仅用于开发者本地构建与测试，与最终用户无关（最终产物是自包含的 `.vsix`）：

```bash
npm ci
npm run compile   # TypeScript 严格类型检查
npm run build     # esbuild 打包到 dist/extension.js
npm test          # core/ 单元测试
```

在 VS Code 中按 F5 启动 Extension Development Host。

## 发布前

- 把 `package.json` 的 `publisher` 改成自己的 Marketplace publisher ID；**仅上传 GitHub 不需要改**。
- 上传到 GitHub 后，把仓库 URL 填入 `package.json` 的 `repository` 字段（当前故意留空，打包用 `--allow-missing-repository` 放行）。
- `npm run package` 产出 `.vsix`；esbuild 以 `--legal-comments=linked` 提取第三方许可注释，`THIRD-PARTY-NOTICES.md` 随包分发。
- 设计规格见仓库内 `structured-batch-edit-spec.md`。

## 许可

MIT。第三方许可见 `THIRD-PARTY-NOTICES.md`。

# Batch Replace for JSON & YAML

不用写 yq/jq/sed 命令，在界面里按路径或正则批量改多个 JSON/YAML/任意文本文件，逐条预览 diff，一次 Ctrl+Z 全部撤销。

安装插件即可使用全部功能，**不需要**在机器上额外安装 Node.js、npm、jq、yq、sed、Git Bash、Python 或任何外部命令行工具。JSON/JSONC 由 `jsonc-parser`、YAML 由 `yaml` 在插件内解析，sed 风格替换由进程内 JS 正则执行；所有依赖随 `.vsix` 一起分发。

> 当前版本 0.1.4：三步向导式交互（① 选择文件 → ② 编辑值 → ③ 预览并应用）、双击文件弹框预览源文件、树勾选对勾修复、界面视觉重构；修复 0.1.2 反馈的 5 个缺陷（选择目录弹窗、`.yml` 识别、列表显示、路径 glob 筛选、改值后生效）；**点「应用」直接保存，不再弹逐条确认**（文件再多也能一键完成，误改一次 Ctrl+Z 撤销）。
> **懒加载**：打开面板不扫描任何文件；设定目录 / 过滤条件后点「扫描文件」才扫描，勾选与筛选变化只做轻量重算（不重复 `findFiles`、不重复读盘）。
> **仅 `Ctrl+Alt+B` 启动编辑器 Tab 面板**；已移除 Activity Bar 侧边栏图标与视图。
> `npm run test:integration` 在真实 VS Code（Linux headless / xvfb-run）跑通全部用例；单测 76/76（含「选文件 → 改值 → 预览 → 应用」端到端流程）。
> 仍需人工：四主题目视走查、键盘焦点环、300px 窄宽度、三步向导完整交互冒烟；如实记录见 `UI-DELIVERY.md`。

## 它能做什么

- **结构化引擎**：按路径对 JSON/JSONC、YAML/YML 批量 `set` / `delete` / `insert`，最小补丁写回，注释、键序、缩进、引号风格、行尾逐字节保留。
- **文本引擎**：`s/…/…/flags` 替换、`/pat/d` 删除行，适用于所有文本类型。
- **文件范围三层管道**：目录/路径选择 → 扩展名策略（结构化固定只读、文本全部或自定义）→ 树筛选与跨目录批量勾选、逐个审阅。
- **扫描根可切换**：默认以 VS Code 打开的工作区根目录扫描，点「选择目录…」可改到任意目录（含工作区之外），随时「恢复工作区根目录」。
- **筛选支持路径 glob**：`aaa/bbbb/xs*.yml`、`xs*.yml`、`ext:yaml,yml`、`!legacy` 均可；筛选只决定显示/批量范围，勾选始终以复选框为准。
- **统一预览**：每条命中一个 diff，勾选后一次 `workspace.applyEdit` 应用，**点应用即保存（不弹确认）**，一次撤销全部还原；应用前做内容 hash 二次校验。
- **表达式集**：`.structedit.json`（v3）导入导出、团队共享，读取旧版自动升级。

## 命令

| 命令 | 说明 |
|---|---|
| `Batch Replace for JSON & YAML: Open Batch Edit Panel` | 打开批量编辑面板（**唯一入口**：命令面板或 `Ctrl+Alt+B`） |
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
npm test          # 单元测试（76 例：core/ 纯逻辑 + host/ 端到端修改流程）
npm run build     # esbuild 打包 + 复制 Webview 资源到 dist/ui/
npm run package   # 产出 .vsix
npm run test:integration   # xvfb-run 启动真实 VS Code 跑集成测试（Linux 自动 headless）
```

在 VS Code 中按 F5 启动 Extension Development Host。设计规格见 `structured-batch-edit-spec.md`，UI 交付物见 `UI-DELIVERY.md`。

## 发布前

- `publisher` 已设为 `ghemail`（与 `multi-project-tool` 的 Marketplace publisher 一致）；发布到 Marketplace 需使用同一账号。仅上传 GitHub 不需要该字段。
- `repository` 已指向 `https://github.com/Amos666/replace-json-yaml-edit.git`。
- `.vsix` 安装包与 `test/testdata/` 测试数据不进入 Git（见 `.gitignore`），安装包由 CI 构建并挂到 GitHub Release。
- `npm run package` 产出 `.vsix`；esbuild 以 `--legal-comments=linked` 提取第三方许可注释，`THIRD-PARTY-NOTICES.md` 随包分发。
- 超大工作区可调 `batchReplace.maxFiles`（默认 5000）；面板顶部筛选条件越具体，扫描越快。
- 在真实 VS Code 中按 §10.6 清单走查 Light / Dark / High Contrast / High Contrast Light 四主题，并手动走一遍 Webview 的「扫描 → 预览 → 应用 → Ctrl+Z」交互（自动化集成测试已覆盖 应用 → 撤销 部分）。

## 许可

MIT。第三方许可见 `THIRD-PARTY-NOTICES.md`；Codicon 图标由 Microsoft Corporation 提供，依 CC BY 4.0 使用（全文见 `licenses/codicons-LICENSE.txt`），其构建脚本依 MIT 许可。

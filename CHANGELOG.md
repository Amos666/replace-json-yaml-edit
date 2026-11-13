# Changelog

## [0.1.3] - 2026-11-13

界面第二轮打磨（UI 专家复核）+ 0.1.2 反馈缺陷修复。

### 缺陷修复（5 项反馈）
- **选择文件没有弹窗**：第 ① 步新增「选择目录…」，弹出 `showOpenDialog` 选目录；默认仍以 VS Code 打开的工作区根目录扫描，选定后显示根目录徽标与「恢复工作区根目录」，工作区之外的目录可扫描、可读、可写回。
- **`.yml` 文件不识别 / 扫描不到**：include glob 不含路径分隔符时自动补「任意深度」前缀（`*.yml` → `**/*.yml`），否则 `findFiles` 只命中根目录一层；筛选快捷片补 `*.yml`，与 `*.yaml` 按同义扩展名互认。
- **筛选框下方有空间却显示不出数据**：树默认全部展开（原先只展开顶层，两层以内的文件永远看不到），并给树设 `min-height` 占满可用空间；用户手动折叠的状态仍会记住。
- **筛选不支持 `aaa/bbbb/xs*.yml` 这类路径 glob**：宿主 `matchTreeFilter` 与前端 `tokenMatches` 对齐——路径 glob、文件名 glob、`**/` 任意深度、`.yaml/.yml`、`.json/.jsonc` 同义扩展名一律认；筛选只是「大概范围」，勾选始终以复选框为准。
- **修改值后不起效**：UI 在扫描 / 换步 / 预览 / 应用前 `flushPending()` 冲刷防抖中的编辑，宿主在 `previewAll` / `apply` 前 `flushRecompute()` 立即重算，杜绝 300ms+200ms 防抖窗口内拿到上一版补丁。

### 测试
- 新增 `test/host/flow.test.ts`：真实宿主（`src/controllers/**`）+ 真实前端（`panel.js` @ jsdom）+ 真实临时文件的端到端「选文件 → 改值 → 预览 → 应用」流程，覆盖上述 5 个缺陷与工作区外目录写回；`test/host/vscodeStub.ts` 为可注入的 `vscode` API 桩。
- 单测 75/75、集成测试 6/6（真实 VS Code）全绿。

### 视觉
- 三步向导步骤条：当前步骤主色胶囊，已完成步骤编号换成绿色对勾，步骤间改为细连线（替换 `>` 字符），可点步骤 hover 态更清晰。
- 区块标题：去掉色条装饰，改为 codicon 图标 + 文字（指令 / 文件范围 / 结果），标题行更内聚。
- 统计概览改为 chip 样式（底色 + 边框 + hover 提亮），数字与标签对比更清晰。
- 操作徽标（set/delete/insert/sed/warn）加 14% 自色底色提升辨识度。
- 控件高度统一：新增 `--ctl-h` token，按钮/tab/seg/chip/菜单等统一到 24/20 两档。
- 树列表：目录图标用链接蓝 + 目录名加粗，文件图标弱化；选中行不再被 hover 覆盖。
- 预览弹框：行号列 sticky 固定（横向滚动不丢行号），弹框边框与内边距打磨。
- 高对比度主题补齐 chip / 连线 / 文件图标显式边框；窄宽度（≤300px）向导压缩适配。
- 零硬编码颜色、零 `!important`、四主题截图核验通过；单元测试 61/61、集成测试 6/6 全绿。

## [0.1.2] - 2026-11-13

三步向导交互、懒加载扫描与界面重构。

### 交互
- 三步向导：① 选择文件（目录/glob、过滤、树勾选、批量操作）→ ② 编辑值（新增/修改/删除指令）→ ③ 预览并应用；顶部步骤条与「上一步/下一步」，应用按钮在前两步禁用。
- 双击文件行弹框预览源文件（带行号、大小/截断保护、「在编辑器中打开」）；新增 `previewFile` / `fileContent` 协议消息。
- 修复树状/扁平勾选框选中后无对勾：`.tri[aria-checked="true"]` 补齐 codicon 对勾字形，三态视觉可区分。
- 界面视觉重构：间距、层级、对齐、区块密度与配色层次，保持四主题 / 零硬编码色 / 零外网 / HC 边框 / 焦点环 / reduced-motion 铁律。

### 性能与启动
- **懒加载**：面板 ready 时完全不 `findFiles`、不读盘，只下发空 `init` + `input` 态；用户设定范围后点「扫描文件」触发唯一一次扫描。
- 无指令时也能只列文件不读盘（第①步先选文件），所有文件均可选。
- 扫描按用户设定的目录/glob（include/exclude）与启用指令 `fileScope` 双重收窄。
- 勾选 / 筛选 / 指令编辑改为轻量重算（复用文本缓存、不重新拉目录）；去掉无效与重复扫描。
- 移除 Activity Bar 侧边栏容器/视图/`openSidebar` 命令与备用快捷键，仅保留 `Ctrl+Alt+B` 打开编辑器 Tab 面板。


## [0.1.1] - 2026-11-12

修复超大工作区首次打开面板卡死，并增加侧边栏入口与备用快捷键。

### 性能与稳定性
- 无启用指令时不再执行 `workspace.findFiles('**/*')`，面板首次打开立即就绪。
- 文件扫描按启用指令的 `fileScope` 生成 include glob（如 `**/*.{json,jsonc}`），并新增 `batchReplace.maxFiles`（默认 5000）上限，超出时提示用筛选条件缩小范围。
- 指令 / 文件范围变化时重新拉取文件列表（勾选态变化仍只重算过滤，不重复遍历目录），保证切换扩展名策略后不会残留旧范围的文件。
- 默认排除 `.vscode-test`；扫描/应用仍保持一次 `WorkspaceEdit` 与一次撤销。
- Webview 前端：命中集/已选集缓存、目录统计一次遍历、树/扁平列表最多渲染 1500 行并给出截断提示，避免 2 万级 DOM 行卡死。

### 导航与快捷键
- 新增 Activity Bar 侧边栏图标与 `WebviewViewProvider`，侧边栏与编辑器面板共享同一控制器状态。
- 新增 `structedit.openSidebar` 命令（`Ctrl+Alt+R`）；保留 `Ctrl+Alt+B` 并增加备用 `Ctrl+Shift+Alt+B`。

## [0.1.0] - 2026-11-12

首批完整实现（P0 全量 + 部分 P1）。

### 核心引擎 M1
- `core/` 9 个模块：路径语法、sed 方言、扩展名策略、树筛选、JSONC/YAML/文本三 Adapter、engine、选择模型、补丁合并。
- 最小补丁：逐字节保留注释 / 键序 / 缩进 / 引号风格 / 行尾 / BOM；三引擎统一产出 `MinimalPatch[]`。
- 54 个单元测试全绿，覆盖 §10.1 幂等、§10.2 sed 矩阵、§10.3 fixture、§10.4 选择模型、§10.7 扩展名策略与树筛选批量操作全矩阵、§5.4 混合会话与冲突检测。

### VS Code 宿主层 M2
- 7 个命令、WebviewPanel 生命周期、状态机、300ms 防抖重扫、扫描取消（`cancelScan`）。
- 三层过滤管道、`fileScope` 挑选、内容 hash 二次校验、一次 `WorkspaceEdit` → 一次 Ctrl+Z 全撤。
- 报告、`.structedit.json` v3 导入导出与 v1/v2 兼容升级。

### UI M3
- 四主题适配、零硬编码颜色、CSP + `asWebviewUri` + 本地 Codicon、四态、ARIA、<=300px 单列。
- §8.10 文件范围区、批量操作条、依次选择逐个审阅、diff 预览。
- 按附录 C 产出四件套，见 `UI-DELIVERY.md`。

### 约束
- 零额外安装：`jsonc-parser` / `yaml` 打包进 `.vsix`；sed 为进程内 JS `RegExp`；无外部 CLI、无运行时网络请求。
- MIT；第三方声明见 `THIRD-PARTY-NOTICES.md`（含 CC BY 4.0 Codicon 许可全文）。

### 集成测试与打包修复
- `test/integration/`：`@vscode/test-electron` + `xvfb-run -a` 在真实 VS Code 1.146.0 跑通 **4/4**（扩展激活与 7 命令、Webview 资源随包分发、多文件 `git diff` 仅目标行、一次 Ctrl+Z 全量逐字节还原、混合会话 fileScope 挑选）。
- 修复打包 bug：esbuild 默认选 `jsonc-parser` 的 UMD 入口，产物残留 `require('./impl/format')`，会导致插件在真实 VS Code 加载失败；两个构建脚本改为 `mainFields: ['module','main']` 优先 ESM 入口。
- 视觉核验：Xvfb + x11vnc + VNC 截图在真实 VS Code 四主题下截图走查（`docs/screenshots/`），并修复确认弹窗 `hidden` 属性被 `display:flex` 覆盖、初始可见且无法关闭的 bug。
- CI：新增 GitHub Actions（push 自动 compile / 单测 / xvfb 集成测试 / 打包 VSIX 并发布 GitHub Release）。

### 未执行 / 待补
- 四主题目视走查、键盘焦点环、300px 窄宽度、Webview 内「扫描 → 预览」交互冒烟（自动化只覆盖 应用 → 撤销）；`UI-DELIVERY.md` 第四节如实标注。
- §3.3 干净 Windows（无 Node/Git）+ Remote-SSH 复跑：需目标环境。
- P1 增强：>500 节点虚拟滚动、路径补全、旧值分布 / 命中样本专用协议字段、完整游标 → 嵌套 JSONPath 推导。

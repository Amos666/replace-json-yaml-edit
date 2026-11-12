# Changelog

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

### 未执行 / 待补
- 四主题目视走查、键盘焦点环、300px 窄宽度、Webview 内「扫描 → 预览」交互冒烟（自动化只覆盖 应用 → 撤销）；`UI-DELIVERY.md` 第四节如实标注。
- §3.3 干净 Windows（无 Node/Git）+ Remote-SSH 复跑：需目标环境。
- P1 增强：>500 节点虚拟滚动、路径补全、旧值分布 / 命中样本专用协议字段、完整游标 → 嵌套 JSONPath 推导。

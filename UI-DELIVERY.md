# UI 交付说明 · Batch Replace for JSON & YAML

> 依据：`structured-batch-edit-spec.md` §8（v1.3 自包含规则）、附录 C（交付物格式）、附录 D（《VS Code 插件 UI 美化 · Agent 提示词》原文，权威依据）、§10.6（UI 验收清单）。
> 范围：Webview 前端全套 UI，从零实现。交付文件仅 `src/ui/panel.html`、`src/ui/panel.css`、`src/ui/panel.js` 与本说明；`src/ui/codicon.css` / `codicon.ttf` 为已有只读资源。
> 接口基准：`src/shared/protocol.ts`（未修改）。面板标题与全部 UI 文案统一使用 displayName「Batch Replace for JSON & YAML」，无内部代号；未读取、未依赖、未参照任何本地高保真预览文件，一律按 §8 文字规则从零搭建。
> 从零实现，按附录 C 末段把「现状诊断表」替换为「按 §8 规则落地的对照说明」，其余三项照常产出。

---

## 一、按 §8 规则落地的对照说明（区块 / 规则条目 / 落地位置）

| 区块 | 规则条目 | 落地位置（文件 : 关键标识） |
|---|---|---|
| 全局 | §8.0 铁律 1 四主题、HC 显式边框 | `panel.css` `:root` 别名层 + `body.vscode-high-contrast[-light]` 全量 1px `--vscode-contrastBorder` 规则 |
| 全局 | §8.0 铁律 2 禁硬编码色 | `panel.css` 全文零 `#hex`/`rgb()`/`hsl()`；骨架用 `color-mix(in srgb, var(--c-fg) 12%, transparent)` |
| 全局 | §8.0 铁律 3 零外部网络、CSP / asWebviewUri | `panel.html:6` CSP meta（原文照抄，占位符）、`:8-9` 两个 `<link>`、`:131` `<script nonce>`；全文无 URL |
| 全局 | §8.0 铁律 4 只改视觉层、消息严格照协议 | `panel.js` 所有 `post()` 顶层字段与 `protocol.ts` 逐字一致；不计算扫描结果 |
| 全局 | §8.0 铁律 5 不发明变量 | `panel.css` 仅引用 §8.3 / 附录 D 规范 A 列出的官方 `--vscode-*`，集中在 `:root` 别名层（见第三节） |
| Toolbar | §8.1 标题 + 导入/导出/历史/帮助次按钮 | `panel.html` `.toolbar`；`panel.js` `onClick` case `import/export/history/help` |
| 概览条 | §8.1 五计数 + 扫描进度、异常语义色、点击跳分组 | `panel.js:renderOverview()`；`.ov-stat.is-bad/.is-warn`、`role=progressbar`（12/17）、`case 'jump'` |
| ① 指令 | §8.1 引擎 Tab `role=tablist/tab` | `panel.html:#engine-tabs`；`panel.js:renderInstructions()` 更新 `aria-selected`；`case 'engine-tab'` |
| ① 指令 | §8.1 指令行（启用/操作/格式分段或扩展名控件/路径/值/类型/删除/元信息行） | `panel.js:renderInsRow()`；结构化 `ins-format` 分段、文本 `ins-scope-btn` + `insScopeEditHtml()`（all/custom + include/exclude 标签） |
| ① 指令 | §8.1 添加指令按钮、双引擎混用 | `case 'add-ins'`、`newInstruction()`；`ins-count` 显示「共 N 条（双引擎混用）」 |
| ① 指令 | §8.9 / §8.1 旧值分布统计 / 命中样本前 3 | `panel.js:renderInsStatsHtml()`（由 `preview.diffs` 派生，见第五节缺口 G3） |
| ② 文件范围 | §8.10 目标格式分段（JSON/YAML/Sed，仅新建默认值） | `panel.js:renderScope()` `fmt-row`；`case 'target-format'` 只改 `S.targetFormat`，**不改已有指令 fileScope** |
| ② 文件范围 | §8.10 结构化扩展名策略：🔒 只读徽标 + tooltip + aria-label + 禁用态、**不渲染标签输入框** | `panel.js:policyStructuredHtml()`：`.policy-lock[aria-disabled="true"][aria-label="扩展名由目标格式固定，不可编辑"]` + `title` 说明；`panel.css:.policy-lock` 用 `disabledForeground` |
| ② 文件范围 | §8.10 文本 all/custom 单选、自定义标签输入 + 排除项 | `panel.js:policyTextHtml()` + `tagEditor()`；`case 'policy-mode'`、`case 'tag-add'/'tag-del'` |
| ② 文件范围 | §8.10 联动（候选/树/计数/glob 刷新 + 重扫） | 策略变化 → `sendScope(ins)` + `commitInstructions(true)`，由宿主回 `tree` 刷新；`panel.js:applyPolicyToActive()` |
| ② 文件范围 | §8.10 / §6.3 过滤框 150ms 防抖 + 解析回显 | `panel.html` 静态骨架不含过滤框；`panel.js:renderScope()` `#filter-input`；`onInput`/`sendFilter(150ms)`、`renderFilterEcho()`、`filterEchoHtml()`（`conf ∧ *.yaml ∧ ¬legacy`） |
| ② 文件范围 | §6.5 / §8.10 过滤快捷片（不兼容禁用） | `panel.js:chipsHtml()`：结构化模式下不兼容片 `aria-disabled="true"` + 原因 tooltip |
| ② 文件范围 | §8.10 树状/扁平切换、命中 N · 已选 M | `case 'view'`（`setFilter.view`）、`renderTree()` / `renderFlat()`、`.hit-count` |
| ② 文件范围 | §8.10 批量操作条 `role=toolbar`（全选命中/取消命中/反选/仅保留〔二次确认〕/依次选择/清除筛选/只看适用） | `panel.js:batchbarHtml()`、`case 'batch'`（`keepOnly` 走 `showConfirm` 二次确认）、`case 'review-start'` |
| ② 文件范围 | §8.1 / §8.5 三态勾选 `aria-checked="mixed"`、命中高亮、●N 徽标、非候选灰显 + tooltip | `treeRowHtml()` / `flatRowHtml()`：`.tri[role=checkbox][aria-checked]`、`highlight()` `<span class="hit">`、`●N` badge、`.is-noncandidate` + `title` |
| ② 文件范围 | §8.10 右侧等效 glob（include/exclude/重置）+ 只读摘要态 | `globPanelHtml()`；`case 'glob-show-edit'/'glob-reset'`（`setGlob` / `resetToGlob`） |
| ② 文件范围 | §8.10 / §6.4 逐个审阅态卡片（3/17 进度、路径、扩展名、适用指令数、预计变更数、首个 diff、操作按钮） | `panel.js:renderReview()` + `reviewActionsHtml()`；底栏切换 `renderBottomBar()` 审阅态；`role=progressbar` |
| ③ 结果 | §8.1 命中树（目录/类型分组、set/del/ins/sed 徽标、警示、跳转） | `panel.js:groupsHtml()`、`opBadges()`、`countGroup()`、`case 'open-file'` |
| ③ 结果 | §8.1 / §8.3 diff 预览（行号、−/+、上下文、警示条、读屏可读文本模式） | `panel.js:diffPaneHtml()` / `renderDiffLines()`；`case 'diff-mode'` 切换 `−old / +new` 文本模式；`.diff-warn` |
| ③ 结果 | §8.2 / §7.5 报告态 | `panel.js:onReport()` / `reportPanelHtml()`；`exportReport` / `showReport` |
| 底栏 | §8.1 统计 + 预览全部 Diff + 应用（主按钮）+ Ctrl+Z 提示 | `panel.html:footer.bottombar`（sticky flex 末端）；`panel.js:renderBottomBar()` |
| 底栏 | §8.2 应用守卫（delete/deleteLine 且 >20 汇总确认、>500 明细确认） | `panel.js:requestApply()` + `showConfirm()` |
| 全局 | §8.2 状态机、300ms 指令防抖、概览跳分组 | `commitInstructions(300ms)`、`sendFilter(150ms)`、`sendGlob(300ms)`、`case 'jump'` |
| 全局 | §8.4 高密度（24px 行高 / 4·8 间距 / 2–4px 圆角 / 无阴影渐变 / 三级字阶） | `panel.css` `--row-h:24px`、`--sp-1..6`、`--radius:2-3px`、`.sec-title/.tree-label/.sec-note` 三级 |
| 全局 | §8.5 四态（骨架/空态/错误态/禁用态）每区块齐备 | `skeletonHtml()`（首屏静态 `#ins-body/#scope-body/#results-body`）、`emptyState()`、`errBox()`（三区均注入）、`applyDisabled()` |
| 全局 | §8.5 列表三态 hover / selected / focus-visible | `panel.css:.tree-row:hover`、`.tree-row[aria-selected=true]`、全局 `:focus-visible{outline:2px solid var(--c-focus)}` |
| 全局 | §8.5 Codicon 全站同一语义同一图标 | `ic()` + 固定映射：set=`edit`、del=`trash`、ins=`add`、replace=`replace`、deleteLine=`remove`、warning=`warning`、跳转=`go-to-file`、过滤=`search`、eye=`eye`、folder/file、lock、`list-tree/list-flat`、`check-all`、`cloud-download/upload`、`history`、`question` 等 |
| 全局 | §8.6 ARIA：tablist/tab、tree/treeitem、checkbox+mixed、toolbar、progressbar、图标 aria-label | 见上各行；所有 `.icon-btn` 均带 `aria-label` |
| 全局 | §8.6 键位（↑↓/Space/→←/Ctrl+F/Enter/Ctrl+Enter；审阅 →/Enter、←、Space、Esc） | `panel.js:onKeyDown()` / `handleTreeKey()` / `toggleReviewCurrent()`；Webview 内键盘只能在前端处理（宿主收不到，见第五节 G9） |
| 全局 | §8.6 / §8.7 过渡 120–200ms、reduced-motion、setState/getState、Tab 顺序 | `panel.css:--t:150ms ease` 仅 color/background/border/opacity + `@media (prefers-reduced-motion: reduce){:root{--t:0s}}`；`panel.js:persist()`/`PREFS`；DOM 顺序 指令→范围→结果→底栏 |
| 全局 | §8.4 / §8.10 ≤300px 折叠单列无横向滚动 | `panel.css` `.content{container-type:inline-size}` + `@container panel (max-width:300px)` 与 `@media (max-width:320px)` 兜底；`.batchbar{flex-wrap:wrap}`；`grid minmax(0,1fr)` |
| 全局 | §8.8 四主题降级矩阵 | 见第三节 |

---

## 二、改动清单表（文件 / 改动摘要 / 对应规范条目）

| 文件 | 改动摘要 | 对应规范条目 |
|---|---|---|
| `src/ui/panel.html`（新建） | Webview 模板：CSP meta（占位符原样）、`{{CODICON_CSS_URI}}`/`{{CSS_URI}}`/`{{JS_URI}}`/`{{NONCE}}` 契约引用、Toolbar、常驻概览条、全局错误条、三区块静态骨架（首屏加载态）、粘性底栏、确认对话框、`aria-live` 区域。首屏状态不含业务数据，只留容器/骨架占位。 | §8.7、§8.1、§8.5（加载骨架）、`protocol.ts`「Webview 资源契约」 |
| `src/ui/panel.css`（新建，833 行） | 官方变量别名层（零硬编码色）；四主题 + HC 全量 1px `contrastBorder`；高密度控件（24px/4·8 间距/2–4px 圆角/无阴影渐变）；按钮/输入/徽标/三态勾选/tab/seg/树/diff/审阅/报告/对话框/toast；四态样式；`:focus-visible` 焦点环；过渡与 reduced-motion；容器查询 + 媒体查询窄宽度降级。 | §8.0、§8.3、§8.4、§8.5、§8.6、§8.8、附录 D 规范 A/B/C/D |
| `src/ui/panel.js`（新建，1484 行） | `acquireVsCodeApi()` + `message` 收 7 类消息；发全 19 类 `WebviewToHost` 消息 + `ready`；`setState/getState` 持久化 13 项纯 UI 状态；三区全量渲染、四态、审阅态、报告态、确认守卫、事件委托、键盘导航、150/300ms 防抖、命中集 H 显示层求值。 | §8.1–§8.10、§6.3/§6.4、`protocol.ts` |
| `UI-DELIVERY.md`（新建） | 本四件套说明。 | 附录 C |

未改动任何其它文件。`src/ui/codicon.css`、`codicon.ttf` 保持原样；`package.json` / `src/extension.ts` / `src/core/**` / `src/shared/**` / `src/controllers/**` / `esbuild.mjs` / `tsconfig.json` / `README.md` 均属其它 Agent，未触碰。

---

## 三、主题适配说明

### 3.1 变量映射（新增的私有别名 → 官方变量）

样式不直接散落引用 `--vscode-*`，而是在 `panel.css:root` 建立一层私有语义别名（**不是**新造 `--vscode-*` 变量），全站只用别名：

| 私有别名 | 官方变量（全部出自 §8.3 / 附录 D 规范 A） |
|---|---|
| `--c-fg` / `--c-muted` / `--c-disabled` | `--vscode-editor-foreground` / `--vscode-descriptionForeground` / `--vscode-disabledForeground` |
| `--c-bg` / `--c-bg-1` / `--c-bg-2` / `--c-code-bg` | `--vscode-editor-background` → `--vscode-sideBar-background` → `--vscode-editorWidget-background` / `--vscode-textCodeBlock-background` |
| `--c-hover` / `--c-sel(-fg)` / `--c-isel(-fg)` | `--vscode-list-hoverBackground` / `--vscode-list-activeSelection*` / `--vscode-list-inactiveSelection*` |
| `--c-border` / `--c-wborder` / `--c-wborder2` / `--c-focus` / `--c-link` / `--c-contrast` | `--vscode-panel-border` / `--vscode-editorWidget-border` / `--vscode-widget-border` / `--vscode-focusBorder` / `--vscode-textLink-foreground` / `--vscode-contrastBorder` |
| `--c-btn-*` / `--c-btn2-*` | `--vscode-button-{background,foreground,hoverBackground,border}` / `--vscode-button-secondary{Background,Foreground,HoverBackground}` |
| `--c-in-*` / `--c-val-{err,warn,info}` | `--vscode-input-{background,foreground,border,placeholderForeground}` / `--vscode-inputValidation-{error,warning,info}Border` |
| `--c-error` / `--c-warn` / `--c-info` / `--c-editor-error` | `--vscode-errorForeground` / `--vscode-editorWarning-foreground` / `--vscode-notificationsInfoIcon-foreground` / `--vscode-editorError-foreground` |
| `--c-set` / `--c-del` / `--c-ins` / `--c-hit` / `--c-{key,str,num}` | `--vscode-charts-{blue,green,orange,purple}` / `--vscode-errorForeground` / `--vscode-notificationsInfoIcon-foreground`（仅徽标/图标/行内高亮，面积 <5%） |
| `--c-diff-{del,add}-bg` | `--vscode-diffEditor-{removed,inserted}LineBackground` |
| `--c-badge-*` / `--c-check-*` / `--c-scroll*` | `--vscode-badge-*` / `--vscode-checkbox-*` / `--vscode-scrollbarSlider-*` |
| `--font-ui` / `--font-code` / `--fs` | `--vscode-font-family` / `--vscode-editor-font-family` / `--vscode-font-size` |

不确定的变量一律用「已确认变量 + `var(..., fallback)` 回退」，如 `--c-code-bg` 回退到 `editorWidget-background`、`--c-val-err` 回退到 `errorForeground`，避免 HC/精简主题下取空。

### 3.2 四套主题降级策略

| 场景 | Dark / Light | HC / HC Light |
|---|---|---|
| 层级区分 | 背景微差（`editor`→`sideBar`→`editorWidget`）+ `panel-border` / `editorWidget-border` | `body.vscode-high-contrast[-light]` 下把 `--c-border/--c-wborder/--c-wborder2/--c-in-border/--c-btn-border/--c-check-border` 全部重定向到 `--vscode-contrastBorder`，并对 toolbar/overview/section/sec-head/bottombar/panel/ins-row/group/tree/diff-pane/review-card/report/glob/模态/空态/错误态/btn/badge/tri/chip/progressbar 等**逐一显式 1px 边框**，不依赖底色 |
| diff | 行底色 `diffEditor-*` + `−/+` 前景色（`errorForeground` / `charts-green`） | 行底色置透明，改 `border-left: 2px solid` + `−/+` 符号区分（§8.8） |
| 操作色徽标 | `charts-* / error / warning` 前景色 | 保留前景色 + `contrastBorder` 1px 描边 |
| 命中高亮 / 灰显 | `notificationsInfoIcon-foreground` 前景高亮 + `opacity` 灰显 | `.hit` 改双下划线；`.tree-row.is-noncandidate` 改 `opacity:1` + 显式虚线边框，不靠透明度 |
| 焦点 | `--vscode-focusBorder` 2px | 同左（HC 下 focusBorder 本身高亮）；禁用态 `opacity` 归 1，靠 `disabledForeground` + 边框 |
| 禁用 / hover / 选中 | `disabledForeground` / `list-hoverBackground` / `list-activeSelection*` | hover/选中额外加 1px `contrastBorder` 强化区分 |
| 只读锁定态 | `disabledForeground` + `input-border` + 🔒 `lock` + tooltip | 再叠 `contrastBorder` 边框 |
| 窄宽度 | 容器查询折叠单列、批量条换行 | 同左（与主题无关） |

主题 class 由宿主注入 `body.vscode-light/-dark/-high-contrast/-high-contrast-light`，前端不改写（§8.7）。

---

## 四、自检结果（逐条勾选 §10.6，未通过项如实标注）

图例：`[x]` 已通过并给出证据；`[~]` 代码层面已落地、需在 VS Code 内目视/手测复核；`[ ]` 未执行或未通过。

- `[~]` **切换 Light / Dark / High Contrast / High Contrast Light：无白底、无不可读文字、无错位边框；HC 下所有层级均有显式 1px 边框**
  代码层面：全部颜色走官方变量别名；HC 规则对 20+ 类容器/控件显式加 1px `--vscode-contrastBorder`；四 body class 分支齐备。**未在真实 VS Code 四主题下目视实测**（本任务只交付前端源码，需集成方在扩展宿主中切换验证）。

- `[x]` **`grep -E "#[0-9a-fA-F]{3,8}|rgb\(|hsl\(" src/ui/` 无残留**
  实测命令对 `panel.html / panel.css / panel.js` 输出 `CLEAN`；骨架仅用 `color-mix(... transparent)`。未从任何原型文件拷贝代码，无演示/兜底硬编码色值。（`src/ui/codicon.css` 为随扩展分发的官方文件，非本次产出。）

- `[x]` **全站无外部网络请求；Webview CSP 与 asWebviewUri 正确；`.vsix` 内含 Codicon 字体与第三方 LICENSE**
  `panel.html` 无任何 `http(s)://` / CDN / `@import url()`；CSP meta 与 `<link>` / `<script nonce>` 与 `protocol.ts` 契约逐字一致；`esbuild.mjs:copyUiAssets()` 用 `cp('src/ui','dist/ui')` 递归复制，故 `codicon.ttf` 随 `dist/ui` 进入 `.vsix`。第三方 LICENSE：`THIRD-PARTY-NOTICES.md` 存在于仓库根（属集成方/发布配置，未由本任务改动，未逐字核验其内容）。

- `[~]` **所有可交互元素键盘可达且 `:focus-visible` 焦点环可见；Tab 顺序：指令 → 范围 → 结果 → 底栏**
  `panel.css` 全局 `:focus-visible{outline:2px solid var(--c-focus);outline-offset:1px}`，无裸写 `outline:none`；树/扁平行实现 roving tabindex（`↑↓` 移动、`Space` 勾选、`→/←` 展开收起）；DOM 顺序为 指令区 → 范围区 → 结果区 → 底栏。Vue 无框架、无遮挡焦点的 `pointer-events:none` 覆盖（仅禁用态使用）。**键盘可达性需在 VS Code Webview 内实测焦点环可见性**。

- `[~]` **正文对比度 ≥ 4.5:1；约 300px 窄宽度下无横向滚动**
  全部前景/背景取自官方主题变量（VS Code 主题自身保证 AA）；`.content{container-type:inline-size}` + `@container panel (max-width:300px)` + `@media (max-width:320px)` 把 `.scope-grid` / `.results-grid` 折为 `minmax(0,1fr)` 单列、过滤框占满、批量条 `flex-wrap`、隐藏 `.btn-label`、进度条收窄；`box-sizing:border-box` 全局、无固定 px 宽导致溢出。**需真实 300px WebviewView 目视复核**（本次仅静态/结构验证）。

- `[~]` **四态在指令区、文件树、结果区三处均可达且表现正确；结构化模式下扩展名控件为可访问的禁用态**
  JS 级冒烟验证：首屏三区 `state-skeleton`（加载）；`flat:[]` 时三区均出现 `.state-empty` + 可点主操作；`error` 消息后三区均注入 `.state-error`（`errorForeground` + 首行 + 重试/帮助可恢复操作）+ 全局 `role=alert` 错误条；`phase=applying` 时三区控件被 `aria-disabled` + 原生 `disabled` + tooltip 禁用，`noHits` 时批量条禁用。结构化 `.policy-lock` 具备 `aria-disabled="true"`、`aria-label="扩展名由目标格式固定，不可编辑"`、`title`「由目标格式固定」、🔒 `lock`，且**不渲染标签输入框**。**视觉表现需 VS Code 内实测**。

- `[x]` **`prefers-reduced-motion` 下无动画；过渡仅 color/background/border/opacity 且 120–200ms**
  `--t:150ms ease`，所有 `transition` 只列 color/background/border-color/opacity；`@media (prefers-reduced-motion: reduce){:root{--t:0s} *{animation-duration:0s;transition-duration:0s}}`；骨架条为静态色块，全文件无 `@keyframes` 动画、无渐变、无双重边框/内外阴影。

- `[ ]` **现有测试全部通过 + 手动冒烟核心流程：扫描 → 预览 → 应用 → Ctrl+Z 全量还原**
  **未执行**。本任务为纯前端源码交付，未运行仓库测试套件，也未在 VS Code 内跑端到端流程（扫描/预览/应用/撤销依赖宿主控制器与 core 引擎，属其它 Agent 工作）。已完成的替代验证：`node --check` 语法通过；stub-DOM 冒烟覆盖 `init/tree/state/preview/review/report/error` 七类消息、47 个 `data-action` 点击分支、7 类键盘事件、`prefers` 四态与文本模式；`cheerio` 解析三区 `innerHTML` 全部良构，无 `undefined`/`NaN`/`[object Object]` 泄漏；19 类 `WebviewToHost` 消息全部接线。**请在集成后由集成方补跑此条。**

> 结论：静态可验证项（禁硬编码色、零外网、CSP、reduced-motion、结构良构、消息契约）通过；依赖 VS Code 宿主/真实主题/端到端流程的项标注为 `[~]`/`[ ]`，未虚报完成。

---

## 五、已知协议缺口与「建议但未实施」的改动（均未动手，需集成方决策）

> 以下均为 `src/shared/protocol.ts`（集成方所有）或 `package.json`（集成方所有）层面的取舍；我**只写进报告，未修改任何非授权文件**。

- **G1 · 扫描取消**：§8.2 要求进度带「取消」，但 `WebviewToHost` 无 `cancel`/`cancelScan`。已渲染「取消扫描」按钮为**可访问禁用态**（`aria-disabled` + tooltip 明说「宿主协议 v1.6 暂未提供 cancel 消息」）。建议新增 `{ type:'cancelScan' }`。
- **G2 · 逐文件异常明细**：`Counts` 只有聚合数字，`tree`/`preview` 不带「哪些文件警示/解析失败/冲突」清单。结果区警示/解析失败/冲突三组目前由 `counts` 驱动 + `TreeNode.reason` 列表，无法列出具体冲突对。建议 `TreePayload` 增加 `issues` 字段或 `TreeNode` 增加标记位。
- **G3 · 旧值分布 / 命中样本无专用字段**：§8.9 两大利器无对应协议字段。已从 `preview.diffs` **派生**（前 3 个 `remove/add` 片段 + 上下文一行；结构化按被删行文本频率统计），属展示层近似，不等价于引擎提供的真实旧值分布/命中样本。建议增加 `oldValueStats` / `hitSamples` 载荷。
- **G4 · `TreeNode` 无 `uri`**：只有 `FlatItem.uri`。树节点的 `select` / `openFile` 通过 `flat` 建立 `path → uri` 映射求得；若 `flat` 与 `tree` 不同步会解析不到。建议给 `TreeNode` 补 `uri`。
- **G5 · `tree` 不回传 `treeFilter` / `selection`**：「已解析」回显与 glob 只读摘要态、overrides 是否存在只能靠前端输入态与 `init` 推断。建议 `TreePayload` 回传 `TreeFilter` 与 `SerializedSelection`（或新增 `selection` 消息）。
- **G6 · 审阅 Space 无 `toggle` 动作**：`ReviewAction` 无 toggle，逐个审阅的 `Space` 以 `select { uri, checked }` 实现切换（符合 §6.4「即时写 overrides」），语义正确但动作名不在 `ReviewAction` 枚举内。
- **G7 · `codicon-steps` 不存在**：§8.5 映射表给「逐个审阅 = `steps`」，但随扩展分发的 `@vscode/codicons` 中无 `codicon-steps`（实测 `grep codicon-steps:before` 为 0）。已改用语义最接近且真实存在的 `debug-step-over`，全站保持一致；建议规格回填修订映射表。
- **G8 · 应用 >500 明细确认受限**：`requestApply()` 的 >500 明细列表只能列出 `flat` 前 40 项（协议未提供逐文件变更明细载荷），其余以「…… 其余文件省略」提示。
- **G9 · 键位实现方式与 §8.6 表述差异**：§8.6 原文要求快捷键经 `keybinding` contribution + `when` 子句转发；但 Webview 内键盘事件宿主收不到，团队分工明确要求「Webview 内键位在 `panel.js` 内实现即可」。已按后者在前端实现全部键位；如仍需命令面板键位，需集成方在 `package.json` 补 `keybindings` 并转发命令。
- **G10 · §8.9 / §6.5 部分 P1 未实现**：路径输入失焦红波浪线校验、`@` 结构自动补全、sed 简写粘贴自动展开表单（保留原式注释）、非法 sed 特性「为什么不支持 + 怎么改」提示、>500 节点虚拟滚动。已实现：文本 `flags` 仅接受 `g/i/m` 的红框校验、过滤框 glob 括号平衡校验与错误态、树/结果区 `max-height + overflow:auto`（非虚拟滚动）。这些属 P1 / 增强项，建议排期补齐。
- **G11 · 引擎 Tab 语义**：§8.1 ASCII 把「结构化区 / 文本区」画成两个子区，未明确 Tab 是「视图过滤」还是「新建默认值」。已实现为**视图过滤 + 数量提示**（两 Tab 与区块② 目标格式分段联动到同一 `S.targetFormat`，双引擎指令共存、切换不改已有指令），并在指令区显示「共 N 条（双引擎混用）」。若产品期望「始终并列显示全部指令」，需调整 `renderInstructions()` 的过滤逻辑（一行改动）。
- **G12 · 只读/可编辑态的边界**：区块②「目标格式分段」严格按 §6.1 规则 3 / 任务要求**只改新建指令默认值、不改已有指令 fileScope**，故切换它本身不触发重扫；真正触发重扫的是「扩展名策略 all↔custom / 标签编辑」（`setScope`+`setInstructions`）、`setFilter`、`setGlob` 与批量操作。区块② 文本策略编辑会作用于「当前活动文本指令」（无文本指令时仅更新新建默认值），并在 `panel.js:applyPolicyToActive()` 中集中处理。


---

## 六、集成补记（集成方，非 UI Agent 产出）

- **G1 扫描取消已闭环**：`src/shared/protocol.ts` 的 `WebviewToHost` 新增 `{ type:'cancelScan' }`；`panel.js` 的取消按钮在 `S.phase === 'scanning'` 时启用、其余态保持可访问禁用态与 tooltip；`controller.ts` 新增 `case 'cancelScan'`，调用 `cancelScan()`（generation + CancellationTokenSource）后回 `state(phase:'input', '扫描已取消')`，避免 UI 卡在扫描中。改动后 `compile` / `node --check` / 54 例单测 / `build` / `package` 全绿。
- 第四节中依赖真实 VS Code 宿主的 `[~]` / `[ ]` 项仍**未执行**：本仓库当前环境未安装 VS Code GUI，未做四主题目视走查，也未跑端到端冒烟（扫描 → 预览 → 应用 → Ctrl+Z）。如实保留原标注，不虚报完成。
- G2–G12 仍为「建议但未实施」，属 P1 增强或非阻塞协议扩展，未在本次集成中改动。

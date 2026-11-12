# StructEdit — VS Code 结构化 + 文本批量编辑器 · 设计与实现规格书

> **版本**：v1.6（2026-11-12）
> **v1.6 变更（本轮）**：按最终定名把 `displayName` 改为 **`Batch Replace for JSON & YAML`**（补上「批量」这一最高频搜索词）；`name` / `description` / `keywords` / `categories` **全部保持不变**；§0.2 论述由「补缺口」调整为「扩大长尾覆盖」，§0.3 命令显示名前缀与 §0.5 重名检查词同步更新。
> **v1.5 变更**：新增 **§0 发布标识与 Marketplace 可发现性**——初版定名 `Replace JSON YAML Edit`（ID `replace-json-yaml-edit`），给出 `description` / `keywords` / `categories` 的落地值与 README 首行；明确 `StructEdit` 降为**项目内部代号**，命令前缀与表达式集文件名保持不变。
> **v1.4 变更**：新增 **§3.3「最终用户运行时依赖：零额外安装」** 与交付说明第 5 条——明确「安装插件即可使用全部功能，无需 Node.js / npm / jq / yq / sed / Git Bash」，禁止实现者在 README / UI 中要求用户安装外部二进制或 spawn 外部进程；并澄清 sed 引擎是进程内 JS `RegExp`、不是系统 sed。
> **v1.3 变更**：① 新增 **§6.1 扩展名策略与引擎/格式绑定**——结构化 JSON/YAML 的扩展名由格式**固定且只读**（`.json/.jsonc`、`/.yaml/.yml`），文本 sed 支持**用户任意添加扩展名过滤**或**不加过滤（全部文件类型）**；② **§6.3–6.4 树筛选增强**——树/扁平视图支持输入筛选条件，对**跨所有目录**的命中文件一键「全选 / 取消 / 反选 / 仅保留 / 依次选择（逐个审阅）」；③ §6 整章重排为「三层过滤管道」单一真相模型，配套 §4.3 接口、§8.10 文件范围区界面规范、§10.7 单测、附录 A 表达式集 v3；④ **本规格书改为完全自包含**（见下方「交付说明」）；⑤ **附录 D 收录《VS Code 插件 UI 美化 · Agent 提示词》原文全文**，实现 Agent 只凭本文档即可完成 UI 优化。
> **v1.2 变更**：UI 规范对齐《VS Code 插件 UI 美化铁律》——§8.0 五条 UI 铁律、§8.3 色彩语义映射表、§8.5 组件与四态、§8.7 Webview 工程落地（CSP/asWebviewUri/Codicon）、§8.8 四主题降级策略、§10.6 UI 验收清单、附录 C（UI 维护交付物）。
> **v1.1 变更**：① 新增 sed 风格文本替换/删除（支持所有文件类型）；② 文件选择升级为树状目录 + 过滤 + 勾选（与 glob 双向同步）。
>
> **读者**：负责实现的 AI Agent / 开发者
> **目标**：本文档包含完整需求、技术选型、架构、核心算法规范、文件选择逻辑、UI/UX 设计与测试策略，按此实现即可，无需再做前期调研。

---

## ⚠️ 交付说明（给实现 Agent，务必先读）

1. **本规格书是完全自包含的**。实现所需的全部信息——界面布局（§8.1 ASCII 图 + 控件清单）、文件范围区控件（§8.10）、视觉规范（§8.3–§8.8）、四态（§8.5）、交互与可访问性（§8.6）、验收清单（§10.6）、UI 美化原始要求（附录 D 全文）——**全部在本文档内**。
2. **`ui-mockup.html` 只是本地可选的高保真预览，不会随本文档发送，实现时不得依赖、也不得去查找该文件**。所有以「对照原型 / mockup」为准的旧表述一律以本文档 §8 文字规则为准。若两者有差异，**以本文档为准**。
3. **UI 实现是硬性交付**：必须满足 §8（规则化版本）+ 附录 D（原文，权威依据）+ §10.6 验收清单 + 附录 C 交付物。附录 D 中「第一步：先诊断」与「改动清单/最小 diff」适用于**后续对已有 UI 的维护**；从零实现时直接按 §8 规则落地，并在首次交付时按附录 C 产出四件套。
4. **文件选择逻辑按 §6 实现（本轮重点）**：结构化指令扩展名固定只读、文本指令扩展名自由/全部、树筛选条件 + 跨目录批量选择 + 依次选择，均为 P0，不可省略。
5. **（v1.4）最终用户「零额外依赖」是硬约束**：扩展必须自包含，安装 `.vsix` 后即可使用全部 P0/P1 功能。**禁止**在 README、UI 提示、错误信息或激活逻辑中要求/探测 Node.js、npm、jq、yq、sed、Git Bash、Python 或任何外部 CLI 与原生模块；**禁止** `spawn` / `exec` / `execFile` 任何外部二进制。「sed」仅为语法方言，执行用进程内 `RegExp`（详见 §3.3）。
6. **（v1.5）对外命名以 §0 为准**：`package.json` 的 `name` / `displayName` / `description` / `keywords` / `categories` 按 §0 原样填写；文档标题与正文里的 `StructEdit` 是**内部代号**，不是发布名，不要写进 Marketplace 详情页。

---

## 0. 发布标识与 Marketplace 可发现性（v1.6 定案）

> 本节给出 `package.json` 的落地值，实现 Agent 直接照填。**对外只用本节的名字**；文档标题与正文中的 `StructEdit` 是项目内部代号，不是发布名。

### 0.1 字段落地值

| 字段 | 值 | 说明 |
|---|---|---|
| `name` | `replace-json-yaml-edit` | 扩展 ID，官方要求全小写无空格；用户选定的 `replace_json_yaml_edit` 下划线按 Marketplace 惯例改为连字符，需全局唯一。**v1.6 不变** |
| `displayName` | `Batch Replace for JSON & YAML` | **最终定名**。在用户选定的 `replace / json / yaml / edit` 前补 `Batch`（最高频搜索词、需求 R1），加 `for` 使其读起来像产品名；带后缀也避开已占用的 `batch replace`（raindrop），符合 `displayName` 全局唯一 |
| `publisher` | `<your-publisher>` | 发布前创建，最终 ID 为 `<publisher>.replace-json-yaml-edit` |
| `categories` | `["Other"]` | 官方类目中无「批量编辑」，`Other` 最稳妥；**勿选 `Formatters`**（会被误认为格式化工具，与本扩展「不改格式」的核心约束冲突） |
| `description` | 见下 | 英文一行，必须含 `batch` 与 `JSON` / `YAML`。**v1.6 不变** |

```jsonc
{
  "name": "replace-json-yaml-edit",
  "displayName": "Batch Replace for JSON & YAML",
  "description": "Batch replace values across JSON, YAML and any text files by path or regex - preview every diff in a visual panel, apply to hundreds of files with one undo.",
  "categories": ["Other"],
  "keywords": [
    "batch replace", "bulk replace", "replace in files", "replace across files",
    "multiple files", "multi-file", "batch edit", "replace all",
    "json", "jsonc", "yaml", "yml", "structured edit", "structured replace",
    "jsonpath", "key value", "sed", "regex", "find and replace",
    "diff", "preview", "workspace", "config",
    "批量替换", "批量修改", "多文件替换"
  ]
}
```

### 0.2 关键词覆盖长尾搜索词（可发现性的关键）

> ⚠️ v1.6 起 `displayName` 已含 `Batch`，`batch replace` 这一最大入口已由名字直接覆盖；但名字只有 5 个词，**装不下** `bulk replace`、`replace in files`、`multiple files`、`批量替换` 等用户实际会输入的长尾词。因此 `keywords` 仍必须保留上表全部词条（官方上限 30，本表 27 个），`description` 与 README 首行也都必须出现 `batch` / 「批量」——**名字 + 描述 + 关键词三者叠加**，才能保证「按需求搜得到」，不可因为名字改了就删关键词。

补充依据：`displayName`、`description`、`keywords` **三样都参与 VS Code 内文本搜索**（[官方 Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest) 原文：*"These strings are also used for text search in VS Code and having relevant keywords will help a lot"*）；用户习惯搜功能描述词而非插件全名。

### 0.3 README 首行与面板标题

- **README 首行（中文，前 10 行说清省了哪一步）**：「不用写 yq/jq/sed 命令，在界面里按路径或正则批量改多个 JSON/YAML/任意文本文件，逐条预览 diff，一次 Ctrl+Z 全部撤销。」
- 面板 Toolbar 标题显示 `displayName` 全称 `Batch Replace for JSON & YAML`；§8.1 ASCII 图中的 `StructEdit` 只是布局示意缩写，实现时以本节为准。
- 命令面板中各命令的**显示名**统一以 `Batch Replace for JSON & YAML: ` 开头（命令 ID 见 §0.4）。若全称过长影响命令面板可读性，可在 `contributes.commands[].title` 用短前缀 `Batch Replace: `，但 **Marketplace 详情页与 Toolbar 必须用全称**。

### 0.4 内部代号保持不变（避免全文档连带改动）

| 项 | 保持值 | 理由 |
|---|---|---|
| 命令 ID 前缀 | `structedit.*`（附录 B） | VS Code 不要求命令前缀与扩展 ID 一致；改它会波及全文、快捷键与用户配置，收益为零 |
| 表达式集文件名 | `.structedit.json`（附录 A） | 已写入 v3 格式，改名会破坏用户已有文件 |
| 核心包名 / 文档标题 | `core/`、`StructEdit` | 纯内部标识 |
| **UI 与 README 文案** | **一律用 `displayName`，不得出现 `StructEdit`** | 避免用户看到两个名字而困惑 |

### 0.5 发布前检查

- 在扩展面板把 `Batch Replace for JSON & YAML` 原样搜一遍，确认 `displayName` 无重名（官方要求 Marketplace 全局唯一）；同时确认与已占用的 `batch replace`（raindrop）在搜索结果中能明确区分。
- `name` 与 `<publisher>.<name>` 组合唯一；`keywords` ≤ 30、不含 `tool` / `utility` 泛词、大小写与连字符贴合用户实际输入习惯。
- `description` 与 README 首行都含「批量 / Batch」；README 首屏不写客套话、不放外链图片。

---

## 1. 项目定位

在 VS Code 内提供**可视化**的批量编辑面板，双引擎：

- **结构化引擎**：JSON / YAML 按路径批量「设置值 / 删除 / 新增」，最小补丁写回；
- **文本引擎（sed 风格）**：正则替换 / 按模式删除行，**适用于所有文件类型**（.py/.md/.env/.conf/任意文本）。

文件范围由**「目录/路径选择 → 扩展名策略 → 树筛选条件与批量勾选」三层管道**确定（§6），经统一预览确认后一次应用、一次撤销。

三条铁律（违反任何一条即返工）：

1. **最小补丁**：只改命中区间，其余内容逐字节不动（结构化：注释/键序/缩进/引号风格；文本：行尾风格、BOM、非命中内容）。
2. **解析器只用现成开源库**：不写解析器，不封装外部 CLI（jq/yq/sed 本体都不进主链路）。
3. **只做界面与编排**：核心逻辑独立成可单测的纯 TS 包；sed 只借「语法语义」，执行用进程内 JS 正则，不 spawn 进程。
4. **（v1.3 新增）扩展名策略是正确性约束，不是可选项**：结构化指令的适用扩展名由目标格式固定派生（§6.1），用户不可手改；这样保证解析器永远不会投到错误格式的文件上。

## 2. 需求清单

### P0（必须实现）

| 编号 | 需求 |
|---|---|
| R1 | 批量修改：一次操作作用于工作区内多个文件 |
| R2 | 结构化引擎：JSON/JSONC（注释、尾逗号）与 YAML/YML（多文档、锚点、别名） |
| R3 | **多表达式**：一次会话多条指令、混合引擎与操作类型，一次扫描统一应用 |
| R4 | 结构化操作：**设置值（set）/ 删除（delete）/ 新增（insert）**，值支持 string/number/boolean/null/object/array，UI 显式体现 |
| R5 | 文本引擎：sed 风格 `s/pattern/replacement/flags` 替换与 `/pattern/d` 删除行，对所有文件类型可用 |
| R6 | 最小补丁写回 + 逐条 diff 预览 |
| R7 | 文件范围：**树状目录勾选（含子目录级联、筛选条件快速定位）** 与 glob（include/exclude）**双向同步**；**对跨所有目录的命中文件支持全选 / 取消 / 反选 / 仅保留 / 依次选择**（§6.4） |
| R8 | 应用前必须预览确认；应用后**一次 Ctrl+Z 整体撤销** |
| R9 | 结构化路径语言：JSON 与 YAML 共用一套语法与命令模型 |
| R10 | 界面优美、符合 VS Code 设计语言（四主题自适应），达到「编辑器级」质感；**按 §8 + 附录 D 实现** |
| **R11** | **（新增）扩展名策略与引擎/格式绑定**：结构化指令必须选目标格式（JSON / YAML），其适用扩展名由该格式**固定派生、只读不可编辑**（§6.1）；切换格式即切换固定扩展名集合 |
| **R12** | **（新增）文本指令扩展名自由**：sed 指令默认**不加扩展名过滤（全部文件类型）**，用户可**自行添加任意扩展名/文件名过滤条件**（白名单 + 排除），支持无扩展名文件与点文件（`.env`、`Dockerfile`、`Makefile`） |
| **R13** | **（新增）树筛选条件**：文件树/扁平视图允许输入筛选条件（子串 / 扩展名 / glob / 排除 / 多条件 AND），可切换**扁平命中列表**以便跨目录批量操作；命中字符高亮、实时计数、空命中引导 |
| **R14** | **（新增）依次选择（逐个审阅）**：把命中文件排成稳定队列，逐个显示路径 / 适用指令数 / 预计变更数 / 首个 diff，支持「选中并下一个 / 跳过 / 上一个 / 全选剩余 / 结束」及键盘操作（§6.4） |

### P1（应实现）

- 路径输入实时校验与自动补全；编辑器右键「StructEdit: 使用此路径」
- 旧值分布统计（防误伤）；文本替换同样支持「命中预览」
- 表达式集导入/导出（`.structedit.json`，v3 见附录 A）；执行报告导出 Markdown；历史记录
- sed 行地址语法（`1,10d`、`/begin/,/end/d`）
- 扩展名集合可配置（`settings.json` 里补充 `jsonc`/`yaml`/`yml` 之外的别名）；筛选条件历史下拉
- 逐个审阅时支持「全选同类」（按扩展名/目录批量采纳剩余）

### P2（预留，不实现）

- TOML / XML Adapter；变更模板；表达式集导出 CI 脚本（yq/sed 翻译）

## 3. 技术选型

### 3.1 依赖清单

| 包 | 版本 | 用途 | License |
|---|---|---|---|
| `jsonc-parser` | `3.3.1`（锁定） | JSON/JSONC 解析与补丁 | MIT（Microsoft） |
| `yaml` | `2.9.1`（锁定） | YAML 解析与节点定位 | ISC（Eemeli Aro） |
| （无新增依赖） | — | 文本引擎用进程内 JS `RegExp`；扩展名/glob 匹配自实现（不引入新库） | — |

两个库均 0 运行时依赖、宽松许可（MIT/ISC 实务等价：可商用、可闭源、无传染），唯一义务是分发时保留版权与许可声明。

**License 合规要点**：
- esbuild 打包加 `--legal-comments=linked`，生成 `THIRD-PARTY-NOTICES.md`（含两份许可全文）。
- `.vscodeignore` 不排除两个库的 `LICENSE` 文件。

### 3.2 明确不采用的方案（防止实现者走回头路）

| 方案 | 不采用原因 |
|---|---|
| jq / yq / sed / perl 进程做内核 | 外部二进制在 Remote/WSL/vscode.web 不可用；拿不到逐位置 TextEdit；无法与未保存 buffer、一次撤销融合。**sed 只借语法语义，执行用 JS RegExp** |
| `JSON.parse` + `stringify`、`yaml.parse` + `stringify` | 丢注释/精度/键序——本项目要消灭的行为 |
| 自写解析器 | 禁止 |
| `jsonpath-plus` < 10.3.0 或未关 eval | RCE（CVE-2025-1302）；如未来引入必须 `eval: false` |
| **（新增）按文件内容「嗅探」格式决定 Adapter** | 一律按**扩展名 + 指令 `fileScope`** 决定（§6.1）。内容嗅探不确定、与「扩展名固定」冲突、且会让结构化指令投到错误格式文件上产生大量解析失败噪声 |
| **（新增）把扩展名过滤做成全局单一模式** | 会破坏 R3「多指令混合」：不同引擎/格式的指令需要不同的适用文件集。正确做法是**指令级 `fileScope`**，树候选取其并集（§6.0–6.1） |

### 3.3 最终用户运行时依赖：零额外安装（v1.4，硬约束）

> **结论：用户安装 `.vsix` 后即可使用全部 P0/P1 功能，不需要额外安装 Node.js、npm、jq、yq、sed、Git Bash、Python 或任何外部 CLI / 原生模块。**

| 功能 | 运行时实现 | 用户需额外安装 |
|---|---|---|
| JSON/JSONC set / delete / insert | `jsonc-parser`（打包进 `.vsix` 的纯 JS 库） | 无 |
| YAML/YML set / delete / insert | `yaml`（同上） | 无 |
| sed 风格替换 / 删除行 | 进程内 `new RegExp()` + 自实现文本补丁（§5.3） | 无（**不是系统 sed**） |
| 文件树 / glob / 筛选 / 批量勾选 | `workspace.findFiles`、`workspace.fs`、自实现匹配 | 无 |
| diff 预览 / 一次撤销 | `vscode.diff`、`WorkspaceEdit` / `workspace.applyEdit` | 无 |
| apply 前 hash 二次校验 | 宿主 `node:crypto`，Web 宿主用 `crypto.subtle`（按能力选，不引依赖） | 无 |
| 四主题 UI / Codicon / CSP | 随 `.vsix` 分发的字体 + `asWebviewUri` + 内联 HTML/CSS | 无 |
| 表达式集 / 报告导出 | `workspace.fs` + 内置 JSON | 无 |

**依据**

1. VS Code 自带 **Extension Host 运行时**：本地 / Remote 为内置 Node.js，vscode.dev 为 Browser WebWorker；`vscode` 模块由宿主注入，用户**无需**单独安装 Node.js / npm。[官方 Extension Host 文档](https://code.visualstudio.com/api/advanced-topics/extension-host)
2. `vscode:prepublish` 用 esbuild 把运行依赖**内联进 `dist/extension.js`**，`vsce package --no-dependencies` 产出**自包含** `.vsix`；或传统方式把生产 `node_modules` 随包分发。两种方式都不要求用户执行 `npm install`。
3. 两个库均为纯 JS、**0 运行时依赖、无原生模块**（无 `.node` / node-gyp），因此不分平台、无需编译工具链；Windows / macOS / Linux、Remote / WSL / Codespaces 表现一致。这正是 §3.2 放弃外部二进制后带来的直接收益。

**三个必须澄清的误解（实现者不得据此写安装指引）**

1. **方案里没有 jq / yq**（需求沟通中口语所称的「GQ / YQ」）。JSON 与 YAML 分别由 `jsonc-parser` / `yaml` 处理并随包分发；首轮结论「yq 只作为 CI 导出脚本的旁路」不变，插件运行时不调用它。
2. **「sed」不是系统 sed 命令**：只支持 §5.3 定义的 `s/…/…/flags` 与 `/pat/d` 两种语法，执行用 JS `RegExp`。**不需要** Git Bash / MSYS2 / WSL / GNU 或 BSD sed，PowerShell 用户同样可用；功能不会因缺少外部工具而降级。
3. **禁止能力检测式提示**：不得出现「未检测到 sed，请安装 Git Bash」之类的 UI 文案或错误；不得在 README、`package.json` 描述、激活逻辑里要求或探测外部工具。

**代码级禁止项**：扩展宿主与 `core/` 中不得出现 `child_process.spawn` / `exec` / `execFile` 或等价调用；不得引入需在用户机器编译的原生模块；不得运行时动态下载二进制。Webview 侧同样零外部网络请求（§8.7）。

**唯一前提**：VS Code 版本 ≥ `package.json` 的 `engines.vscode` 声明（Marketplace 安装时自动校验），且工作区文件可读。这不构成「额外安装」。

**两个例外（均非插件运行时）**

- **P2「导出 CI 脚本」**（§2 P2 / §12 附加建议第 5 条）：生成的是 `yq -i` / `sed -i` **脚本文本**，插件不执行；仅当用户把脚本放进自己的 CI 流水线时，CI 镜像才需要 yq/sed。
- **开发与测试环境**：`npm ci`、`@vscode/test-electron`、用 `git diff` 做断言都属于开发者机器，与最终用户无关。

> 若未来确需「执行任意完整 sed 脚本」（hold space、`y` 命令、多命令 `;`、地址范围），则与最小补丁、一次撤销、Remote/Web 可用性三项架构约束冲突，需另行立项重新评估；**v1.4 明确不做**，因此不产生任何用户安装要求。

**验收（交付前必查，登记进 §10）**

- `grep -R "child_process\|spawn(\|execFile(" src/` 无命中；
- README / UI 文案 grep `安装 Git Bash|install jq|install yq|install Node` 无命中；
- `unzip -l *.vsix` 含 `THIRD-PARTY-NOTICES.md` 与 Codicon 字体；
- 干净环境冒烟：一台**未安装** Node.js / Git / Git Bash 的 Windows 装 `.vsix` 后完成「YAML set + JSON set + sed `all` + 树筛选 + 一次撤销」全流程；再在 Remote-SSH 工作区复跑一次。

## 4. 总体架构

### 4.1 分层

```
┌───────────────────────────────────────────────────────────────┐
│ ① UI 层 — Webview 面板                                         │
│    表达式区（结构化/文本 双模式）│ 文件树选择器 │ 结果树+diff 预览     │
├───────────────────────────────────────────────────────────────┤
│ ② 控制器层 — 命令注册、状态机（输入→扫描→预览→应用→报告）           │
├───────────────────────────────────────────────────────────────┤
│ ③ 文件选择层 — 目录/路径选择 + 扩展名策略 + 树筛选与批量勾选        │
│               + glob 双向同步 + 读取 + hash 校验                  │
├───────────────────────────────────────────────────────────────┤
│ ④ 路径层 — 统一路径语法 → Segment[]（仅结构化指令使用）            │
├───────────────────────────────────────────────────────────────┤
│ ⑤ 核心引擎 — 三 Adapter，统一产出 MinimalPatch[]                  │
│    JsoncAdapter(jsonc-parser) │ YamlAdapter(yaml) │ TextAdapter(JS RegExp) │
├───────────────────────────────────────────────────────────────┤
│ ⑥ 应用层 — 补丁 → TextEdit → WorkspaceEdit → applyEdit（一次撤销）│
└───────────────────────────────────────────────────────────────┘
```

**统一补丁管道是架构核心**：三种 Adapter 的输出都是基于原文 offset 的 `MinimalPatch[]`，下游（合并、diff 预览、勾选、应用、报告、幂等测试）完全不区分来源。这是「上层命令统一、下层可插拔」的落地方式。

### 4.2 项目结构（建议）

```
structedit/
├── src/
│   ├── core/                  # 纯 TS，禁止 import vscode
│   │   ├── types.ts           # 指令/补丁/匹配/FileScope/选择模型
│   │   ├── pathLang.ts        # 路径解析 → Segment[]
│   │   ├── sedDialect.ts      # sed 简写语法 → 文本指令（解析+校验）
│   │   ├── extensionPolicy.ts # ★ FIXED_EXTS / matchScope / 候选扩展名并集
│   │   ├── treeFilter.ts      # ★ 树筛选条件解析与求值
│   │   ├── jsoncAdapter.ts / yamlAdapter.ts / textAdapter.ts
│   │   ├── engine.ts          # 指令 × 文件 → FileChangePlan（按 fileScope 挑选）
│   │   ├── selection.ts       # 选择模型（glob + 树覆盖 + 批量操作双向换算）
│   │   └── merge.ts           # 补丁合并（倒序、重叠检测）
│   ├── controllers/           # 命令、面板生命周期、状态机
│   ├── ui/                    # webview 前端
│   └── extension.ts
├── test/{core,fixtures,integration}/
├── THIRD-PARTY-NOTICES.md
└── package.json
```

### 4.3 核心接口（照此实现）

```ts
// ===== core/types.ts =====
export type Seg = string | number;
export type Engine = 'structured' | 'text';

// 结构化操作
export type StructOp = 'set' | 'delete' | 'insert';
// 文本操作
export type TextOp = 'replace' | 'deleteLine';

export type ValueType = 'string'|'number'|'boolean'|'null'|'object'|'array';

// ===== ★ v1.3：扩展名适用范围（每条指令一个，执行时的唯一依据） =====
export type FileScope =
  | { mode: 'fixed'; format: 'json' | 'yaml' }           // 结构化：扩展名由格式固定，UI 只读
  | { mode: 'all' }                                       // 文本：不加扩展名过滤（默认，全部文件类型）
  | { mode: 'custom'; include?: string[]; exclude?: string[] }; // 文本：用户任意添加扩展名/文件名

/** 固定映射：结构化引擎唯一允许的扩展名集合（大小写不敏感） */
export const FIXED_EXTS = {
  json: ['json', 'jsonc'],
  yaml: ['yaml', 'yml'],
} as const;

export interface Instruction {
  id: string;
  enabled: boolean;
  engine: Engine;

  // ★ 每条指令适用哪些文件（按扩展名/文件名），引擎自动初始化，见 §6.1
  fileScope: FileScope;

  // engine === 'structured'
  format?: 'json' | 'yaml';          // ★ 目标格式；必须与 fileScope.mode==='fixed' 一致
  kind?: StructOp;
  path?: string;                    // 统一路径语法
  value?: string;                   // UI 原始输入
  valueType?: ValueType;            // 缺省=沿用旧值类型
  scope?: 'all' | 'first';
  createPath?: boolean;             // set 时父路径不存在是否创建（默认 false）

  // engine === 'text'
  textOp?: TextOp;
  pattern?: string;                 // JS RegExp 源文本
  flags?: string;                   // 'g' | 'i' | 'gi' | 'm' …（无 g 时仅首个命中）
  replacement?: string;             // 支持 $1..$9、$&、$`、$'
  lineRange?: { from?: number; to?: number };  // P1：行地址限定（1-based，可省略一端）
}

export interface Match {
  instructionId: string;
  engine: Engine;
  segs?: Seg[];                     // structured：规范化绝对路径
  range: { start: number; end: number };   // 原文 offset，仅覆盖命中区间
  oldValue: unknown;
  oldType?: ValueType;
  line: number;                     // 1-based，UI 展示与跳转用
  /** 结构化：路径链上有锚点/别名/merge；文本：正则回溯风险等 */
  risky?: 'anchor' | 'alias' | 'merge' | 'multiDoc' | 'catastrophic';
}

export interface MinimalPatch {
  match: Match;
  start: number;
  end: number;                      // 替换区间 [start,end)
  newText: string;                  // '' 即删除
  note?: string;
}

export interface FileChangePlan {
  uri: string;
  format: 'json' | 'yaml' | 'text';
  parseErrors?: string[];           // 非空 → 整文件跳过进报告
  patches: MinimalPatch[];          // 已按 start 倒序
}

// ===== core/textAdapter.ts =====
export const TextAdapter = {
  /** 文本指令直接在原文上执行，产出 offset 补丁；不经过任何解析器 */
  plan(text: string, ins: Instruction[]): { patches: MinimalPatch[]; skipReason?: string },
};

// ===== ★ core/extensionPolicy.ts =====
export function matchScope(file: { path: string; name: string }, scope: FileScope): boolean;
export function candidateExtensions(instructions: Instruction[]): Set<string> | 'all';
export function scopeToGlob(scope: FileScope): string[];   // 供等效 glob 展示

// ===== ★ core/selection.ts / core/treeFilter.ts =====
export interface TreeFilter {
  raw: string;                      // 用户原始输入，如 "conf *.yaml !legacy"
  include: string[];                // 解析后的正向条件
  exclude: string[];                // 解析后的排除条件
  view: 'tree' | 'flat';            // 目录树 / 跨目录扁平命中列表
}
export function parseTreeFilter(raw: string): TreeFilter;
export function matchTreeFilter(fileRelPath: string, f: TreeFilter): boolean;

export interface SelectionState {
  baseInclude: string[];
  baseExclude: string[];
  treeFilter: TreeFilter;           // ★ 仅影响显示与批量操作作用集，不改变已勾选态
  overrides: {
    add: Set<string>;               // glob 未选中但树上勾选
    remove: Set<string>;            // glob 选中但树上取消
  };
}
```

### 4.4 关键原则

1. **命令层描述意图，Adapter 层负责实现**：上层只见 `Instruction / Match / MinimalPatch`，不知道下层是哪个库还是纯正则。
2. **一切写回必须走 `workspace.applyEdit(WorkspaceEdit)`**，禁止对用户文件 `fs.writeFile`。收益：原生冲突处理、未打开文件正确落盘、一次 Ctrl+Z 全量撤销。
3. `core/` 不 import `vscode`；纯 Node 可测。
4. 同一文件多补丁按 `start` 倒序合并；区间重叠 → 该文件标红，强制拆分指令。
5. **文本指令与结构化指令可在同一会话混用**，但同一文件内补丁不得重叠（引擎在 merge 层统一裁决，与指令来源无关）。
6. **（v1.3）扩展名策略单一真相 = 指令 `fileScope`**：文件树的候选扩展名 = 所有启用指令 `fileScope` 的并集（§6.0）；扫描时对每个文件只投「`fileScope` 命中」的指令（§5.4）。UI 上的「目标格式分段」只是**新建指令的默认值入口**，不另行维护一套独立过滤，避免双份真相不一致。

## 5. 指令语言设计

### 5.1 结构化路径语法（v1）

```
$.a.b[0].c          精确定位
$.items[*].name     数组通配
$.*.port            对象键通配（一层）
$.a["weird.key"]    含点/特殊字符的键
```

- 前导 `$.` 可省略；编译为 `Segment[]`，通配编译为 `{wildcard}` 由引擎展开。
- v1 不做过滤器（`[?(@.x==1)]`），token 预留，P2 接 `jsonpath-rfc9535`。

### 5.2 类型与值解析规则

| 场景 | 规则 |
|---|---|
| set，未选类型 | 按旧值类型序列化新输入；解析失败报错而非静默转字符串 |
| set，显式类型 | 按所选类型；string 在 YAML 中必要时加引号（`"5432"`、`"true"`、`"~"`、特殊字符开头） |
| insert | 必选类型；object/array 用 JSON 文本框 |
| number | 校验 isNaN；>2^53 大整数以字面量原样写入 |

### 5.3 文本引擎：sed 风格方言（核心规范）

#### 语法输入（两种等价形态）

**A. sed 简写**（输入框自动识别、解析并展开为表单字段）：

```
s/registry\.acme\/payments:v1/registry.acme/payments:v2/g
s/foo/bar/i
/^\s*#\s*TODO/d          ← 删除匹配行（整行连同换行符）
```

**B. 结构化表单**：模式（pattern）+ 替换为（replacement）+ 标志（g / i / m 勾选）+ 操作类型（替换 / 删除行）。

sed 简写解析规则（`sedDialect.ts`）：
- 首字符为分隔符（支持 `/`、`|`、`,`、`#`、`~`），按**未转义的分隔符**切分三段；
- 末段为 flags，仅接受 `g`、`i`、`m`、`gi` 等已知组合，出现未知字母 → 报错提示改用表单；
- 替换段中 `\1` 转为 `$1`（sed → JS 反向引用习惯），`\\`、`\/`（转义分隔符）原样还原；
- `/pattern/d` 识别为 deleteLine；行地址语法（`1,10d`）P1 再做；
- **明确不支持**并给出友好报错：hold space、`p`/`w`/`y` 命令、多命令 `;` 连接——检测到即提示拆成多条指令。

#### 语义规范

| 项 | 规范 |
|---|---|
| 正则引擎 | 进程内 `new RegExp(pattern, flags)`，**不 spawn sed 进程**；语法错误在输入时即时校验（红框 + 原因） |
| 标志 | `g`=全部命中（缺省仅首个）、`i`=忽略大小写、`m`=多行模式（`^$` 按行匹配） |
| 替换串 | JS 语义：`$1..$9`、`$&`（整体匹配）、`` $` ``、`$'`；不支持 sed 的 `\U` 等 |
| 删除行 | 删除区间 = `[行首, 行尾换行符之后)`，即**整行连同换行符**；最后一行无换行符时只删到 EOF |
| 行边界 | 匹配在「去行尾符的行文本」语义上进行（`m` 标志），避免 `\r` 进入匹配结果干扰；补丁 offset 仍映射回原文 |
| CRLF | 行尾风格检测（首行），补丁不触碰行尾；删除整行时连同其 CRLF |
| BOM | offset 补丁天然保留 BOM（它只是开头字节，不落入任何命中区间） |
| 命中上限 | 单文件命中 ≤ 2000 处（可配），超限截断 + 警示 |
| 回溯风险 | pattern 长度 > 256 或含嵌套量词（`(a+)+` 形态启发式检测）→ Match 标 `risky: 'catastrophic'`，黄色警示 |

#### 文件类型安全（文本引擎特有，`all` 模式同样适用）

| 检查 | 规则 |
|---|---|
| 二进制文件 | 前 8KB 含 `0x00` → 跳过并报告「二进制文件已忽略」 |
| 编码 | `TextDecoder('utf-8', { fatal: true })` 解码失败 → 跳过并报告「非 UTF-8 文本已忽略」（不做转码，避免写坏） |
| 巨型文件 | > 5MB 跳过文本引擎并提示（可配置放宽） |
| 全类型默认开启 | 文件类型是否参与由**指令 `fileScope`** 决定（§6.1）：`all` = 不过滤扩展名，`custom` = 用户自定义；**两者都仍受本表安全跳过与目录选择约束**——「不加扩展名过滤」≠「放松安全」 |
| 危险模式提醒 | 删除行指令命中行数 > 500 时应用前弹汇总确认 |

### 5.4 多表达式执行语义（v1.3 补充 fileScope 挑选）

- **扫描前置：按 `fileScope` 挑选适用指令**（唯一真相，见 §4.4 原则 6）：

```
候选文件集 S = 选择层产出（§6.0 三层管道结果）
for (const file of S) {
  const applicable = instructions.filter(i => i.enabled && matchScope(file, i.fileScope));
  if (!applicable.length) continue;             // 无适用指令 → 不进结果树（也不报失败）
  plans.push(engine.plan(file, applicable));    // 多指令语义见下
}
```

- 由此带来的保证：结构化 JSON 指令**不会**被投到 `.yaml` 文件（不会产生解析失败噪声）；一条 `all` 文本指令可同时改 `.json`/`.yaml`/`.py`/`.md`——这正是「不加扩展名过滤」的价值；`custom` 文本指令只作用于用户指定扩展名。
- 扫描阶段：每条适用指令独立求值 → Match 集 → 补丁集。
- 同文件冲突：任意两条指令（跨引擎也算）补丁区间重叠 → 该文件整体标红、列出冲突对，**不部分应用**。
- `scope: 'first'` 只取第一个命中；同一指令多处命中全部生成补丁、倒序合并。
- 执行顺序按指令行序；结构化指令在该文件解析失败时自动降级为「跳过该文件的结构化指令」，**文本指令不受影响继续执行**（两者互不依赖）。

## 6. 文件选择设计（v1.3 整章重排）

### 6.0 总览：三层过滤管道（单一真相）

```
工作区文件全集（workspace.findFiles 一次拉取，§6.5）
   │
   ├─ [第 1 层] 目录 / 路径选择  ── 树勾选 + glob（§6.2），得到「范围集 S」
   │
   ├─ [第 2 层] 扩展名策略      ── 指令 fileScope（§6.1），决定「哪些扩展名是候选」
   │      · 结构化 JSON → {json, jsonc}        固定只读
   │      · 结构化 YAML → {yaml, yml}          固定只读
   │      · 文本 all    → 全部文件类型（不过滤）
   │      · 文本 custom → 用户任意扩展名/文件名（白名单 + 排除）
   │      ★ 树的候选扩展名 = 所有启用指令 fileScope 的并集；出现任一 all 即并集为「全部」
   │
   ├─ [第 3 层] 树筛选条件      ── 用户输入（§6.3），在候选内再筛出「当前命中集 H」
   │      · 只影响显示 + 批量操作的作用集合，不自动改变已勾选态
   │
   └─ 批量勾选 / 依次选择（§6.4）对 H 跨所有目录操作 → 写回 overrides → 与 glob 双向同步
                                    │
                                    ▼
              最终参与扫描的文件 = 范围集 S 中被勾选 ∧ 属于候选扩展名
                                    │
                                    ▼
              每个文件只接收 fileScope 命中的指令（§5.4）
```

**为什么这样分层**：第 1 层管「在哪找」，第 2 层管「什么类型有意义」（由引擎正确性决定，不可随意改），第 3 层管「这次想看/想选哪些」（纯 UI 便利）。三层职责不重叠，且与 R3 多指令混合完全兼容。

### 6.1 扩展名策略（引擎/格式绑定）★ 本轮核心

#### 策略表

| 用户选择 | 引擎 | `fileScope` | 适用扩展名 | UI 是否可编辑 |
|---|---|---|---|---|
| **JSON** | 结构化 | `{ mode:'fixed', format:'json' }` | `*.json`, `*.jsonc` | **否（固定只读）**，显示 🔒 徽标 + tooltip「由目标格式 JSON 固定」 |
| **YAML** | 结构化 | `{ mode:'fixed', format:'yaml' }` | `*.yaml`, `*.yml` | **否（固定只读）**，tooltip「由目标格式 YAML 固定」 |
| **Sed / 文本** | 文本 | `{ mode:'all' }`（默认） | **全部文件类型，不加扩展名过滤** | 可切到「自定义」 |
| **Sed / 文本 · 自定义** | 文本 | `{ mode:'custom', include?, exclude? }` | 用户任意添加：`py`/`sh`/`env`/`conf`/`tf`/`md`… 支持 `*.ext`、无扩展名文件名（`Dockerfile`、`Makefile`）、点文件（`.env`、`.gitignore`） | **是**，标签输入 + 排除项 |

**固定映射常量**（`FIXED_EXTS`，见 §4.3）：
- `json → ['json','jsonc']`（`.json` 即使含 `//` 注释也走 jsonc-parser，无需用户区分）
- `yaml → ['yaml','yml']`
- 扩展名比较**大小写不敏感**（`.YAML` 视为 yaml）；P1 允许在 `settings.json` 追加别名，但不改变「只读」性质。

#### 关键规则

1. **结构化指令必须选目标格式（JSON / YAML）**，UI 上作为指令行的分段/下拉；选定即自动写入 `fileScope = {mode:'fixed',format}` 且 `format` 字段同步。**用户不能手工增删扩展名**——切换格式是唯一改变集合的方式。
2. **文本指令默认 `all`**：不加任何扩展名过滤，所有文件类型都参与（仍受 §5.3 安全跳过 + 目录选择约束）。用户点「自定义」后进入 `custom`，可**任意添加**任意扩展名/文件名条件，也可随时切回 `all`。
3. **树的候选扩展名 = 启用指令 `fileScope` 并集**（`candidateExtensions()`）：
   - 只有结构化 JSON 指令 → 树里高亮/可勾选的候选固定为 `.json/.jsonc`；
   - 再加一条 YAML 指令 → 候选并集变为 `.json/.jsonc/.yaml/.yml`；
   - 再加一条 `all` 文本指令 → 候选扩展为**全部文件类型**，并在文件范围区提示「已启用全部文件类型（来自文本指令）」；
   - `custom` 只把用户列出的扩展名并入。
   - **没有第二套「全局模式」过滤**：文件范围区顶部的「目标格式分段（JSON / YAML / Sed）」仅作为**新建指令的默认值入口**与视觉引导，不参与执行判定。切换它**不改动已存在指令的 `fileScope`**（保护混合会话）。
4. **候选之外的文件**：树里灰显（`disabledForeground` + 说明「当前指令不适用此类型」），默认不可勾选；提供「显示全部文件」开关可查看但勾选时给出警示。
5. **等效 glob 要体现扩展名策略**（`scopeToGlob()`）：例如结构化 JSON + YAML 会话生成 `**/*.{json,jsonc,yaml,yml}` 附加到 include 摘要；`all` 文本指令则不加扩展名约束。

#### `custom` 匹配语法与算法（`matchScope`）

| 条目形态 | 示例 | 匹配对象 |
|---|---|---|
| 纯扩展名（无点、无通配） | `py`, `env`, `tf` | 文件扩展名（最后一个 `.` 之后，忽略大小写） |
| `*.ext` | `*.yaml`, `*.tf*` | 等价扩展名条件，支持 `*` 通配 |
| 文件名 / 点文件 | `Dockerfile`, `Makefile`, `.env`, `.gitignore` | 对 basename 做 glob（忽略大小写） |
| `*` | `*` | 所有文件 |
| 排除项 | `exclude: ['min.js', '*.lock']` | 命中即排除，优先级高于 include |

```
matchScope(file, scope):
  if scope.mode === 'fixed': return lower(extOf(file.name)) in FIXED_EXTS[scope.format]
  if scope.mode === 'all'  : return true
  // custom
  if any(globMatch(file.name, e) for e in scope.exclude ?? []): return false
  if !scope.include || scope.include.length === 0: return true   // 空 include = 全部（除 exclude）
  return any(globMatch(file.name, e) or extEquals(e, extOf(file.name)) for e in scope.include)
```

> 说明：目录/路径不在 `fileScope` 管辖，属于第 1 层（§6.2）。`extOf` 对无扩展名文件与点文件返回空串，因此这两类文件只能靠文件名条件命中——这是 R12 明确要求支持点文件/无扩展名文件的原因。

#### 混合会话示例（一次会话 4 条指令）

| 指令 | `fileScope` | 实际作用文件 |
|---|---|---|
| YAML set `containers[*].image` | `fixed / yaml` | `*.yaml`, `*.yml` |
| JSON set `$.version` | `fixed / json` | `*.json`, `*.jsonc` |
| sed 替换镜像地址 | `custom include:['env','sh','md']` | `*.env`, `*.sh`, `*.md` |
| sed 删除 TODO 行 | `all` | **所有文件类型**（含上面全部） |

四者互不串格式，且树的候选扩展名自动为「全部」。

### 6.2 选择模型（canonical）

```
SelectionState {
  baseInclude: string[];      // glob 列表，如 ['config/**', 'scripts/**']
  baseExclude: string[];      // glob 列表
  treeFilter: TreeFilter;     // ★ 树筛选条件（§6.3），只影响显示与批量操作作用集
  overrides: {                // 树上手动勾/取消产生的增量（以 URI 记录）
    add: Set<string>;         // glob 未选中但树上勾选
    remove: Set<string>;      // glob 选中但树上取消
  };
}
有效文件集 = findFiles(baseInclude, baseExclude) ∪ add − remove
```

**双向同步规则**：

- 编辑 glob 输入框 → 清空 overrides，树按新结果重渲染；
- 树上勾/取消文件夹或文件 → 写入 overrides；**同时把 glob 输入框切换为「只读摘要态」**（显示「自定义选择（17 个文件）」），点摘要可展开看到等效 glob（文件夹勾选自动生成 `folder/**`，并附上 §6.1 的扩展名表达式）；提供「重置为 glob」按钮回到纯 glob 模式。
- 树勾选文件夹 = 级联勾选其下**当前未被过滤隐藏**的全部候选文件（过滤后只作用于可见项）。
- **（v1.3）批量操作与逐个审阅的每一次勾选都即时写入 overrides**，与树/glob 双向同步，不另建状态。

### 6.3 树筛选条件（★ 增强）

| 能力 | 规范 |
|---|---|
| 输入位置 | 文件范围区顶部过滤框（§8.10）；`Ctrl+F` 聚焦；150ms 防抖 |
| 条件语法 | 空格分隔为 **AND**；支持 4 类混写：① 子串 `conf`；② 扩展名 `*.yaml`、`ext:yaml,yml`；③ 相对路径 glob `config/**/prod/*`；④ 排除 `!legacy` / `-*.min.js`。大小写不敏感 |
| 解析 | `parseTreeFilter()` 拆成 `include[]` / `exclude[]`；非法字符转义为字面量，不抛异常；输入框下方给出「已解析：conf ∧ *.yaml ∧ ¬legacy」可读回显 |
| 作用范围 | **对全部目录**的相对路径求值，跨目录汇总命中；只影响**显示**与**批量操作的作用集合**，**不自动改变已勾选状态**（除非显式执行 §6.4 操作） |
| 命中高亮 | 命中字符用 `notificationsInfoIcon-foreground` 高亮；被排除/非候选目录灰显 |
| **扁平结果视图** | 过滤态下可切「树状 / 扁平」：扁平视图把所有目录的命中文件列成**跨目录清单**（显示相对路径 + 扩展名 + 适用指令数 + 预计变更数徽标），按路径排序，支持虚拟滚动——**这是「对所有目录符合的文件便利全选」的关键** |
| 计数与反馈 | 过滤框右侧常显「命中 N 个文件 · 已选 M 个」；批量操作前预览作用数量 |
| 空命中 | 空态（图标 + 一句说明 + 主操作「清除条件 / 放宽为子串」），点击即改写条件 |
| 与扩展名策略叠加 | 先按 §6.1 候选扩展名收敛，再在候选内跑筛选条件；扁平/树视图都只显示候选文件（除非开「显示全部文件」） |
| 性能 | 在已建树数据上前端求值，**不重新 `findFiles`**；>500 条虚拟滚动 |
| 持久化 | `treeFilter.raw` 随 `.structedit.json` 保存（附录 A），复现同一批选择 |

### 6.4 批量选择操作与「依次选择」（★ 增强）

过滤框下方常驻批量操作条，作用对象恒为**当前命中集 H**（跨所有目录）：

| 操作 | 语义 | 二次确认 |
|---|---|---|
| **全选命中** | 勾选 H 中全部候选文件（不改变 H 之外已勾选项） | 否 |
| **取消命中** | 仅取消 H 中文件的勾选 | 否 |
| **反选命中** | H 中文件逐个取反 | 否 |
| **仅保留命中** | 把选择集收敛为 H（H 之外全部取消） | **是**（可能大批量取消） |
| **按目录批量** | 目录节点右键「仅勾选本目录命中项」/「取消本目录命中项」 | 否 |
| **清除筛选** | 恢复树状全量视图，**勾选状态原样保留** | 否 |
| **只看适用文件** | 开关：只显示候选扩展名文件（§6.1） | 否 |

**依次选择（逐个审阅，Sequential Review）** —— 对「想一个个确认」的场景：

- 触发：点「依次选择」或快捷键；把 H 按相对路径排序成**稳定队列**，进入审阅态。
- 审阅卡显示：`3 / 17` 进度、相对路径、扩展名徽标、**适用指令数**、**预计变更数**、**首个 diff 片段**（复用 §8.2 的 diff 组件）。
- 操作：`选中并下一个`（默认主操作）、`跳过`（保持不勾/取消并下一个）、`上一个`、`全选剩余`、`结束审阅`；P1 增加「全选同类（同扩展名/同目录剩余）」。
- 键盘：`→` / `Enter` 选中并下一个、`←` 上一个、`Space` 切换当前项勾选、`Esc` 退出（已做的选择保留）。
- 每次操作即时写 overrides（§6.2），概览条与树节点徽标实时刷新；退出后回到结果态。
- 与 §8.2 状态机关系：审阅属于**选择阶段**，在「扫描/结果」之前或之后均可进入，不打断已有状态；进入时暂停 300ms 防抖重扫，退出时恢复。
- 空队列、队列末尾、中途筛选变化（H 改变）都要有明确处理：筛选变化 → 退出审阅并提示重新进入，避免队列错乱。

### 6.5 树选择器规范

| 能力 | 规范 |
|---|---|
| 数据来源 | `workspace.findFiles('{**/*}', defaultExclude, 20000)` 一次拉取，按相对路径字符串建树；**不逐目录 stat**（性能） |
| 候选收敛 | 按 §6.1 `candidateExtensions()` 标出候选文件；非候选灰显 + tooltip |
| 文件量上限 | 2 万；超出提示先缩小范围（树与扫描都虚拟化/分页） |
| 三态勾选框 | 文件夹：全选/部分/空（部分=●）；父随子自动更新；`aria-checked="mixed"` |
| 过滤框 | 见 §6.3（子串 + 扩展名 + glob + 排除，跨目录） |
| 过滤快捷片 | `*.yaml` `*.json` `*.env` `*.py` `*.md`；点击即填筛选条件；**结构化模式下与当前格式不兼容的快捷片禁用并说明原因** |
| 视图切换 | 树状 / 扁平命中列表（§6.3） |
| 快捷操作 | 全选 / 清空 / 反选 / 仅显示已选 / 折叠全部；「仅显示已选」= 快速审计当前范围 |
| 联动命中 | 扫描完成后树节点显示徽标：命中变更数（如 `config/prod ●6`）；「只看有命中的文件」开关 |
| 键盘 | `↑↓` 移动、`Space` 勾选、`→/←` 展开收起、输入字符直接聚焦过滤框 |
| 渲染 | >500 可见节点虚拟滚动（复用 TreeItem 或自实现窗口化） |
| 图标 | 使用当前主题的文件图标（`FileTheme`）或按扩展名映射 codicon，保持 VS Code 原生观感 |

### 6.6 读取与一致性

- 已打开文件用 `workspace.openTextDocument(uri).getText()`（含未保存内容）；未打开用 `workspace.fs.readFile` + fatal UTF-8 解码（兼容 remote/虚拟工作区）。
- **hash 二次校验**：扫描时记录内容 hash，`apply` 前重读比对；不一致的文件跳过并进报告（防扫描与应用之间被改动/格式化）。
- 默认 exclude：`**/node_modules/**, **/.git/**, **/dist/**, **/out/**`（可覆盖）。
- 符号链接 / 工作区外文件：不跟随出界，跳过并报告。

## 7. 核心引擎规范（最小补丁算法）

### 7.1 JsoncAdapter（JSON/JSONC）

- `parse`: `jsonc.parseTree(text, errors)`；errors 非空 → 该文件标解析失败（结构化指令跳过，文本指令照常）。
- `locate`: `jsonc.findNodeAtLocation(root, segs)`（通配符自行遍历 children）；取 property 的 value 节点 `offset/length`。
- `plan(set)`: 优先 `jsonc.modify(text, path, value)`，**不传 `formattingOptions`**（传了会重排编辑点附近）。
- **多值修改禁止拼接多个 EditResult**（官方明确 offset 相对原文、不可连接）：同文件多结构化指令循环 `parseTree → modify → applyEdits`，逐轮基于最新文本，并把每轮 Edit 映射回统一 offset 空间（记录累计位移）。
- `delete`: `modify(text, path, undefined)`；删除后若残留空行，追加一个收敛补丁（note 标注，幂等测试覆盖）。
- `insert`: 数组用 `isArrayInsertion: true`；新键走不存在的 path（自动追加到对象**末尾**，其余键顺序不动）。

### 7.2 YamlAdapter（YAML）

- `parse`: `yaml.parseAllDocuments(text, { keepSourceTokens: true, lineCounter: new LineCounter() })`；`doc.errors` 非空 → 结构化跳过。多文档命中标 `multiDoc`，UI 显示 `doc#2` 徽标。
- `locate`: `doc.getIn(segs, /* keepScalar */ true)`（不 unwrap）；通配自行遍历 `items`。
- **补丁生成（核心，禁止 `String(doc)` 整篇输出）**：

```ts
const node = doc.getIn(segs, true) as Scalar;
const [start, valueEnd] = node.range!;        // 用 value-end：valueEnd..nodeEnd 是行尾注释，不得覆盖
node.value = newValue;
node.source = undefined;                      // 清缓存，否则 toString() 吐旧值
const snippet = node.toString({ lineWidth: 0 });  // 沿用原 Scalar.type → 引号风格不变
patch = { start, end: valueEnd, newText: snippet };
```

  - 复用原 `Scalar` 对象（非 `new Scalar`）才继承 `type/format`。
- `delete`（map 项）：删除 Pair 完整源区间**连同前导缩进与换行**（用 `srcToken` 或扫描行首确定），并删除挂其上的 `commentBefore` 行。
- `insert`: 父 map 末尾插入 `key: value\n`，缩进 = 父缩进 + 相邻行推断步长。
- **锚点/别名/merge 防护**：路径链遇 `Alias`、节点带 `anchor`、父 map 含 `<<:` → Match 标 `risky`，UI 黄色警示（不阻止操作）。
- 永不调用：`yaml.stringify`、整篇 `doc.toString()`、`sortMapEntries: true`。

### 7.3 TextAdapter（所有文件类型）

```ts
plan(text, ins) {
  // 0) 是否参与由 §5.4 的 fileScope 挑选决定；此处只处理已投进来的文本指令
  // 1) 二进制/编码/大小检查（§5.3 文件类型安全）→ skipReason
  // 2) replace: new RegExp(pattern, flags) 逐命中产补丁：
  //    { start: m.index, end: m.index + m[0].length, newText: m[0].replace(re, replacement) }
  //    —— 用 replace 一次性算 newText，避免手写 $& 展开出错
  // 3) deleteLine: 对每个命中行 { start: lineStart, end: lineStart + lineLen + eolLen, newText: '' }
  // 4) 命中数超限 → 截断 + 警示；回溯风险启发式 → risky 标记
}
```

- 与结构化补丁走同一条 merge 管道（倒序、重叠检测、diff、应用）。
- 文本 Match 的 `oldValue` 为命中的原文片段（截断到 120 字符用于 UI 展示）。

### 7.4 类型保持速查表（结构化）

| 旧节点 | set 输入 "5432" 的写出 |
|---|---|
| JSON number / YAML PLAIN number | `5432` |
| YAML QUOTE_DOUBLE `"5432"` | `"5432"` |
| insert（string） | JSON/YAML 均显式 `"5432"` |
| insert（number） | `5432` |

### 7.5 应用与撤销

```ts
const we = new vscode.WorkspaceEdit();
for (const file of plan.changedFiles) {
  const doc = await vscode.workspace.openTextDocument(file.uri);
  we.set(file.uri, file.patches.map(p =>
    new vscode.TextEdit(new vscode.Range(doc.positionAt(p.start), doc.positionAt(p.end)), p.newText)));
}
await vscode.workspace.applyEdit(we);   // 一次提交 → 一次 Ctrl+Z 全撤
```

- 应用后 toast：「已修改 N 个文件 · M 处变更」；v1 用提示 Ctrl+Z 撤销，v2 记录反向补丁提供 `structedit.undoLast` 命令。

## 8. UI / UX 设计（v1.3 自包含，对齐《UI 铁律》）

> **本节为文档内自包含规格，实现不依赖任何外部文件。** 面板形态：**编辑器 Tab 中的 Webview 面板**。质感目标：与 VS Code 设置页 / 内置搜索一致的原生高密度工具界面，**不做圆角卡片式网页落地页**。
> **实现 Agent 必读**：附录 D 是本节规则的原始依据（权威要求），本节是其规则化落地；附录 C 是 UI 交付物格式；§10.6 是逐条验收清单。四者需一并满足。

### 8.0 五条 UI 铁律（实现与后续一切 UI 维护一律适用，违反任意一条即返工）

1. **主题适配是第一优先级**：`body.vscode-light / -dark / -high-contrast / -high-contrast-light` 四套全部通过；HC 主题下不得仅靠背景色区分层级，必须有 1px `--vscode-contrastBorder` 显式边框。
2. **禁止硬编码颜色**：除 `rgba()` / `color-mix()` 做透明度叠加外，样式中不允许 `#hex` / `rgb()` / `hsl()` 字面量。本插件**不使用品牌强调色**，全部走主题变量（省掉品牌色在 HC 下的降级问题）。
3. **不引入任何外部网络资源**：图标用随扩展分发的 Codicon（`@vscode/codicons`），资源全走 `asWebviewUri`，CSP 的 `font-src` / `style-src` / `img-src` 只允许 `${webview.cspSource}`；无 CDN、无外链、无遥测。
4. **只改视觉层**：改样式不得动业务逻辑、数据结构、API、事件与组件树；保持最小 diff。
5. **不发明变量名**：只用官方文档确认存在的 `--vscode-*` 变量；不确定的改用「已确认变量 + color-mix 叠加」。

### 8.1 信息架构（顶部概览条 + 三区 + 粘性底栏）

```
┌─ Toolbar: [◎ StructEdit] [导入][导出][历史▾][帮助] ───────────────────┐
├─ 概览条（贯穿常驻）: 变更 55 · 文件 17 · 警示 2 · 解析失败 3 · [扫描状态/进度] ┤
├─ 区块① 指令 ── 引擎分段（结构化 | 文本 sed）────────────────────────┤
│  结构化区：[格式: JSON|YAML] [✎设置值|🗑删除|＋新增] 多行卡片 + 旧值分布 │
│  文本区：  [s/…/…/gi 替换] [/…/d 删行] + 扩展名过滤 + 命中预览样本      │
├─ 区块② 文件范围 ── 目标格式分段 | 扩展名策略 | 过滤+批量操作条 ─────────┤
│  左：树/扁平命中列表（筛选+三态勾选）│ 右：等效 glob 摘要/编辑          │
├─ 区块③ 结果 ── 左：命中树（按目录/类型分组）│ 右：diff 预览 ─────────────┤
├─ 粘性底栏: [预览全部 Diff] [应用 55 处变更 →]  一次 Ctrl+Z 整体撤销        │
└──────────────────────────────────────────────────────────────────┘
```

**区块控件清单（文档内自包含，Agent 按此搭建，无需原型文件）**：

| 区块 | 控件 | 说明 |
|---|---|---|
| Toolbar | 标题 + 导入/导出/历史 | 次按钮，见 §8.3 |
| 概览条 | 变更/文件/警示/解析失败/冲突 计数 + 扫描进度条 | 异常数字用语义色，点击跳分组 |
| ① 指令 | 引擎 Tab（结构化 / 文本 sed）、每条指令行（启用勾选、操作下拉、**格式分段或扩展名控件**、路径/模式输入、值输入、类型下拉、删除按钮、元信息行）、添加指令按钮 | 双引擎可混用；详见 §8.10 扩展名控件 |
| ② 文件范围 | 目标格式分段、`fileScope` 只读徽标/可编辑标签、过滤框（含解析回显）、树状/扁平切换、命中/已选计数、批量操作条、树/扁平列表（三态勾选 + 命中高亮 + ●N 徽标）、右侧等效 glob（include/exclude/重置） | **完整规范见 §8.10** |
| ③ 结果 | 命中树（目录/类型分组、set/del/ins/sed 徽标、警示、跳转按钮）、diff 预览（行号、−/+ 符号、上下文、警示条） | 见 §8.3 diff 配色 |
| 底栏 | 统计 + 预览全部 Diff + 应用（主按钮）+ 撤销提示 | sticky |

### 8.2 交互流（状态机）

`输入态 → 扫描中 → 结果态 → （预览）→ 确认 → 应用 → 报告态`

- 指令或选择变更后 **300ms 防抖自动重扫**；扫描带进度（`12/17`）与取消。
- 概览条是全局健康度：任何一项异常（警示/失败/冲突）对应数字变黄/红，点击跳到对应分组。
- 「应用」触发条件守卫：存在 delete/deleteLine 且命中 > 20 → 汇总确认；> 500 → 列明细确认。
- 无匹配空态：给出两条可点建议（放宽筛选条件 / 扩大文件范围），点击自动改写。
- 解析失败文件独立分组，悬浮显示 error 首行；文本指令照常执行的结构化失败文件标「仅结构化跳过」。
- **（v1.3）扩展名策略变化（新增/切换格式/切 all↔custom）也触发重扫**，树候选扩展名与命中计数同步刷新。

### 8.3 色彩与语义映射表（全部为官方主题变量）

| 用途 | 变量 |
|---|---|
| 主文本 | `--vscode-editor-foreground` |
| 次要说明 | `--vscode-descriptionForeground` |
| 禁用 | `--vscode-disabledForeground` |
| 层级背景 | `editor-background` → `sideBar-background` → `editorWidget-background`；hover 用 `list-hoverBackground`；代码块 `textCodeBlock-background` |
| 主按钮 | `--vscode-button-background / -foreground / -hoverBackground`；次按钮 `--vscode-button-secondary*`（含 secondaryHoverBackground） |
| 输入框 | `--vscode-input-background / -foreground / -border / -placeholderForeground`；校验态 `inputValidation-error\|warning\|infoBorder` |
| 状态色（语义） | 删除/错误 = `--vscode-errorForeground`；警示 = `--vscode-editorWarning-foreground`；信息 = `--vscode-notificationsInfoIcon-foreground`。**不自定义红黄绿** |
| 操作徽标色 | set/replace = `--vscode-charts-blue`；delete = `--vscode-errorForeground`；insert = `--vscode-charts-green`；警示 = `--vscode-editorWarning-foreground`。**仅用于徽标/图标/行内高亮（面积 <5%），禁止大面积色块与渐变** |
| 焦点 / 边框 / 链接 / 徽标 / 滚动条 | `focusBorder` / `panel-border`·`editorWidget-border`·`contrastBorder`(HC) / `textLink-foreground` / `badge-background/-foreground` / `scrollbarSlider-*` |
| 勾选框 | `--vscode-checkbox-background / -foreground / -border`（三态框自绘时用） |
| diff | `diffEditor-removedLineBackground / insertedLineBackground` 行底色；`−/+` 符号用 `errorForeground` / `charts-green`；未变更行用 `descriptionForeground` |
| 代码点缀色 | key = `charts-blue`、字符串 = `charts-orange`、数字 = `charts-purple`、注释 = `descriptionForeground`（Webview 拿不到 token 色，用官方 charts-* 变量，随主题自适应） |
| **只读/锁定态** | `disabledForeground` + `input-border`；🔒 图标 codicon `lock`，tooltip 说明「由目标格式固定」 |

- 文字对比度 ≥ WCAG AA **4.5:1**（全部走主题变量天然满足，抽样核验）。
- HC 主题下所有层级加 1px `--vscode-contrastBorder`，不靠底色。

### 8.4 排版、密度与栅格

- 字体继承 `var(--vscode-font-family)` 与 `--vscode-font-size`，层级用 em/rem 相对缩放；路径/值/diff 用 `--vscode-editor-font-family`。
- **高密度工具界面，不是营销页**：控件行高 22–28px（树行/输入/按钮统一 24px）；间距走 4/8 基线（4/8/12/16/24）；禁止大留白、大字号标题、巨型 Hero 区。
- 三级信息层级：区块标题（11px / 600 / descriptionForeground 大写）/ 正文（13px editor-foreground）/ 辅助说明（11px descriptionForeground）——靠字重字号颜色分层，不堆边框和底色。
- 全局 `box-sizing: border-box`；控件左缘对齐同一栅格；**约 300px 窄侧边栏宽度下布局折叠为单列（grid `minmax()` + 容器查询），无溢出、无横向滚动**。

### 8.5 组件与四态

- 圆角统一 **2–4px**（面板 4、控件 2）；**默认无阴影**；禁止双重边框、内外阴影叠加、渐变按钮。
- 图标统一 **Codicon**（本地打包）：set=`edit`、delete=`trash`、insert=`add`、replace=`replace`（无则 `sync`）、deleteLine=`remove`、警示=`warning`、跳转=`go-to-file`、过滤=`search`、只看命中=`eye`、目录/文件=`folder`/`file`、关闭=`close`、锁定=`lock`、扁平视图=`list-flat`、树视图=`list-tree`、全选=`check-all`、逐个审阅=`steps`。同一语义全站同一图标。
- **四态（每区块必须齐备，示例规范见本节各条，视觉示例见 §8.10 与附录 D 规范 C）**：
  - *加载中*：树/结果用 3–5 行骨架条（`color-mix(in srgb, editor-foreground 12%, transparent)`）；扫描用细进度条 + 数字（12/17），不用全屏遮罩转圈；
  - *空态*：图标 + 一句说明 + 主操作（如「没有匹配文件 → 清除筛选条件」，点击直接改写条件）；
  - *错误态*：`errorForeground` + 首行错误信息 + 可恢复操作（查看错误 / 跳过该文件）；输入校验红框用 `inputValidation-errorBorder` + 悬浮原因；
  - *禁用态*：`disabledForeground` + `cursor:not-allowed` + tooltip 说明启用条件（如「先选择文件范围」「结构化模式下扩展名由格式固定，不可编辑」）。
- 列表/树三态齐全且可区分：hover（`list-hoverBackground`）、选中（`list-activeSelection*` / `inactiveSelection*`）、键盘焦点（`focusBorder` 2px outline）；不使用斑马纹。

### 8.6 交互与可访问性

- 所有可交互元素 `:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1–2px }`；**禁止裸写 `outline: none`**。
- 过渡 **120–200ms ease**，只作用于 color / background / border / opacity；`@media (prefers-reduced-motion: reduce)` 下全部归零。
- 语义化标签 + ARIA：引擎切换 `role=tablist/tab`、树 `role=tree/treeitem`、三态勾选 `role=checkbox + aria-checked="mixed"`、批量操作条 `role=toolbar`、审阅进度 `role=progressbar`；图标按钮必须有 `aria-label`；diff 提供「读屏可读的 −old / +new 文本模式」。
- 快捷键经 `keybinding` contribution + `when` 子句转发（不裸监听）：`↑↓` 移动、`Space` 勾选、`Enter` 预览、`Ctrl+Enter` 应用（带确认）、`Ctrl+F` 聚焦过滤框；逐个审阅键位见 §6.4；Tab 顺序：指令 → 范围树 → 结果树 → 底栏。
- 不滥用 `!important`；不写死 px 高度导致文字截断（用 min-height）。

### 8.7 Webview 工程落地

- **CSP**：`default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-<随机>'`（nonce 每次加载重新生成）。
- 资源全部 `asWebviewUri`；Codicon 字体打进扩展随 `.vsix` 分发（`.vscodeignore` 勿排除）。
- `body.vscode-*` 主题 class 由宿主自动注入，**不要自行改写**；面板状态经 `setState/getState` 持久化，`retainContextWhenHidden: true` 保住扫描中间态。
- UI 框架不限（建议原生或 Preact 控制体积），但样式必须落在 CSS 变量层，**不引入组件库自带主题体系**。

### 8.8 四主题降级策略矩阵

| 场景 | Dark / Light | HC / HC Light |
|---|---|---|
| 层级区分 | 背景微差 + `panel-border` | 全部加 1px `contrastBorder`，不靠底色 |
| diff | 行底色 + `−/+` 前景色 | 行底色弱化，靠 `−/+` 符号与边框 |
| 操作色徽标 | charts-\* / error / warning 前景色 | 保留前景色 + `contrastBorder` 描边徽标 |
| 命中高亮 / 灰显 | 前景色高亮 + `opacity` 灰显 | 高亮改下划线/边框，灰显改显式边框（不能只靠透明度） |
| 焦点 | `focusBorder` 2px | 同左（HC 下 focusBorder 本身高亮），确保可见 |
| hover/选中 | list-hover / activeSelection | 保留 + 边框强化区分 |

### 8.9 易用性细节（好感度关键）

- **旧值分布统计**（结构化）与**命中样本预览**（文本：显示前 3 个命中片段及上下文一行）——防误伤的两大利器。
- 路径输入失焦校验（红波浪线 + 悬浮原因）；`@` 触发结构自动补全（从首个匹配文件采样）。
- sed 简写输入框：粘贴 `s/.../g` 自动展开为表单字段并保留原式在注释里；非法 sed 特性给「为什么不支持 + 怎么改」的提示。
- 每条命中「在编辑器中查看」→ `openTextDocument` + `revealRange`。
- 指令行可整体禁用不删除；应用后自动收起输入区、展开报告摘要。
- 树上「只看有命中的文件」开关：审阅时一键降噪。
- **（v1.3）扩展名不可编辑时给「为什么」**：🔒 tooltip 明说「结构化 JSON 固定为 *.json/*.jsonc，切换目标格式可改变」；文本 `all` 时提示「当前作用于全部文件类型，二进制/非 UTF-8 会自动跳过」。

### 8.10 文件范围区（区块②）界面规范 ★ v1.3 新增，文档内自包含

```
┌─ 区块② 文件范围 ──────────────────────────────────────────────────────┐
│ 目标格式（新建指令默认值）: [ JSON ] [ YAML ] [ Sed / 文本 ]             │
│ ┌ 扩展名策略 ────────────────────────────────────────────────────────┐ │
│ │ 结构化(JSON/YAML):  *.json, *.jsonc   🔒只读  「由目标格式固定」      │ │
│ │ 文本(sed):  (●) 全部类型（不过滤）  ( ) 自定义                        │ │
│ │   自定义 → 扩展名标签输入: [py ×][sh ×][.env ×][Dockerfile ×][+ 添加] │ │
│ │            排除: [*.min.js ×][+ 添加]                                │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│ 过滤: [ conf *.yaml !legacy          ]  [树状|扁平]  命中 17 · 已选 9    │
│       已解析: conf ∧ *.yaml ∧ ¬legacy                                   │
│ 批量: [全选命中][取消命中][反选][仅保留][依次选择][清除筛选][只看适用]    │
│ ┌ 树 / 扁平命中列表 ───────────────────────────────────────────────┐   │
│ │ ▾ config  –   ●6   4/9 已选                                        │   │
│ │   ▾ prod  –   ●6   app.yaml ✓ 3 · values.yaml ✓ 4 · legacy.conf ○   │   │
│ │   ▸ staging ✓ ●8   8/8                                             │   │
│ │ ▸ scripts ✓   ●4   deploy.sh:12 registry…:v1  [sed]  ↗            │   │
│ │ (扁平视图时按相对路径跨目录列出，显示扩展名/适用指令数/变更数徽标) │   │
│ └───────────────────────────────────────────────────────────────────┘   │
│ 右侧: 等效 glob（含扩展名表达式）/ 排除 / 树上手工覆盖清单 / 重置       │
│ 逐个审阅态: 底栏切换为 [← 上一个] 3 / 17 [选中并下一个 →] [跳过]        │
│             [全选剩余] [结束] + 当前文件 diff 片段                      │
└──────────────────────────────────────────────────────────────────────┘
```

**控件行为与状态**：

| 控件 | 结构化模式（JSON/YAML） | 文本 sed 模式 |
|---|---|---|
| 目标格式分段 | 显示当前格式；切换 = 改新建结构化指令的默认 `format` | 选中「Sed / 文本」 |
| 扩展名策略区 | **只读徽标**（🔒 `lock` + 固定扩展名文案），禁用态样式 + tooltip；**不渲染标签输入框** | 单选「全部类型 / 自定义」；自定义时渲染标签输入（可任意添加/删除任意扩展名、点文件、无扩展名文件名）+ 排除项 |
| 过滤快捷片 | 与当前固定格式不兼容的片禁用 + tooltip | 全部可用，点击即填条件 |
| 树/扁平列表 | 只显示固定扩展名候选文件 | `all` 显示全部；`custom` 只显示匹配候选 |
| 等效 glob | 自动带 `**/*.{json,jsonc}` 或 `**/*.{yaml,yml}` | `all` 不加扩展名约束；`custom` 生成 `**/*.{py,sh,…}` |

- **联动**：扩展名策略变化 → 立即刷新候选、树、命中计数、等效 glob，并触发 300ms 防抖重扫（§8.2）；所有状态写入 `SelectionState` / 指令 `fileScope`，不另存 UI 私有状态。
- **只读态可访问性**：🔒 徽标用 `aria-label="扩展名由目标格式固定，不可编辑"`；禁用控件保留 `aria-disabled` 与 tooltip，不得只靠灰显传达。
- **视觉**：全部控件沿用 §8.3 变量；批量操作条用次按钮（`button-secondary*`），「全选命中」「依次选择」可用主按钮但面积受控；计数用 `badge-background/-foreground`；命中高亮用 `notificationsInfoIcon-foreground`；HC 下所有分组加 `contrastBorder` 边框（§8.8）。
- **四态**：加载中（骨架树行）、空命中（图标 + 「清除条件」主操作）、错误（glob 语法错误红框 + 原因）、禁用（未选范围时批量操作与「应用」禁用并说明）——与 §8.5 一致。
- **窄宽度**：≤300px 时右侧等效 glob 折叠为可展开摘要，批量操作条换行（`flex-wrap`），无横向滚动（§8.4）。

## 9. 边界、安全与性能

| 风险 | 对策 |
|---|---|
| 表达式爆炸（`$..*`、`.*`） | 结构化单文件命中 ≤ 500；文本单文件 ≤ 2000；路径深度 ≤ 32；pattern 长度 ≤ 512 |
| 正则回溯灾难 | 启发式检测（嵌套量词、超长 pattern）标 risky；扫描限时（单文件 2s 超时跳过并报告） |
| 二进制/非 UTF-8 文件被文本引擎写坏 | §5.3 前置检查，只跳不写；**`all` / 不加扩展名过滤时同样执行** |
| **`custom` 扩展名条件写错导致误伤** | 标签输入即时校验（非法字符提示）；应用前概览条显示「按扩展名过滤后 N 个文件」；`exclude` 优先；空 `include` 视为全部要给显式提示 |
| **扩展名大小写 / 点文件 / 无扩展名文件漏匹配** | 大小写不敏感；点文件与无扩展名文件按 basename glob 匹配（§6.1）；fixture 覆盖 `.env`、`Dockerfile`、`.YAML` |
| **结构化指令投到错误格式** | `fileScope` 固定只读 + 扫描前 `matchScope` 挑选（§5.4）；禁止内容嗅探（§3.2） |
| **筛选条件/批量操作误改选择集** | 过滤不自动改勾选态；「仅保留命中」二次确认；每次操作即时写 overrides 可撤销（§6.4） |
| 符号链接 / 工作区外文件 | 不跟随出界，跳过并报告（§6.6） |
| JSONPath 求值注入（未来） | 只用无 eval 实现；`jsonpath-plus` 必须 ≥10.3.0 且 `eval:false` |
| YAML billion laughs | `yaml` 默认 `maxAliasCount: 100`，不调高 |
| 大文件卡 UI | >1MB 解析/补丁进 Worker；树与结果虚拟滚动；文本引擎 >5MB 跳过 |
| 扫描与应用之间文件被改 | hash 二次校验，不一致跳过进报告 |
| 只读/权限拒绝 | 逐文件 try/catch，进「失败」分组，不中断批次 |
| 误操作 | 全程预览制 + WorkspaceEdit 单次提交整体撤销 + 删除类二次确认 |

## 10. 测试策略（必须全部落地）

### 10.1 字节级幂等测试（双引擎都要）

```ts
// 结构化：改回去必须逐字节还原
expect(engine.apply(after, reverseOf(instrs))).toBe(before);
// 文本：replace 反向替换（模式可逆时）或对补丁求逆后应用，必须逐字节还原
expect(applyInverse(before, patches)).toBe(before);
// 删除行类不可逆操作：断言「未涉及行的逐行相等」+ 删除行集合精确等于期望行号
```

### 10.2 sed 方言单测矩阵

`s/…/…/g`、标志组合、`$1` 反向引用、`\1` 转换、自定义分隔符 `s|a|b|`、`/pat/d`、CRLF 文件、最后一行无换行、`m` 标志下 `^$`、非法语法报错（未知 flag、`p` 命令、hold space）、二进制跳过、非 UTF-8 跳过、命中截断。

### 10.3 Fixture 矩阵

- JSON：`//` 与 `/* */` 注释、尾逗号、tab、CRLF、超精度大整数、深层嵌套。
- YAML：行尾注释、4 空格缩进、单双引号、block scalar、flow、多文档、锚点+别名+merge、空行密集、中文注释。
- 通用文本（文本引擎）：.py、.md、.env、.conf、.sh；CRLF、LF、BOM、无尾换行、含中文、含 emoji（代理对不拆）、二进制样本（.png 头几字节）、ISO-8859-1 样本。
- **（v1.3）扩展名边界**：`.YAML` / `.JSON`（大小写）、`.env` / `.gitignore`（点文件）、`Dockerfile` / `Makefile` / `LICENSE`（无扩展名）、`a.config.json`（多点）、`*.min.js`（排除项）、`*.lock`。

### 10.4 选择模型单测

glob ↔ overrides 双向换算：文件夹勾选生成等效 glob、取消单个文件、重置、过滤态级联只影响可见项。**扩展名策略与树筛选批量操作的完整单测矩阵见 §10.7**。

### 10.5 集成测试

`@vscode/test-electron`：真实工作区 → 树勾选 + 双引擎指令 → 断言 git diff 仅含目标行；Ctrl+Z 后逐字节还原。**补一例**：混合会话（YAML set + JSON set + sed `custom` + sed `all`）→ 断言每种文件只被其 `fileScope` 命中的指令改动，且不出现跨格式解析失败。

### 10.6 UI 验收清单（发布前逐条实测，未通过项如实标注，不许只声称完成）

- [ ] 切换 Light / Dark / High Contrast / High Contrast Light：无白底、无不可读文字、无错位边框；HC 下所有层级均有显式 1px 边框
- [ ] `grep -E "#[0-9a-fA-F]{3,8}|rgb\(|hsl\(" src/ui/` 无残留（`rgba()`/`color-mix()` 叠加除外；**任何演示/兜底用的硬编码色值不得进入扩展产物，包括从任何原型文件拷贝的代码**）
- [ ] 全站无外部网络请求；Webview CSP 与 asWebviewUri 正确；`.vsix` 内含 Codicon 字体与第三方 LICENSE
- [ ] 所有可交互元素键盘可达且 `:focus-visible` 焦点环可见；Tab 顺序：指令 → 范围 → 结果 → 底栏
- [ ] 正文对比度 ≥ 4.5:1；约 300px 窄宽度（WebviewView 侧边栏形态）下无横向滚动
- [ ] 四态（加载骨架 / 空态 / 错误态 / 禁用态）在指令区、文件树、结果区三处均可达且表现正确；**结构化模式下扩展名控件为可访问的禁用态**
- [ ] `prefers-reduced-motion` 下无动画；过渡仅 color/background/border/opacity 且 120–200ms
- [ ] 现有测试全部通过 + 手动冒烟核心流程：扫描 → 预览 → 应用 → Ctrl+Z 全量还原

### 10.7 扩展名策略与树筛选批量操作单测（★ v1.3 新增，必须全部落地）

**扩展名策略（`extensionPolicy` / `matchScope`）**：
- `fixed/json`：`.json`/`.jsonc`/`.JSON` 命中；`.yaml`/`.py`/无扩展名不命中。
- `fixed/yaml`：`.yaml`/`.yml`/`.YML` 命中；`.json` 不命中。
- `all`：所有文件（含点文件、无扩展名）命中，且仍受 §5.3 二进制/编码/大小跳过。
- `custom include:['py','sh']`：`.py`/`.sh` 命中，`.PY` 命中，`.md` 不命中。
- `custom` 点文件/无扩展名：`.env`、`Dockerfile`、`Makefile` 按 basename 命中；`*.tf*` 通配命中 `app.tfvars`。
- `custom exclude:['min.js','*.lock']`：优先级高于 include，命中即排除；空 `include` = 全部（除 exclude）。
- `candidateExtensions()`：单 JSON 指令 → 固定集合；JSON+YAML → 并集；加入任一 `all` → `'all'`；`custom` 并入指定扩展名；禁用指令不计入并集。
- `scopeToGlob()`：fixed → `**/*.{json,jsonc}`；custom → `**/*.{py,sh}`；all → 无扩展名约束。
- `Instruction.format` 与 `fileScope.mode==='fixed'` 的一致性校验（不一致应报错，不允许静默）。

**树筛选（`treeFilter`）**：
- 子串 `conf` 跨所有目录命中；多条件 `conf *.yaml` = AND；排除 `!legacy` / `-*.min.js`；glob `config/**/prod/*`；大小写不敏感；非法字符转义为字面量；解析回显文案正确。
- 过滤**不改变**已勾选态；扁平视图结果 = 树视图命中集的跨目录扁平化且顺序稳定。

**批量操作与依次选择（§6.4）**：
- 全选命中只作用于 H、不误伤 H 外已选项；取消命中/反选命中/仅保留命中（含二次确认）/清除筛选（勾选态保留）。
- 目录节点「仅勾选本目录命中项」。
- 逐个审阅队列按相对路径稳定排序；「选中并下一个/跳过/上一个/全选剩余/结束」每一步都正确写 overrides 且与 glob 双向同步；筛选变化导致 H 改变时退出审阅并提示。
- **过滤态级联只影响可见项**（沿用 §6.2 原规则）与「批量操作作用集」一致，不出现两者矛盾。

## 11. 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| M1 | `core/`（pathLang + sedDialect + **extensionPolicy + treeFilter** + 三 Adapter + engine + selection + merge）+ 全量单测 | 双引擎幂等测试全绿；**§10.7 矩阵全绿** |
| M2 | 控制器 + 最小 UI（QuickPick 向导） | 端到端能改文件；扩展名固定/自由策略可用 |
| M3 | Webview 完整面板（§8.10 文件范围区 + 树/扁平 + 批量条 + 逐个审阅 + 双引擎指令区 + diff），**对照本文档 §8 自包含规格，无需任何原型文件** | 四主题（Light/Dark/HC/HC Light）走查通过 + §10.6 清单全绿 + 按附录 C 产出交付物 |
| M4 | P1（补全/导入导出/报告/历史/行地址/扩展名别名）+ 打磨 | 发布 0.1.0 |

## 12. 附加建议（增强点）

1. `.structedit.json` 表达式集（v3，含双引擎指令 + `fileScope` + 选择范围 + `treeFilter`），团队共享、评审、复用，可提交进仓库。
2. 编辑器右键「StructEdit: 使用此路径」（结构化）/「以此选区为模式」（文本：把选中文本转义成 pattern 预填）。
3. 智能范围预填：打开面板时按当前活动文件类型预填（.yaml/.json → 所在目录 + 对应固定格式；其他 → 该扩展名全局 + 文本模式）。
4. Dry-run 报告导出 Markdown（审计：谁在何时改了哪些文件的哪些值，含本次扩展名策略与筛选条件）。
5. 导出脚本（P2）：结构化→yq，文本→sed -i，供 CI 复现（导出时把 `fileScope` 翻译成 `--include='*.yaml'` 等参数）。
6. 反向补丁撤销命令 `structedit.undoLast`（跨会话，v2）。
7. 文本引擎「命中预览上下文」支持行内展开（点开看命中行前后 3 行）。
8. 筛选条件与扩展名标签的历史下拉（最近 10 条），团队共享时随表达式集一起带出。
9. 默认关闭遥测，不做网络请求。

## 附录 A：表达式集文件格式（`.structedit.json`，v1.3 / version 3）

```json
{
  "version": 3,
  "name": "镜像升级 + 清理 TODO 2026-11",
  "selection": {
    "include": ["config/**", "scripts/**"],
    "exclude": ["**/legacy/**"],
    "treeFilter": "conf *.yaml !legacy",
    "overrides": { "add": [], "remove": ["file:///…/skip.yaml"] }
  },
  "instructions": [
    { "engine": "structured", "format": "yaml", "fileScope": { "mode": "fixed", "format": "yaml" },
      "kind": "set", "path": "$.spec.template.spec.containers[*].image",
      "value": "registry.acme/payments:v2", "valueType": "string" },
    { "engine": "structured", "format": "json", "fileScope": { "mode": "fixed", "format": "json" },
      "kind": "delete", "path": "$.metadata.annotations.\"deployment.kubernetes.io/revision\"" },
    { "engine": "text", "fileScope": { "mode": "custom", "include": ["env", "sh", "md"], "exclude": ["min.js"] },
      "textOp": "replace", "pattern": "registry\\.acme/payments:v1",
      "replacement": "registry.acme/payments:v2", "flags": "g" },
    { "engine": "text", "fileScope": { "mode": "all" },
      "textOp": "deleteLine", "pattern": "^\\s*#\\s*TODO.*$" }
  ]
}
```

**v3 变更与兼容**：
- 新增 `instructions[].fileScope`（必填）与结构化 `instructions[].format`（必填）；新增 `selection.treeFilter`。
- 读取 v1/v2（`version: 2` 且无 `fileScope`）时按兼容规则补齐：结构化指令按扩展名或显式 `format` 生成 `fixed`，缺失则默认 `fixed/yaml`（并给一次提示）；文本指令默认 `all`。**读入后一律升级为 v3 写出**，避免旧格式继续扩散。
- 校验：`format` 与 `fileScope.mode==='fixed'` 必须一致；`custom.include/exclude` 为字符串数组；`treeFilter.raw` 为字符串。

## 附录 B：命令面板命令清单

| 命令 | 说明 |
|---|---|
| `structedit.openPanel` | 打开批量编辑面板（建议 `Ctrl+Alt+B`） |
| `structedit.useCursorPath` | 编辑器右键：光标路径填入面板（结构化） |
| `structedit.useSelectionAsPattern` | 编辑器右键：选区转义为文本 pattern（文本引擎） |
| `structedit.applyFile` | 直接应用某个 `.structedit.json` |
| `structedit.showReport` | 查看上次执行报告 |
| `structedit.selectAllMatches` | 全选当前筛选命中的文件（§6.4） |
| `structedit.sequentialReview` | 进入依次选择 / 逐个审阅（§6.4） |

## 附录 C：UI 维护交付物（后续任何 UI 改动都要产出，缺一不算完成）

沿用《VS Code 插件 UI 美化铁律》的交付格式（**原文全文见附录 D**）：

1. **现状诊断表**：文件 / 问题 / 违反了 §8.0–§8.8 哪一条 / 严重度（先诊断后动手；若目标必须改组件结构或数据流，先说明并等待确认，不得擅自改动）。
2. **改动清单表**：文件 / 改动摘要 / 对应规范条目，附关键 diff；保持最小 diff，不重写组件。
3. **主题适配说明**：列出新增/替换的变量映射，以及 Dark / Light / HC / HC Light 四套主题下的降级策略。
4. **自检结果**：逐条勾选 §10.6 验收清单，未通过项如实标注，不允许只声称完成。

> 从零实现时：把「现状诊断表」替换为「按 §8 规则落地的对照说明」，其余三项照常产出。

## 附录 D：《VS Code 插件 UI 美化 · Agent 提示词》原文（权威依据，整段收录）

> **使用说明**：以下为需求方提供的原始提示词**全文原样收录**（可直接整段复制给 UI 实现子 Agent）。填充占位符如下：
> - **代码位置**：本仓库 `src/ui/`（Webview 前端）与 `src/controllers/`（面板生命周期）；
> - **UI 载体**：**Webview 面板**（编辑器 Tab 中的 Webview；未来可能增加 WebviewView 侧边栏形态）——因此第 3 条铁律中关于 CSP / asWebviewUri 的部分**保留**；
> - **技术栈**：建议原生 HTML/CSS/JS 或 Preact（不引入组件库主题体系，见 §8.7）；
> - **现状痛点**：见 §8.0 五条铁律与 §8.3–§8.8；从零实现阶段无历史债务，按规则直接落地即可；
> - **品牌约束**：无品牌色，全部走官方 `--vscode-*` 主题变量（§8.0 铁律 2）。
>
> 本文档 §8 是该原文的规则化落地、附录 C 是其交付物、§10.6 是其验收清单；**若原文与 §8 表述有差异，以本原文为准并向 §8 回填修订**。「第一步：先诊断 / 最小 diff / 改动清单」适用于**对已有 UI 的后续维护**，从零实现时按附录 C 的替代说明执行。
>
> ```text
> VS Code 插件 UI 美化 · Agent 提示词用法：把下方代码块整段复制到目标 Agent；把【待优化的插件】里的尖括号占位填好（或直接让 Agent 自己读仓库）。若你的插件不含 Webview（纯 TreeView / 状态栏 / contributes 视图），可删除第 3 条铁律中关于 CSP / asWebviewUri 的部分，其余条款通用。建议同时把仓库访问权或 UI 相关文件一起给到该 Agent。
>
> 你是一名资深 VS Code 扩展 UI/UX 设计与前端实现专家，熟悉 VS Code 主题变量体系、Webview 机制、Codicon 图标以及原生控件密度。现在请对下面这个插件的界面做一次「视觉重构」：目标是更专业、更克制、与 VS Code 原生界面浑然一体，并完整适配所有官方主题。
>
> 【待优化的插件】
> - 代码位置：<粘贴路径 / 仓库 / 文件树>
> - UI 载体：<Webview / WebviewView / TreeView / 状态栏 / Editor Decoration / 其他；不确定就自行识别>
> - 技术栈：<原生 HTML/CSS/JS、React、Vue、Svelte…>
> - 现状痛点：<可选>
> - 品牌约束：<可选，如必须保留的 Logo / 主色>
>
> 【第一步：先诊断，别急着改】
> 1. 通读全部 UI 相关文件，识别 UI 载体、样式入口、主题注入方式。
> 2. 输出「现状诊断表」：文件 / 问题 / 违反了下面哪条规范 / 严重度。
> 3. 若某个视觉目标必须改动组件结构或数据流才能达成，先说明并等待确认，不要擅自改动。
>
> 【铁律：违反任意一条即视为失败】
> 1. 主题适配是第一优先级。Webview 用 body.vscode-light / body.vscode-dark / body.vscode-high-contrast / vscode-high-contrast-light 做分支；原生视图用 Theme Color 与 Theme Icon。必须同时通过 Light、Dark、High Contrast（含 HC Light）检验。
> 2. 禁止硬编码颜色。除 rgba()/color-mix() 做透明度叠加、以及单一品牌强调色外，样式中不允许出现 #hex / rgb() / hsl() 字面量；尤其禁止 #fff 白底、#000 黑字、写死灰阶。
> 3. 不引入任何外部网络资源（CDN 字体、图标库、图片）。Webview 资源必须走 asWebviewUri，并同步检查 CSP 的 font-src / img-src / style-src 允许 ${webview.cspSource}。
> 4. 只改视觉层：CSS / 样式常量 / 主题映射 / 图标类名。不改业务逻辑、数据结构、API、事件与组件树；保持最小 diff，不要重写组件。
> 5. 不要发明不存在的 VS Code 变量名。只用官方文档中确认存在的 --vscode-* 变量；不确定时先查证，或改用「已确认变量 + color-mix 叠加」。
>
> 【规范 A · 色彩与语义映射】
> - 主文本 --vscode-editor-foreground；次要说明 --vscode-descriptionForeground；禁用 --vscode-disabledForeground。
> - 层级背景：--vscode-editor-background → --vscode-sideBar-background → --vscode-editorWidget-background；卡片/浮层用后者，hover 用 --vscode-list-hoverBackground。
> - 主按钮 --vscode-button-background / -foreground / -hoverBackground；次按钮 --vscode-button-secondary*；边框 --vscode-button-border。
> - 输入框 --vscode-input-background / -foreground / -border / -placeholderForeground；校验态 --vscode-inputValidation-error|warning|infoBorder。
> - 状态色只用语义变量：--vscode-errorForeground、--vscode-editorWarning-foreground、--vscode-notificationsInfoIcon-foreground、--vscode-editorError-foreground；不要自定义红黄绿。
> - 焦点 --vscode-focusBorder；分隔线 --vscode-panel-border / --vscode-widget-border；链接 --vscode-textLink-foreground；徽标 --vscode-badge-background / -foreground；滚动条 --vscode-scrollbarSlider-*；代码块 --vscode-textCodeBlock-background。
> - 品牌强调色最多 1 个，仅用于点缀（面积 <5%，如激活指示条、图标），必须给出 Dark 与 High Contrast 下的降级（HC 下退回 --vscode-focusBorder）。禁止大面积高饱和色块与渐变。
> - 文字对比度 ≥ WCAG AA 4.5:1；高对比度主题下不能只靠背景色区分层级，必须有显式 1px 边框。
>
> 【规范 B · 排版、密度与栅格】
> - 字体继承 var(--vscode-font-family)，字号 var(--vscode-font-size)，其余用 em/rem 相对缩放；代码用 var(--vscode-editor-font-family)。
> - 这是高密度工具界面，不是营销落地页：控件行高 22–28px，间距走 4/8 基线（4/8/12/16/24），禁止大留白、大字号标题、巨型 Hero 区。
> - 建立 3 级信息层级：标题 / 正文 / 辅助说明，用字重、字号、颜色三级区分，不要靠堆边框和底色制造层级。
> - 全局 box-sizing: border-box；所有控件左边缘对齐同一栅格；窄侧边栏（约 300px）下不溢出、无横向滚动。
>
> 【规范 C · 组件与状态】
> - 圆角统一 2–4px（贴近原生），阴影最多一层且克制；禁止双重边框、内外阴影叠加、渐变按钮。
> - 图标统一用 Codicon（@vscode/codicons），尺寸与 --vscode-font-size 协调；同一语义全站用同一个图标。
> - 补齐四类常被忽略的状态：加载中（骨架/进度）、空状态（图标 + 一句说明 + 主操作）、错误态（语义色 + 可恢复操作）、禁用态。
> - 列表/表格：hover、选中（--vscode-list-activeSelection*）、键盘焦点三态齐全且彼此可区分；克制使用斑马纹。
>
> 【规范 D · 交互与可访问性】
> - 所有可交互元素有 :focus-visible 轮廓（--vscode-focusBorder，2px，outline-offset 1–2px），禁止裸用 outline: none。
> - 过渡 120–200ms ease，只作用于 color / background / border / opacity；尊重 prefers-reduced-motion。
> - 语义化标签 + 必要 ARIA，图标按钮必须有可访问名称；不滥用 !important，不写死 px 高度导致文字截断。
>
> 【明令禁止】
> 硬编码颜色；外部字体/图标/CDN；用 !important 覆盖主题；在高对比度下用背景色代替边框区分层级；把 VS Code 面板做成圆角卡片式 Web 落地页；为美观牺牲功能或改动数据结构。
>
> 【交付物】
> 1. 现状诊断表（文件 / 问题 / 违反条目 / 严重度）。
> 2. 改动清单表（文件 / 改动摘要 / 对应规范条目），附关键 diff。
> 3. 主题适配说明：列出新增/替换的变量映射，以及四套主题下的降级策略。
> 4. 自检结果：逐条勾选下方验收项，未通过项如实标注，不要只声称完成。
>
> 【验收清单（逐条实际验证）】
> - [ ] 切换 Light / Dark / High Contrast / High Contrast Light，无白底、无不可读文字、无错位边框
> - [ ] 样式文件中 grep #hex / rgb( / hsl( 无残留（透明度叠加除外）
> - [ ] 全站无外部网络请求，Webview 的 CSP 与 asWebviewUri 正确
> - [ ] 所有可交互元素键盘可达且焦点可见
> - [ ] 对比度 ≥ 4.5:1，约 300px 窄宽度下无横向滚动
> - [ ] 现有测试通过 / 手动冒烟核心流程
> ```

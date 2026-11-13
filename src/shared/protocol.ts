/**
 * Webview ↔ Extension Host 消息协议（并行开发的唯一接口基准）
 *
 * 【文件所有权】本文件由集成方维护；UI 层（src/ui/**）与宿主层
 * （src/controllers/**、src/extension.ts）只消费，不得修改。
 *
 * 【Webview 资源契约】
 * - 宿主读取 <extensionUri>/dist/ui/panel.html，替换占位符后 setHtml。
 * - 占位符（HTML 内以 {{NAME}} 出现，宿主负责字符串替换）：
 *     {{TITLE}}             面板标题
 *     {{NONCE}}             每次加载重新生成的随机 nonce
 *     {{CSP_SOURCE}}        webview.cspSource
 *     {{CSS_URI}}           asWebviewUri(dist/ui/panel.css)
 *     {{JS_URI}}            asWebviewUri(dist/ui/panel.js)
 *     {{CODICON_CSS_URI}}   asWebviewUri(dist/ui/codicon.css)
 * - CSP（宿主生成，§8.7）：
 *     default-src 'none'; style-src ${cspSource} 'unsafe-inline';
 *     font-src ${cspSource}; img-src ${cspSource} data:;
 *     script-src 'nonce-${nonce}'
 * - panel.js 用 acquireVsCodeApi()，监听 window 'message' 收 HostToWebview，
 *   用 api.postMessage() 发 WebviewToHost；首屏状态只由 init 消息下发，不内联到 HTML。
 * - 面板标题一律用 displayName「Batch Replace for JSON & YAML」，不得出现内部代号。
 *
 * 【资源打包】esbuild.mjs 把 src/ui/** 复制到 dist/ui/**；.vscodeignore 保留 dist/，
 * 因此字体与样式随 .vsix 分发。UI 层只写 src/ui/**，不要写 dist/。
 *
 * 【零外部网络】Webview 侧不得发起任何网络请求（§3.3 / §8.0 铁律 3）。
 */

import type { Instruction, TreeFilter, FileScope } from '../core/types.ts';

export type Phase = 'input' | 'scanning' | 'results' | 'applying' | 'report';

export interface Counts {
  changes: number;
  files: number;
  warnings: number;
  parseErrors: number;
  conflicts: number;
  scanned: number;
  total: number;
}

export interface TreeNode {
  path: string; // 相对路径
  name: string;
  kind: 'dir' | 'file';
  children?: TreeNode[];
  checked: boolean | 'mixed';
  applicable: boolean; // 是否属于 §6.1 候选扩展名
  changeCount: number;
  ext: string;
  hitRanges?: Array<[number, number]>; // 命中高亮字符区间
  reason?: string; // 灰显/禁用原因
}

export interface FlatItem {
  uri: string;
  path: string;
  ext: string;
  applicable: boolean;
  instructionCount: number;
  changeCount: number;
  checked: boolean;
  hitRanges?: Array<[number, number]>;
}

export interface DiffLine {
  kind: 'context' | 'remove' | 'add';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface FileDiff {
  uri: string;
  path: string;
  lines: DiffLine[];
}

/** SelectionState 的可序列化形态（overrides 用数组而非 Set） */
export interface SerializedSelection {
  baseInclude: string[];
  baseExclude: string[];
  treeFilter: TreeFilter;
  overrides: { add: string[]; remove: string[] };
}

/** 双击文件行的源文件预览载荷（宿主读盘后回发，含大小截断保护） */
export interface FileContentPayload {
  uri: string;
  path: string;
  ext: string;
  text: string;
  truncated: boolean;
  error?: string;
}

export interface ReviewItem {
  uri: string;
  path: string;
  ext: string;
  instructionCount: number;
  changeCount: number;
  diff?: FileDiff;
}

export interface ReviewPayload {
  active: boolean;
  index: number; // 0-based
  total: number;
  item?: ReviewItem;
  message?: string;
}

export interface ReportPayload {
  appliedAt: string;
  changedFiles: number;
  changes: number;
  skipped: Array<{ uri: string; reason: string }>;
  conflicts: Array<{ uri: string; instructionIds: string[] }>;
  details: Array<{ uri: string; path: string; changeCount: number }>;
}

export interface InitPayload {
  title: string;
  expressionSetVersion: 3;
  instructions: Instruction[];
  selection: SerializedSelection;
  filter: TreeFilter;
  candidateExtensions: string[] | 'all';
  equivalentGlob: string[];
  tree: TreeNode[];
  flat: FlatItem[];
  counts: Counts;
  phase: Phase;
  /** 扫描根目录（null/缺省 = VS Code 打开的工作区；绝对路径 = 用户选的其它目录）。 */
  scopeRoot?: string | null;
}

export interface TreePayload {
  tree: TreeNode[];
  flat: FlatItem[];
  counts: Counts;
  candidateExtensions: string[] | 'all';
  equivalentGlob: string[];
}

export type HostToWebview =
  | { type: 'init'; payload: InitPayload }
  | { type: 'tree'; payload: TreePayload }
  | { type: 'state'; payload: { phase: Phase; counts: Counts; message?: string; scopeRoot?: string | null } }
  | { type: 'preview'; payload: { diffs: FileDiff[] } }
  | { type: 'review'; payload: ReviewPayload }
  | { type: 'report'; payload: ReportPayload }
  | { type: 'error'; payload: { message: string; detail?: string } }
  | { type: 'fileContent'; payload: FileContentPayload }
  /** 一键回退：上次应用前快照是否可用（宿主 → 前端，控制底栏按钮）。 */
  | { type: 'undoState'; payload: { available: boolean; files: number } };

export type BatchOp =
  | 'selectAll'
  | 'deselectAll'
  | 'invert'
  | 'keepOnly'
  | 'clearFilter'
  | 'onlyApplicable'
  | 'showAll'
  | 'selectDirHits'
  | 'deselectDirHits';

export type ReviewAction =
  | 'start'
  | 'selectNext'
  | 'skip'
  | 'prev'
  | 'selectRest'
  | 'end';

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'setInstructions'; instructions: Instruction[] }
  | { type: 'setFilter'; raw: string; view: 'tree' | 'flat' }
  | { type: 'setScope'; instructionId: string; scope: FileScope }
  | { type: 'select'; uri: string; checked: boolean }
  | { type: 'selectFolder'; path: string; checked: boolean; visibleUris: string[] }
  | { type: 'batch'; op: BatchOp; hits: string[]; dir?: string }
  | { type: 'review'; action: ReviewAction; uri?: string }
  | { type: 'setGlob'; include: string[]; exclude: string[] }
  | { type: 'resetToGlob' }
  /** 弹出目录选择框（showOpenDialog），选定后宿主以该目录为扫描根重新扫描。 */
  | { type: 'pickDirectory' }
  /** 放弃自选目录，恢复以 VS Code 打开的工作区根目录为扫描根。 */
  | { type: 'resetScopeRoot' }
  | { type: 'scan' }
  | { type: 'cancelScan' }
  | { type: 'previewAll' }
  // 应用即保存（0.1.4 起不再有确认环节）；diff 预览在第 ③ 步给出，误改可一键回退
  | { type: 'apply'; uris: string[] }
  /** 一键回退：把上次应用过的文件整体还原为应用前原文并立即保存。 */
  | { type: 'undoLast' }
  | { type: 'openFile'; uri: string; line?: number }
  | { type: 'previewFile'; uri: string; path: string }
  | { type: 'importExpressionSet' }
  | { type: 'exportExpressionSet'; data: unknown }
  | { type: 'exportReport' }
  | { type: 'showReport' }
  | { type: 'help' };

/**
 * 宿主层内部类型（不进入消息协议，也不 import vscode）。
 * 仅描述控制器之间流转的数据结构，供 controllers/*.ts 复用。
 */

import type {
  Instruction, MinimalPatch, SelectionState, TreeFilter,
} from '../core/types.ts';
import type {
  Counts, FileDiff, FlatItem, Phase, ReportPayload, TreeNode,
} from '../shared/protocol.ts';

/** 面板显示名（§0.3）：UI 文案与面板标题一律用 displayName 全称。 */
export const DISPLAY_NAME = 'Batch Replace for JSON & YAML';

/** 表达式集版本（附录 A v3）。 */
export const EXPRESSION_SET_VERSION = 3 as const;

/** 运行时配置（package.json contributes.configuration）。 */
export interface HostConfig {
  maxMatches: number;
  maxFileSizeMB: number;
  defaultExclude: string[];
}

/** 一次 workspace.findFiles 建立的工作区文件全集条目（不含内容）。 */
export interface FileEntry {
  /** vscode.Uri.toString()，用于 openFile / apply / 勾选消息回传。 */
  uri: string;
  /** 工作区相对路径，树/扁平/筛选/glob 都以此为准。 */
  relPath: string;
  /** basename。 */
  name: string;
  /** 小写扩展名。 */
  ext: string;
}

/** 某文件在一次扫描中的全部派生数据。 */
export interface FileRecord {
  uri: string;
  relPath: string;
  name: string;
  ext: string;
  applicable: boolean;
  instructionCount: number;
  changeCount: number;
  checked: boolean;
  hitRanges: Array<[number, number]>;
  reason?: string;
  hash: string;
  patches: MinimalPatch[];
  parseErrors: string[];
  conflictIds: string[];
  skippedReason?: string;
  scanned: boolean;
}

export interface SkipItem { uri: string; reason: string; }
export interface ConflictItem { uri: string; instructionIds: string[]; }

/** 文本缓存：避免每次防抖重扫都重新读盘（apply 前仍会重读做 hash 校验）。 */
export interface TextCacheEntry { text: string; hash: string; }

/** 宿主全部可变状态（状态机 §8.2 的唯一持有者）。 */
export interface HostState {
  instructions: Instruction[];
  selection: SelectionState;
  filter: TreeFilter;
  phase: Phase;
  counts: Counts;
  tree: TreeNode[];
  flat: FlatItem[];
  records: Map<string, FileRecord>;
  entries: FileEntry[];
  allRelPaths: string[];
  uriToRel: Map<string, string>;
  relToUri: Map<string, string>;
  candidateExtensions: string[] | 'all';
  equivalentGlob: string[];
  diffs: FileDiff[];
  review: { active: boolean; index: number; queue: string[] };
  lastReport: ReportPayload | null;
  scanSkipped: SkipItem[];
  scanConflicts: ConflictItem[];
}

/** 表达式集规范形态（附录 A，version 3）。 */
export interface ExpressionSetV3 {
  version: 3;
  name: string;
  selection: {
    include: string[];
    exclude: string[];
    treeFilter: string;
    overrides: { add: string[]; remove: string[] };
  };
  instructions: Instruction[];
}

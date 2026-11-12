// 纯 TS 核心类型层：禁止 import 'vscode'（§4.2 / §4.4）
// 函数实现见同目录各模块（M1）：extensionPolicy.ts / treeFilter.ts /
// pathLang.ts / sedDialect.ts / 三 Adapter / engine.ts / selection.ts / merge.ts

export type Seg = string | number;
export type Engine = 'structured' | 'text';

/** 结构化操作 */
export type StructOp = 'set' | 'delete' | 'insert';
/** 文本操作 */
export type TextOp = 'replace' | 'deleteLine';

export type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

/** v1.3：扩展名适用范围，每条指令一个，执行时的唯一依据（§6.1） */
export type FileScope =
  | { mode: 'fixed'; format: 'json' | 'yaml' } // 结构化：扩展名由格式固定，UI 只读
  | { mode: 'all' } // 文本：不加扩展名过滤（默认，全部文件类型）
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

  /** 每条指令适用哪些文件（按扩展名/文件名），引擎自动初始化，见 §6.1 */
  fileScope: FileScope;

  // engine === 'structured'
  format?: 'json' | 'yaml'; // 目标格式；必须与 fileScope.mode === 'fixed' 一致
  kind?: StructOp;
  path?: string; // 统一路径语法
  value?: string; // UI 原始输入
  valueType?: ValueType; // 缺省 = 沿用旧值类型
  scope?: 'all' | 'first';
  createPath?: boolean; // set 时父路径不存在是否创建（默认 false）

  // engine === 'text'
  textOp?: TextOp;
  pattern?: string; // JS RegExp 源文本
  flags?: string; // 'g' | 'i' | 'gi' | 'm' …（无 g 时仅首个命中）
  replacement?: string; // 支持 $1..$9、$&、$`、$'
  lineRange?: { from?: number; to?: number }; // P1：行地址限定（1-based，可省略一端）
}

export interface Match {
  instructionId: string;
  engine: Engine;
  segs?: Seg[]; // structured：规范化绝对路径
  range: { start: number; end: number }; // 原文 offset，仅覆盖命中区间
  oldValue: unknown;
  oldType?: ValueType;
  line: number; // 1-based，UI 展示与跳转用
  /** 结构化：路径链上有锚点/别名/merge；文本：正则回溯风险等 */
  risky?: 'anchor' | 'alias' | 'merge' | 'multiDoc' | 'catastrophic';
}

export interface MinimalPatch {
  match: Match;
  start: number;
  end: number; // 替换区间 [start, end)
  newText: string; // '' 即删除
  note?: string;
}

export interface FileChangePlan {
  uri: string;
  format: 'json' | 'yaml' | 'text';
  parseErrors?: string[]; // 非空 → 整文件跳过进报告
  patches: MinimalPatch[]; // 已按 start 倒序
}

/** §6.3 树筛选条件 */
export interface TreeFilter {
  raw: string; // 用户原始输入，如 "conf *.yaml !legacy"
  include: string[]; // 解析后的正向条件
  exclude: string[]; // 解析后的排除条件
  view: 'tree' | 'flat'; // 目录树 / 跨目录扁平命中列表
}

/** §6.2 选择模型（canonical） */
export interface SelectionState {
  baseInclude: string[];
  baseExclude: string[];
  treeFilter: TreeFilter; // 仅影响显示与批量操作作用集，不改变已勾选态
  overrides: {
    add: Set<string>; // glob 未选中但树上勾选
    remove: Set<string>; // glob 选中但树上取消
  };
}

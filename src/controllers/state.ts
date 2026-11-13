/** 宿主状态初始化、序列化与表达式集应用（纯逻辑，不触碰 vscode）。 */

import { createSelection, parseTreeFilter, scopeToGlob, toGlobSummary } from '../core/index.ts';
import type { Instruction, SelectionState } from '../core/types.ts';
import type { InitPayload, SerializedSelection, TreePayload } from '../shared/protocol.ts';
import {
  DISPLAY_NAME, EXPRESSION_SET_VERSION,
} from './types.ts';
import type { ExpressionSetV3, HostState } from './types.ts';

export function zeroCounts(): HostState['counts'] {
  return { changes: 0, files: 0, warnings: 0, parseErrors: 0, conflicts: 0, scanned: 0, total: 0 };
}

export function createInitialState(): HostState {
  // createSelection() 默认 baseInclude = ['**/*']，baseExclude = []（§6.2）。
  const selection = createSelection();
  const filter = parseTreeFilter('', 'tree');
  selection.treeFilter = filter;
  return {
    instructions: [],
    selection,
    filter,
    phase: 'input',
    counts: zeroCounts(),
    tree: [],
    flat: [],
    records: new Map(),
    entries: [],
    allRelPaths: [],
    uriToRel: new Map(),
    relToUri: new Map(),
    candidateExtensions: [],
    equivalentGlob: [],
    diffs: [],
    review: { active: false, index: 0, queue: [] },
    lastReport: null,
    scanSkipped: [],
    scanConflicts: [],
    listTruncated: false,
    scopeRoot: null,
  };
}

/** SelectionState（含 Set）→ 可序列化形态（overrides 用数组）。 */
export function serializeSelection(sel: SelectionState): SerializedSelection {
  return {
    baseInclude: [...sel.baseInclude],
    baseExclude: [...sel.baseExclude],
    treeFilter: sel.treeFilter,
    overrides: {
      add: [...sel.overrides.add],
      remove: [...sel.overrides.remove],
    },
  };
}

/**
 * 第 1 层只拉取「当前启用指令可能适用」的文件，避免在超大仓库里遍历全部文件。
 * 返回 VS Code findFiles 的 include glob；没有任何可用指令时返回空串（调用方应跳过扫描）。
 *
 * 纯逻辑（不接触 vscode），便于单测覆盖收窄规则。
 */
export function searchIncludeGlob(instructions: Instruction[]): string {
  const enabled = instructions.filter((i) => i.enabled);
  if (!enabled.length) return '';
  const scopes = enabled.map((i) => i.fileScope);
  // all / 空 include 的 custom 都表示「全部文件类型」，无法再收窄。
  if (scopes.some((s) => s.mode === 'all')) return '**/*';
  if (scopes.some((s) => s.mode === 'custom' && (s.include?.length ?? 0) === 0)) return '**/*';

  const globs = new Set<string>();
  const exts = new Set<string>();
  const addNamed = (entry: string): void => {
    const e = entry.trim();
    if (!e) return;
    if (/[*?/]/.test(e)) globs.add(e.startsWith('**/') ? e : `**/${e}`);
    else if (e.includes('.')) globs.add(`**/${e}`);
    else {
      // 无点条目既可能是扩展名（py），也可能是无扩展名文件名（Dockerfile）：两种都收。
      exts.add(e.replace(/^\./, ''));
      globs.add(`**/${e}`);
    }
  };

  for (const scope of scopes) {
    if (scope.mode === 'fixed') {
      globs.add(scopeToGlob(scope)[0]);
    } else if (scope.mode === 'custom') {
      for (const e of scope.include ?? []) addNamed(e);
    }
  }
  if (exts.size) globs.add(`**/*.{${[...exts].join(',')}}`);
  if (!globs.size) return '**/*';
  const list = [...globs];
  return list.length === 1 ? list[0] : `{${list.join(',')}}`;
}

/**
 * 等效 glob 摘要（§6.1 / §6.2）：baseInclude + 排除项 + 启用指令的 fileScope
 * + 树上勾选生成的 folder/** 摘要。overrides 存的是相对路径，先换算再展示。
 */
export function buildEquivalentGlob(state: HostState): string[] {
  const globs = new Set<string>(state.selection.baseInclude);
  for (const g of state.selection.baseExclude) globs.add(`!${g}`);
  for (const ins of state.instructions) {
    if (!ins.enabled) continue;
    for (const g of scopeToGlob(ins.fileScope)) globs.add(g);
  }
  const addedRelPaths = [...state.selection.overrides.add].map(
    (u) => state.uriToRel.get(u) ?? u,
  );
  for (const g of toGlobSummary(addedRelPaths)) globs.add(g);
  return [...globs];
}

export function toInitPayload(state: HostState): InitPayload {
  return {
    title: DISPLAY_NAME,
    expressionSetVersion: EXPRESSION_SET_VERSION,
    instructions: state.instructions,
    selection: serializeSelection(state.selection),
    filter: state.filter,
    candidateExtensions: state.candidateExtensions,
    equivalentGlob: state.equivalentGlob,
    tree: state.tree,
    flat: state.flat,
    counts: state.counts,
    phase: state.phase,
    scopeRoot: state.scopeRoot,
  };
}

export function toTreePayload(state: HostState): TreePayload {
  return {
    tree: state.tree,
    flat: state.flat,
    counts: state.counts,
    candidateExtensions: state.candidateExtensions,
    equivalentGlob: state.equivalentGlob,
  };
}

/** 把（已归一化为 v3 的）表达式集写入宿主状态，随后由控制器触发重扫。 */
export function applyExpressionSet(state: HostState, set: ExpressionSetV3): void {
  state.instructions = set.instructions.map((i) => ({ ...i }));
  const view = state.filter.view;
  const sel = createSelection(set.selection.include, set.selection.exclude, set.selection.treeFilter);
  sel.overrides.add = new Set(set.selection.overrides.add);
  sel.overrides.remove = new Set(set.selection.overrides.remove);
  state.selection = sel;
  state.filter = parseTreeFilter(set.selection.treeFilter, view);
  state.selection.treeFilter = state.filter;
}

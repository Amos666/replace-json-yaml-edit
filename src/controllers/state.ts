/** 宿主状态初始化、序列化与表达式集应用（纯逻辑，不触碰 vscode）。 */

import { createSelection, parseTreeFilter, scopeToGlob, toGlobSummary } from '../core/index.ts';
import type { SelectionState } from '../core/types.ts';
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

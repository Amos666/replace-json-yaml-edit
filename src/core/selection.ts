import type { SelectionState } from './types.ts';
import { globMatch } from './extensionPolicy.ts';
import { parseTreeFilter } from './treeFilter.ts';

export function createSelection(
  baseInclude: string[] = ['**/*'],
  baseExclude: string[] = [],
  filterRaw = '',
): SelectionState {
  return {
    baseInclude,
    baseExclude,
    treeFilter: parseTreeFilter(filterRaw),
    overrides: { add: new Set<string>(), remove: new Set<string>() },
  };
}

function matchAny(value: string, globs: string[]): boolean {
  return globs.some(g => globMatch(value, g));
}

/** §6.2 有效文件集 = findFiles(baseInclude, baseExclude) ∪ add − remove */
export function effectiveFiles(all: string[], state: SelectionState): string[] {
  const base = new Set(
    all.filter(f => matchAny(f, state.baseInclude) && !matchAny(f, state.baseExclude)),
  );
  for (const uri of state.overrides.add) base.add(uri);
  for (const uri of state.overrides.remove) base.delete(uri);
  return [...base];
}

export function isSelected(uri: string, state: SelectionState): boolean {
  if (state.overrides.add.has(uri)) return true;
  if (state.overrides.remove.has(uri)) return false;
  return matchAny(uri, state.baseInclude) && !matchAny(uri, state.baseExclude);
}

export function setSelected(uri: string, checked: boolean, state: SelectionState): void {
  if (checked) {
    state.overrides.add.add(uri);
    state.overrides.remove.delete(uri);
  } else {
    state.overrides.remove.add(uri);
    state.overrides.add.delete(uri);
  }
}

export function clearOverrides(state: SelectionState): void {
  state.overrides.add.clear();
  state.overrides.remove.clear();
}

export type BatchOp = 'selectAll' | 'deselectAll' | 'invert' | 'keepOnly';

/** §6.4 批量操作只作用于命中集 H，不改变 H 之外已勾选项 */
export function applyBatch(
  state: SelectionState,
  hits: string[],
  all: string[],
  op: BatchOp,
): SelectionState {
  const hitSet = new Set(hits);
  if (op === 'keepOnly') {
    for (const uri of all) {
      if (!hitSet.has(uri)) setSelected(uri, false, state);
    }
    for (const uri of hits) setSelected(uri, true, state);
    return state;
  }
  for (const uri of hits) {
    const next =
      op === 'selectAll' ? true : op === 'deselectAll' ? false : !isSelected(uri, state);
    setSelected(uri, next, state);
  }
  return state;
}

/** §6.4 逐个审阅队列：按相对路径稳定排序 */
export function reviewQueue(hits: string[]): string[] {
  return [...hits].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export type ReviewAction = 'selectNext' | 'skip' | 'prev' | 'selectRest' | 'end';

export interface ReviewStep {
  state: SelectionState;
  index: number;
  active: boolean;
}

/** 每一步都即时写 overrides，与 glob 双向同步 */
export function reviewStep(
  state: SelectionState,
  queue: string[],
  index: number,
  action: ReviewAction,
): ReviewStep {
  if (action === 'end' || queue.length === 0) {
    return { state, index, active: false };
  }
  if (action === 'prev') {
    return { state, index: Math.max(0, index - 1), active: true };
  }
  if (action === 'selectRest') {
    for (let i = index; i < queue.length; i += 1) setSelected(queue[i], true, state);
    return { state, index: queue.length, active: false };
  }
  const uri = queue[Math.min(index, queue.length - 1)];
  setSelected(uri, action === 'selectNext', state);
  const next = index + 1;
  return { state, index: next, active: next < queue.length };
}

/** §6.2 文件夹勾选生成等效 glob（folder/**） */
export function toGlobSummary(uris: string[]): string[] {
  const dirs = new Set<string>();
  const files: string[] = [];
  for (const uri of uris) {
    const slash = uri.lastIndexOf('/');
    if (slash > 0) dirs.add(`${uri.slice(0, slash)}/**`);
    else files.push(uri);
  }
  return [...dirs, ...files];
}

export function resetToGlob(
  state: SelectionState,
  include: string[],
  exclude: string[],
): SelectionState {
  state.baseInclude = include;
  state.baseExclude = exclude;
  clearOverrides(state);
  return state;
}

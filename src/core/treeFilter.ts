import type { TreeFilter } from './types.ts';
import { extOf, globMatch } from './extensionPolicy.ts';

/** §6.3 空格分隔 AND；!x / -x 为排除；非法字符转义为字面量，不抛异常 */
export function parseTreeFilter(raw: string, view: 'tree' | 'flat' = 'tree'): TreeFilter {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const include: string[] = [];
  const exclude: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('!') || token.startsWith('-')) exclude.push(token.slice(1));
    else include.push(token);
  }
  return { raw, include, exclude, view };
}

function matchesCondition(relPath: string, name: string, condition: string): boolean {
  const c = condition.toLowerCase();
  if (c.startsWith('ext:')) {
    const exts = c.slice(4).split(',').map(s => s.trim()).filter(Boolean);
    return exts.includes(extOf(name));
  }
  if (c.includes('*') || c.includes('?') || c.includes('/')) {
    return globMatch(relPath, c) || globMatch(name, c);
  }
  return relPath.includes(c);
}

/** 对全部目录的相对路径求值；过滤不改变已勾选态 */
export function matchTreeFilter(fileRelPath: string, f: TreeFilter): boolean {
  const path = fileRelPath.toLowerCase();
  const name = path.split('/').pop() ?? path;
  for (const e of f.exclude) {
    if (matchesCondition(path, name, e)) return false;
  }
  for (const c of f.include) {
    if (!matchesCondition(path, name, c)) return false;
  }
  return true;
}

/** §6.3 可读回显：「conf ∧ *.yaml ∧ ¬legacy」 */
export function describeTreeFilter(f: TreeFilter): string {
  return [...f.include, ...f.exclude.map(c => `¬${c}`)].join(' ∧ ');
}

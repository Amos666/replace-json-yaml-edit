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

/**
 * 同义扩展名（筛选是「大概范围」，不应因 .yaml/.yml、.json/.jsonc 之差漏文件）。
 * 反馈 bug2：选 YAML 格式后 .yml 文件用 `*.yaml` 筛不出来。
 */
const EXT_ALIAS: Record<string, string[]> = {
  yaml: ['yaml', 'yml'],
  yml: ['yaml', 'yml'],
  json: ['json', 'jsonc'],
  jsonc: ['json', 'jsonc'],
};

/** glob 条件的候选写法：原样 + 同义扩展名 + 任意深度前缀 + 仅文件名匹配。 */
function globCandidates(condition: string): string[] {
  const out = new Set<string>([condition]);
  const alias = EXT_ALIAS[condition];
  if (alias) for (const a of alias) out.add(`*.${a}`);
  // `*.yml` ↔ `*.yaml` 这类带前缀的写法也要互认
  for (const key of Object.keys(EXT_ALIAS)) {
    if (condition === `*.${key}`) for (const a of EXT_ALIAS[key]) out.add(`*.${a}`);
  }
  const withDepth = [...out].map((g) => `**/${g}`);
  return [...out, ...withDepth];
}

function matchesCondition(relPath: string, name: string, condition: string): boolean {
  const c = condition.toLowerCase();
  if (c.startsWith('ext:')) {
    const raw = c.slice(4).split(',').map(s => s.trim()).filter(Boolean);
    const exts = new Set<string>();
    for (const e of raw) {
      exts.add(e.replace(/^\*?\.?/, ''));
      for (const a of EXT_ALIAS[e.replace(/^\*?\.?/, '')] ?? []) exts.add(a);
    }
    return exts.has(extOf(name));
  }
  if (c.includes('*') || c.includes('?') || c.includes('/')) {
    return globCandidates(c).some(
      g => globMatch(relPath, g) || globMatch(name, g),
    );
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

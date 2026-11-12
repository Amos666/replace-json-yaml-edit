import { FIXED_EXTS } from './types.ts';
import type { FileScope, Instruction } from './types.ts';

function escapeRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** glob → 正则：'*' 不跨 '/'，'**' 跨目录，大小写不敏感；非法字符转义为字面量 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        out += '(?:.*/)?'; // '**/' 匹配零个或多个目录段
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

export function globMatch(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value);
}

/** 最后一个 '.' 之后的扩展名（小写）；点文件与无扩展名文件返回空串 */
export function extOf(nameOrPath: string): string {
  const base = nameOrPath.split('/').pop() ?? nameOrPath;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

function extEquals(entry: string, ext: string): boolean {
  if (entry.includes('.') || entry.includes('*') || entry.includes('?')) return false;
  return entry.toLowerCase() === ext;
}

/** 'min.js' 之类的条目也应命中 'app.min.js' */
function nameEndsWithEntry(name: string, entry: string): boolean {
  if (!entry.includes('.') || entry.includes('*') || entry.includes('?')) return false;
  return name.toLowerCase().endsWith(`.${entry.toLowerCase()}`);
}

function customHit(name: string, entry: string): boolean {
  return (
    globMatch(name, entry) ||
    extEquals(entry, extOf(name)) ||
    nameEndsWithEntry(name, entry)
  );
}

/** §6.1 matchScope 伪代码；exclude 优先级高于 include，空 include = 全部 */
export function matchScope(file: { path: string; name: string }, scope: FileScope): boolean {
  if (scope.mode === 'fixed') {
    return (FIXED_EXTS[scope.format] as readonly string[]).includes(extOf(file.name));
  }
  if (scope.mode === 'all') return true;

  const include = scope.include ?? [];
  const exclude = scope.exclude ?? [];
  for (const e of exclude) {
    if (customHit(file.name, e)) return false;
  }
  if (include.length === 0) return true;
  return include.some(e => customHit(file.name, e));
}

/** §6.1 树候选扩展名 = 启用指令 fileScope 并集；出现任一 all 即为全部 */
export function candidateExtensions(instructions: Instruction[]): Set<string> | 'all' {
  const set = new Set<string>();
  for (const ins of instructions) {
    if (!ins.enabled) continue;
    const scope = ins.fileScope;
    if (scope.mode === 'all') return 'all';
    if (scope.mode === 'fixed') {
      for (const e of FIXED_EXTS[scope.format]) set.add(e);
    } else {
      for (const e of scope.include ?? []) set.add(e.replace(/^\*\./, '').toLowerCase());
    }
  }
  return set;
}

// §10.7 scopeToGlob：fixed 生成固定扩展名 glob；custom 生成自定义 glob；all 不加扩展名约束
export function scopeToGlob(scope: FileScope): string[] {
  if (scope.mode === 'fixed') {
    return [`**/*.{${FIXED_EXTS[scope.format].join(',')}}`];
  }
  if (scope.mode === 'all') return [];

  const include = scope.include ?? [];
  const exts = include.filter(e => !e.includes('.') && !e.includes('*') && !e.includes('?'));
  const named = include.filter(e => e.includes('.') || e.includes('*') || e.includes('?'));
  const globs: string[] = [];
  if (exts.length) globs.push(`**/*.{${exts.join(',')}}`);
  for (const n of named) globs.push(`**/${n}`);
  return globs;
}

/** §10.7 format 与 fileScope.mode === 'fixed' 一致性校验（不一致报错，不静默） */
export function validateInstruction(ins: Instruction): string | null {
  if (ins.engine === 'structured') {
    if (ins.fileScope.mode !== 'fixed') return '结构化指令的 fileScope 必须为 fixed。';
    if (ins.format !== ins.fileScope.format) return 'format 与 fileScope.format 不一致。';
  } else if (ins.fileScope.mode === 'fixed') {
    return '文本指令不能使用 fixed 扩展名策略。';
  }
  return null;
}

import type { Seg } from './types.ts';

/** §5.1 统一路径语法编译结果；wildcard 由引擎在目标文档上展开 */
export type PathToken =
  | { kind: 'key'; value: string }
  | { kind: 'index'; value: number }
  | { kind: 'wildcard' };

const QUOTES = new Set(['"', "'"]);

export function compilePath(raw: string): PathToken[] {
  const src = raw.trim();
  if (!src) return [];
  const tokens: PathToken[] = [];
  let i = 0;

  if (src[0] === '$') {
    i = 1;
    if (src[i] === '.') i += 1;
  }

  while (i < src.length) {
    const ch = src[i];
    if (ch === '.') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      i += 1;
      if (src[i] === '*') {
        tokens.push({ kind: 'wildcard' });
        i += 1;
      } else if (QUOTES.has(src[i])) {
        const quote = src[i];
        i += 1;
        let buf = '';
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\\' && i + 1 < src.length) {
            buf += src[i + 1];
            i += 2;
          } else {
            buf += src[i];
            i += 1;
          }
        }
        if (i >= src.length) throw new Error(`路径语法错误（引号未闭合）：${raw}`);
        i += 1;
        tokens.push({ kind: 'key', value: buf });
      } else {
        let buf = '';
        while (i < src.length && /[0-9]/.test(src[i])) {
          buf += src[i];
          i += 1;
        }
        if (!buf) throw new Error(`路径语法错误（数组下标无效）：${raw}`);
        tokens.push({ kind: 'index', value: Number(buf) });
      }
      if (src[i] !== ']') throw new Error(`路径语法错误（缺少 ]）：${raw}`);
      i += 1;
      continue;
    }

    let buf = '';
    while (i < src.length && src[i] !== '.' && src[i] !== '[') {
      buf += src[i];
      i += 1;
    }
    if (buf === '*') tokens.push({ kind: 'wildcard' });
    else if (buf) tokens.push({ kind: 'key', value: buf });
    else i += 1;
  }
  return tokens;
}

/** 契约签名：返回 Seg[]；通配以 '*' 字符串表示（真实键名为 '*' 不支持） */
export function parsePath(raw: string): Seg[] {
  return compilePath(raw).map(t => (t.kind === 'wildcard' ? '*' : t.value));
}

export function pathToString(segs: Seg[]): string {
  let out = '$';
  for (const seg of segs) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (seg === '*') out += '[*]';
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) out += `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

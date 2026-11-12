import type { Instruction } from './types.ts';

/** §5.3 sed 简写 → 文本指令字段；解析失败给可操作的中文原因 */
export type SedParseResult =
  | { ok: true; fields: Partial<Instruction> }
  | { ok: false; error: string };

const DELIMITERS = new Set(['/', '|', ',', '#', '~']);

function splitUnescaped(src: string, sep: string): string[] {
  const parts: string[] = [];
  let buf = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) {
      const next = src[i + 1];
      // 转义分隔符还原为字面量；其余转义（如 \. \d）原样保留给 JS RegExp
      buf += next === sep ? sep : `\\${next}`;
      i += 1;
    } else if (ch === sep) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  parts.push(buf);
  return parts;
}

function detectUnsupported(src: string): string | null {
  if (/;\s*\S/.test(src)) return '不支持多命令「;」连接，请拆成多条指令。';
  if (/\\[ULuElL]/.test(src)) return '不支持 sed 的 \\U / \\L / \\u / \\l 大小写转换，请改用 JS 替换串语义（$1、$&）。';
  if (/^\s*\d+\s*,\s*\d+\s*[dp]\s*$/.test(src)) return '行地址语法（1,10d）将在 P1 支持，当前请用表单模式。';
  return null;
}

export function parseSed(raw: string): SedParseResult {
  const src = raw.trim();
  if (!src) return { ok: false, error: '表达式为空' };

  const unsupported = detectUnsupported(src);
  if (unsupported) return { ok: false, error: unsupported };

  // A. 替换：s<sep>pattern<sep>replacement<sep>flags
  if (src[0] === 's') {
    const sep = src[1];
    if (!sep || !DELIMITERS.has(sep)) {
      return { ok: false, error: `替换表达式的分隔符只支持 / | , # ~，收到「${sep ?? ''}」` };
    }
    const parts = splitUnescaped(src.slice(2), sep);
    if (parts.length < 2) return { ok: false, error: '替换表达式缺少替换段（应为 s/模式/替换/标志）' };
    const pattern = parts[0];
    const replacement = parts[1].replace(/\\([1-9])/g, (_m, d: string) => `$${d}`);
    const flags = parts[2] ?? '';

    if (!pattern) return { ok: false, error: '模式不能为空' };
    if (!/^[gim]*$/.test(flags)) {
      return { ok: false, error: `未知 flag「${flags}」，仅支持 g / i / m 组合；请改用表单输入` };
    }
    try {
      new RegExp(pattern, flags);
    } catch (e) {
      return { ok: false, error: `正则语法错误：${(e as Error).message}` };
    }
    return {
      ok: true,
      fields: { engine: 'text', textOp: 'replace', pattern, replacement, flags },
    };
  }

  // B. 删除行：<sep>pattern<sep>d
  const sep = src[0];
  if (DELIMITERS.has(sep)) {
    const parts = splitUnescaped(src.slice(1), sep);
    const pattern = parts[0];
    const command = parts[1] ?? '';
    if (command === 'd') {
      if (!pattern) return { ok: false, error: '删除行表达式的模式不能为空' };
      try {
        new RegExp(pattern, 'm');
      } catch (e) {
        return { ok: false, error: `正则语法错误：${(e as Error).message}` };
      }
      return { ok: true, fields: { engine: 'text', textOp: 'deleteLine', pattern, flags: '' } };
    }
    if (/^[pywhgGx]$/.test(command)) {
      return { ok: false, error: `不支持 sed 的 ${command} 命令 / hold space；仅支持 s/…/…/ 与 /pat/d` };
    }
    return { ok: false, error: `无法识别 sed 简写「${raw}」，仅支持 s/…/…/flags 与 /pat/d` };
  }

  return { ok: false, error: `无法识别 sed 简写「${raw}」，仅支持 s/…/…/flags 与 /pat/d` };
}

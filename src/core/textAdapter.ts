import type { Instruction, Match, MinimalPatch } from './types.ts';

export interface TextPlanOptions {
  maxMatches?: number;
  maxBytes?: number;
}

export interface TextPlanResult {
  patches: MinimalPatch[];
  skipReason?: string;
  warnings?: string[];
}

interface LineSpan {
  start: number;
  contentEnd: number; // 不含行尾符（CRLF 时排除 \r）
  end: number; // 含行尾符；最后一行无换行时 = EOF
}

function splitLines(text: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      const contentEnd = i > start && text[i - 1] === '\r' ? i - 1 : i;
      lines.push({ start, contentEnd, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push({ start, contentEnd: text.length, end: text.length });
  }
  return lines;
}

function lineOf(lines: LineSpan[], offset: number): number {
  for (let i = 0; i < lines.length; i += 1) {
    if (offset < lines[i].end) return i + 1;
  }
  return lines.length || 1;
}

/** §5.3 回溯风险启发式 */
function isCatastrophic(pattern: string | undefined): boolean {
  if (!pattern) return false;
  return pattern.length > 256 || /\([^)]*[+*][^)]*\)[+*{]/.test(pattern);
}

export function planText(
  text: string,
  instructions: Instruction[],
  opts: TextPlanOptions = {},
): TextPlanResult {
  const maxMatches = opts.maxMatches ?? 2000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;

  // §5.3 文件类型安全（all / custom 同样适用）
  if (text.slice(0, 8192).includes('\u0000')) {
    return { patches: [], skipReason: '二进制文件已忽略' };
  }
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { patches: [], skipReason: '文件超过大小上限，已跳过' };
  }

  const lines = splitLines(text);
  const patches: MinimalPatch[] = [];
  const warnings: string[] = [];
  let count = 0;

  for (const ins of instructions) {
    if (ins.engine !== 'text') continue;
    const risky = isCatastrophic(ins.pattern);

    if (ins.textOp === 'replace') {
      const re = new RegExp(ins.pattern ?? '', ins.flags ?? '');
      const replaceRe = new RegExp(ins.pattern ?? '', ins.flags ?? '');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (count >= maxMatches) {
          warnings.push('命中数超过上限，已截断');
          break;
        }
        const start = m.index;
        const end = start + m[0].length;
        const match: Match = {
          instructionId: ins.id,
          engine: 'text',
          range: { start, end },
          oldValue: m[0].slice(0, 120),
          line: lineOf(lines, start),
          ...(risky ? { risky: 'catastrophic' as const } : {}),
        };
        patches.push({
          match,
          start,
          end,
          newText: m[0].replace(replaceRe, ins.replacement ?? ''),
        });
        count += 1;
        if (!re.global) break;
        if (m[0].length === 0) re.lastIndex += 1; // 避免零宽匹配死循环
      }
    } else if (ins.textOp === 'deleteLine') {
      const baseFlags = ins.flags ?? '';
      const flags = baseFlags.includes('m') ? baseFlags : `${baseFlags}m`;
      const re = new RegExp(ins.pattern ?? '', flags);
      for (const line of lines) {
        if (count >= maxMatches) {
          warnings.push('命中数超过上限，已截断');
          break;
        }
        const lineText = text.slice(line.start, line.contentEnd);
        re.lastIndex = 0;
        if (!re.test(lineText)) continue;
        const match: Match = {
          instructionId: ins.id,
          engine: 'text',
          range: { start: line.start, end: line.end },
          oldValue: lineText.slice(0, 120),
          line: lineOf(lines, line.start),
          ...(risky ? { risky: 'catastrophic' as const } : {}),
        };
        patches.push({ match, start: line.start, end: line.end, newText: '' });
        count += 1;
      }
    }
  }

  return { patches, ...(warnings.length ? { warnings } : {}) };
}

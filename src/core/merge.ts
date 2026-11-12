import type { MinimalPatch } from './types.ts';

/** §7.3 / §5.4 补丁按 start 倒序，供一次性应用 */
export function mergePatches(patches: MinimalPatch[]): MinimalPatch[] {
  return [...patches].sort((a, b) => b.start - a.start || b.end - a.end);
}

/** 任意两条指令（跨引擎也算）补丁区间重叠 → 冲突对；该文件整体不部分应用 */
export function detectConflicts(patches: MinimalPatch[]): Array<[string, string]> {
  const sorted = [...patches].sort((a, b) => a.start - b.start || a.end - b.end);
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (sorted[j].start >= sorted[i].end) break;
      const a = sorted[i].match.instructionId;
      const b = sorted[j].match.instructionId;
      if (a !== b) pairs.push([a, b]);
    }
  }
  return pairs;
}

/** 倒序应用补丁到原文（幂等测试与 diff 生成用） */
export function applyPatches(text: string, patches: MinimalPatch[]): string {
  let out = text;
  for (const p of mergePatches(patches)) {
    out = out.slice(0, p.start) + p.newText + out.slice(p.end);
  }
  return out;
}

/** §10.1 对补丁求逆：在 after 文本坐标系把 newText 换回原文片段 */
export function reversePatches(original: string, patches: MinimalPatch[]): MinimalPatch[] {
  const asc = [...patches].sort((a, b) => a.start - b.start || a.end - b.end);
  const reversed: MinimalPatch[] = [];
  let delta = 0;
  for (const p of asc) {
    const start = p.start + delta;
    reversed.push({
      ...p,
      start,
      end: start + p.newText.length,
      newText: original.slice(p.start, p.end),
    });
    delta += p.newText.length - (p.end - p.start);
  }
  return mergePatches(reversed);
}

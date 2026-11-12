import type { FileChangePlan, Instruction, MinimalPatch } from './types.ts';
import { matchScope } from './extensionPolicy.ts';
import { planJsonc } from './jsoncAdapter.ts';
import { planYaml } from './yamlAdapter.ts';
import { planText } from './textAdapter.ts';
import { detectConflicts, mergePatches } from './merge.ts';

export interface PlanOptions {
  maxMatches?: number;
  maxBytes?: number;
}

/** §5.4 一个文件 × 已按 fileScope 挑选过的指令 → FileChangePlan */
export function planFile(
  text: string,
  fileName: string,
  instructions: Instruction[],
  opts: PlanOptions = {},
): FileChangePlan {
  const jsonIns = instructions.filter(i => i.engine === 'structured' && i.format === 'json');
  const yamlIns = instructions.filter(i => i.engine === 'structured' && i.format === 'yaml');
  const textIns = instructions.filter(i => i.engine === 'text');
  const format: FileChangePlan['format'] = textIns.length
    ? 'text'
    : jsonIns.length
      ? 'json'
      : 'yaml';

  const patches: MinimalPatch[] = [];
  const parseErrors: string[] = [];

  if (jsonIns.length) {
    const r = planJsonc(text, jsonIns);
    patches.push(...r.patches);
    if (r.parseErrors) parseErrors.push(...r.parseErrors);
  }
  if (yamlIns.length) {
    const r = planYaml(text, yamlIns);
    patches.push(...r.patches);
    if (r.parseErrors) parseErrors.push(...r.parseErrors);
  }
  // 文本指令不受结构化解析失败影响，照常执行（§5.4）
  if (textIns.length) {
    const r = planText(text, textIns, { maxMatches: opts.maxMatches, maxBytes: opts.maxBytes });
    patches.push(...r.patches);
    if (r.skipReason) parseErrors.push(r.skipReason);
  }

  const conflicts = detectConflicts(patches);
  if (conflicts.length) {
    // 同文件冲突 → 整体标红、列出冲突对，不部分应用
    parseErrors.push(`补丁区间重叠冲突：${conflicts.map(([a, b]) => `${a} ↔ ${b}`).join('，')}`);
    return { uri: fileName, format, parseErrors, patches: [] };
  }

  return {
    uri: fileName,
    format,
    ...(parseErrors.length ? { parseErrors } : {}),
    patches: mergePatches(patches),
  };
}

export interface SessionFile {
  uri: string;
  name: string;
  text: string;
}

export interface SessionPlan {
  plans: FileChangePlan[];
  skipped: Array<{ uri: string; reason: string }>;
}

/** 完整会话：按 fileScope 挑选（唯一真相）→ 逐文件 plan */
export function planSession(
  files: SessionFile[],
  instructions: Instruction[],
  opts: PlanOptions = {},
): SessionPlan {
  const plans: FileChangePlan[] = [];
  const skipped: Array<{ uri: string; reason: string }> = [];
  for (const file of files) {
    const applicable = instructions.filter(
      i => i.enabled && matchScope({ path: file.uri, name: file.name }, i.fileScope),
    );
    if (!applicable.length) continue;
    const plan = planFile(file.text, file.uri, applicable, opts);
    if (plan.patches.length === 0 && plan.parseErrors?.length) {
      skipped.push({ uri: file.uri, reason: plan.parseErrors.join('；') });
    }
    plans.push(plan);
  }
  return { plans, skipped };
}

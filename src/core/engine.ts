import type { FileChangePlan, Instruction, MinimalPatch } from './types.ts';
import { matchScope } from './extensionPolicy.ts';
import { planJsonc } from './jsoncAdapter.ts';
import { planYaml } from './yamlAdapter.ts';
import { planText } from './textAdapter.ts';
import { detectConflicts, mergePatches } from './merge.ts';
import { resolveInstructions, usesExprFeatures } from './expression.ts';
import * as jsonc from 'jsonc-parser';
import { parseAllDocuments } from 'yaml';

export interface PlanOptions {
  maxMatches?: number;
  maxBytes?: number;
}


/** 0.2.6：把文档解析成 JS 值，供表达式/条件读取。失败返回 undefined（指令原样走 adapter，由 adapter 报错）。 */
function docValueFor(text: string, format: 'json' | 'yaml'): unknown {
  try {
    if (format === 'json') {
      const v = jsonc.parse(text);
      return v;
    }
    const docs = parseAllDocuments(text) as any[];
    return docs.length && !docs[0].errors.length ? docs[0].toJS() : undefined;
  } catch {
    return undefined;
  }
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

  // 0.2.6 需求2一期：仅结构化指令支持派生值/条件。先把文档解析成 JS 值，
  // 再解析每条指令的 when / valueExpr；条件不满足或表达式错误 → 跳过该指令并记账。
  let effJsonIns = jsonIns;
  let effYamlIns = yamlIns;
  if ((jsonIns.length || yamlIns.length) &&
      instructions.some(i => i.engine === 'structured' && usesExprFeatures(i))) {
    if (jsonIns.length) {
      const r = resolveInstructions(jsonIns, docValueFor(text, 'json'));
      effJsonIns = r.instructions;
      parseErrors.push(...r.errors);
    }
    if (yamlIns.length) {
      const r = resolveInstructions(yamlIns, docValueFor(text, 'yaml'));
      effYamlIns = r.instructions;
      parseErrors.push(...r.errors);
    }
  }

  // 0.2.1：任何适配器抛异常都降级为该文件跳过，绝不让单文件问题中断整轮扫描
  if (jsonIns.length) {
    try {
      const r = planJsonc(text, effJsonIns);
      patches.push(...r.patches);
      if (r.parseErrors) parseErrors.push(...r.parseErrors);
    } catch (e) {
      parseErrors.push(`JSON 指令规划失败：${(e as Error).message}（已跳过）`);
    }
  }
  if (yamlIns.length) {
    try {
      const r = planYaml(text, effYamlIns);
      patches.push(...r.patches);
      if (r.parseErrors) parseErrors.push(...r.parseErrors);
    } catch (e) {
      parseErrors.push(`YAML 指令规划失败：${(e as Error).message}（已跳过）`);
    }
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

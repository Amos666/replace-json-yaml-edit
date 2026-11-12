/**
 * 附录 A：表达式集 `.structedit.json` v3 读写；v1/v2 兼容补齐并升级为 v3 写出。
 * 导入/导出走 workspace.showOpenDialog / showSaveDialog + workspace.fs（零外部依赖）。
 */

import * as vscode from 'vscode';
import { validateInstruction } from '../core/index.ts';
import type {
  Engine, FileScope, Instruction, StructOp, TextOp, ValueType,
} from '../core/types.ts';
import { EXPRESSION_SET_VERSION } from './types.ts';
import type { ExpressionSetV3 } from './types.ts';

let idSeq = 0;
function genId(): string {
  idSeq += 1;
  return `i${Date.now().toString(36)}${idSeq.toString(36)}`;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asStringArray(v: unknown, fallback: string[] = []): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : fallback;
}

const VALUE_TYPES = ['string', 'number', 'boolean', 'null', 'object', 'array'];

export interface NormalizedSet {
  set: ExpressionSetV3;
  upgraded: boolean;
  warnings: string[];
}

/**
 * 归一化任意输入为规范 v3：
 * - version !== 3 或指令缺 fileScope → 兼容补齐并 upgraded=true（读入后一律升级写出）；
 * - 结构化：缺 format 默认 fixed/yaml 并提示；format 与 fixed 强制一致；
 * - 文本：缺 fileScope 默认 all；不允许 fixed（自动纠正）；
 * - 校验 custom.include/exclude 为字符串数组、treeFilter.raw 为字符串。
 */
export function normalizeExpressionSet(raw: unknown): NormalizedSet {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') {
    throw new Error('表达式集不是合法的 JSON 对象。');
  }
  const o = raw as Record<string, unknown>;
  const version = typeof o.version === 'number' ? o.version : 2;
  const rawInstructions = Array.isArray(o.instructions) ? o.instructions : [];
  let upgraded = version !== EXPRESSION_SET_VERSION;

  const instructions: Instruction[] = [];
  for (const ri of rawInstructions) {
    if (!ri || typeof ri !== 'object') continue;
    const r = { ...(ri as Record<string, unknown>) };
    const engine: Engine = r.engine === 'text' ? 'text' : 'structured';
    const id = asString(r.id) || genId();
    const enabled = r.enabled !== false;

    let fileScope: FileScope;
    let format: 'json' | 'yaml' | undefined;
    const rs = r.fileScope && typeof r.fileScope === 'object'
      ? (r.fileScope as Record<string, unknown>) : null;
    if (rs) {
      const mode = asString(rs.mode);
      if (mode === 'fixed') {
        const f: 'json' | 'yaml' = rs.format === 'yaml' ? 'yaml' : 'json';
        fileScope = { mode: 'fixed', format: f };
        format = f;
      } else if (mode === 'all') {
        fileScope = { mode: 'all' };
      } else {
        if (rs.include !== undefined && !Array.isArray(rs.include)) {
          warnings.push(`指令 ${id}：custom.include 应为字符串数组。`);
        }
        if (rs.exclude !== undefined && !Array.isArray(rs.exclude)) {
          warnings.push(`指令 ${id}：custom.exclude 应为字符串数组。`);
        }
        fileScope = {
          mode: 'custom',
          include: asStringArray(rs.include),
          exclude: asStringArray(rs.exclude),
        };
      }
    } else {
      // v1/v2 兼容：无 fileScope
      upgraded = true;
      if (engine === 'structured') {
        const f: 'json' | 'yaml' = r.format === 'json' ? 'json' : r.format === 'yaml' ? 'yaml' : 'yaml';
        if (r.format !== 'json' && r.format !== 'yaml') {
          warnings.push(`指令 ${id}：v1/v2 结构化指令缺少 format，已默认补齐 fixed/yaml。`);
        }
        fileScope = { mode: 'fixed', format: f };
        format = f;
      } else {
        fileScope = { mode: 'all' };
      }
    }

    if (engine === 'structured') {
      if (fileScope.mode !== 'fixed') {
        fileScope = { mode: 'fixed', format: format ?? 'yaml' };
        warnings.push(`指令 ${id}：结构化指令 fileScope 必须为 fixed，已自动修正。`);
      }
      format = fileScope.format;
    } else {
      if (fileScope.mode === 'fixed') {
        fileScope = { mode: 'all' };
        warnings.push(`指令 ${id}：文本指令不能使用 fixed 扩展名策略，已改为 all。`);
      }
      format = undefined;
    }

    let ins: Instruction;
    if (engine === 'structured') {
      const kind: StructOp = r.kind === 'delete' ? 'delete' : r.kind === 'insert' ? 'insert' : 'set';
      const vt = r.valueType;
      const valueType: ValueType | undefined =
        typeof vt === 'string' && VALUE_TYPES.includes(vt) ? (vt as ValueType) : undefined;
      ins = {
        id, enabled, engine, fileScope,
        format,
        kind,
        path: asString(r.path),
        value: asString(r.value),
        ...(valueType ? { valueType } : {}),
        scope: r.scope === 'first' ? 'first' : 'all',
        createPath: r.createPath === true,
      };
    } else {
      const textOp: TextOp = r.textOp === 'deleteLine' ? 'deleteLine' : 'replace';
      const lineRange = (r.lineRange && typeof r.lineRange === 'object')
        ? (r.lineRange as { from?: number; to?: number })
        : undefined;
      ins = {
        id, enabled, engine, fileScope,
        textOp,
        pattern: asString(r.pattern),
        replacement: asString(r.replacement),
        flags: asString(r.flags, 'g'),
        ...(lineRange ? { lineRange } : {}),
      };
    }
    const err = validateInstruction(ins);
    if (err) warnings.push(`指令 ${id}：${err}`);
    instructions.push(ins);
  }

  const sel = o.selection && typeof o.selection === 'object'
    ? (o.selection as Record<string, unknown>) : {};
  const overrides = sel.overrides && typeof sel.overrides === 'object'
    ? (sel.overrides as Record<string, unknown>) : {};
  if (sel.treeFilter !== undefined && typeof sel.treeFilter !== 'string') {
    warnings.push('selection.treeFilter 应为字符串，已按空串处理。');
  }
  if (sel.include !== undefined && !Array.isArray(sel.include)) {
    warnings.push('selection.include 应为字符串数组。');
  }
  if (sel.exclude !== undefined && !Array.isArray(sel.exclude)) {
    warnings.push('selection.exclude 应为字符串数组。');
  }

  const set: ExpressionSetV3 = {
    version: EXPRESSION_SET_VERSION,
    name: asString(o.name, 'Batch Replace 会话'),
    selection: {
      include: asStringArray(sel.include),
      exclude: asStringArray(sel.exclude),
      treeFilter: asString(sel.treeFilter),
      overrides: {
        add: asStringArray(overrides.add),
        remove: asStringArray(overrides.remove),
      },
    },
    instructions,
  };
  return { set, upgraded, warnings };
}

export function readExpressionSet(text: string): NormalizedSet {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`表达式集 JSON 解析失败：${(e as Error).message}`);
  }
  return normalizeExpressionSet(raw);
}

export function writeExpressionSet(set: ExpressionSetV3): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(set, null, 2)}\n`);
}

/** 导入：读文件 → 归一化 → 若为旧版则升级为 v3 写回原文件（附录 A）。 */
export async function importExpressionSet(): Promise<NormalizedSet | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { '表达式集': ['json'] },
    openLabel: '导入表达式集',
  });
  const uri = picked?.[0];
  if (!uri) return undefined;
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const result = readExpressionSet(text);
  if (result.upgraded) {
    await vscode.workspace.fs.writeFile(uri, writeExpressionSet(result.set));
    result.warnings.push('已把旧版表达式集升级为 v3 并写回原文件。');
  }
  return result;
}

/** 导出：校验/归一化 data（前端 buildExpressionSet 产物）→ showSaveDialog → 写文件。 */
export async function exportExpressionSet(data: unknown): Promise<NormalizedSet | undefined> {
  const normalized = normalizeExpressionSet(data);
  const folder = vscode.workspace.workspaceFolders?.[0];
  const target = await vscode.window.showSaveDialog({
    defaultUri: folder
      ? vscode.Uri.joinPath(folder.uri, 'batch-replace.structedit.json')
      : undefined,
    filters: { '表达式集': ['json'] },
    saveLabel: '导出表达式集',
  });
  if (!target) return undefined;
  await vscode.workspace.fs.writeFile(target, writeExpressionSet(normalized.set));
  return normalized;
}

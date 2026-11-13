/** §7.5 应用与一次撤销 + §7.5/§8.2 删除类确认守卫 + §6.6 hash 二次校验。 */

import * as vscode from 'vscode';
import { detectConflicts } from '../core/index.ts';
import { readText } from './scan.ts';
import type { HostConfig, HostState, SkipItem } from './types.ts';

export interface ApplyResult {
  appliedUris: string[];
  changes: number;
  hashSkips: SkipItem[];
}

/** 前端发 confirmed，host 二次校验：delete/deleteLine 命中 >20 / >500 才要求确认。 */
export function deleteGuard(state: HostState, uris: string[]): { needed: boolean; large: boolean } {
  const hasDel = state.instructions.some(
    (i) => i.enabled && (i.kind === 'delete' || i.textOp === 'deleteLine'),
  );
  const totalChanges = uris.reduce(
    (n, u) => n + (state.records.get(u)?.changeCount ?? 0),
    0,
  );
  if (!hasDel) return { needed: false, large: false };
  return { needed: totalChanges > 20, large: totalChanges > 500 };
}

/**
 * 一次 WorkspaceEdit 提交 → 一次 Ctrl+Z 全撤。
 * 每个文件 apply 前重读并比对扫描时 hash，不一致跳过进报告（防扫描/应用之间被改动）。
 */
export async function applyChanges(
  state: HostState,
  cfg: HostConfig,
  uris: string[],
  confirmed: boolean,
): Promise<ApplyResult> {
  const guard = deleteGuard(state, uris);
  if (guard.needed && !confirmed) {
    throw new Error(
      `删除类变更命中超过 20 处（共 ${uris.reduce((n, u) => n + (state.records.get(u)?.changeCount ?? 0), 0)} 处），需要确认后再应用。`,
    );
  }

  const we = new vscode.WorkspaceEdit();
  const appliedUris: string[] = [];
  const hashSkips: SkipItem[] = [];
  let changes = 0;

  for (const uriStr of uris) {
    const rec = state.records.get(uriStr);
    if (!rec || rec.patches.length === 0) continue;
    // 防御性二次裁决：带冲突的文件绝不部分应用
    if (detectConflicts(rec.patches).length > 0) {
      hashSkips.push({ uri: uriStr, reason: '补丁区间重叠冲突，整文件跳过' });
      continue;
    }

    const reread = await readText(uriStr, cfg, state.scopeRoot);
    if (reread.skip) {
      hashSkips.push({ uri: uriStr, reason: reread.skip });
      continue;
    }
    if (reread.hash !== rec.hash) {
      hashSkips.push({ uri: uriStr, reason: '文件内容在扫描后发生变化，已跳过' });
      continue;
    }

    const uri = vscode.Uri.parse(uriStr);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch (e) {
      hashSkips.push({ uri: uriStr, reason: `打开失败：${(e as Error).message}` });
      continue;
    }

    const edits = rec.patches.map((p) =>
      vscode.TextEdit.replace(
        new vscode.Range(doc.positionAt(p.start), doc.positionAt(p.end)),
        p.newText,
      ),
    );
    we.set(uri, edits);
    appliedUris.push(uriStr);
    changes += rec.patches.length;
  }

  if (appliedUris.length > 0) {
    const ok = await vscode.workspace.applyEdit(we);
    if (!ok) throw new Error('应用 WorkspaceEdit 失败，未写入任何文件。');
  }
  return { appliedUris, changes, hashSkips };
}

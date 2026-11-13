/** §7.5 应用与一次撤销 + §6.6 hash 二次校验。 */

import * as vscode from 'vscode';
import { detectConflicts } from '../core/index.ts';
import { readText } from './scan.ts';
import type { HostConfig, HostState, SkipItem } from './types.ts';

/** 一键回退快照：应用前每个文件的完整原文。 */
export interface SnapshotEntry {
  uri: string;
  text: string;
}

export interface ApplyResult {
  appliedUris: string[];
  changes: number;
  hashSkips: SkipItem[];
  snapshot: SnapshotEntry[];
  saveFailures: string[];
}

/**
 * 一次 WorkspaceEdit 提交 + 立即保存（0.1.5 反馈：应用即全部 save，用户不再需要
 * 逐个打开被编辑文件确认/保存）。删除类变更同样直接写回——diff 明细在第 ③ 步预览
 * 已给出，误改可用「一键回退」整体还原。
 * 每个文件 apply 前重读并比对扫描时 hash，不一致跳过进报告（防扫描/应用之间被改动）。
 */
export async function applyChanges(
  state: HostState,
  cfg: HostConfig,
  uris: string[],
): Promise<ApplyResult> {
  const we = new vscode.WorkspaceEdit();
  const appliedUris: string[] = [];
  const hashSkips: SkipItem[] = [];
  const snapshot: SnapshotEntry[] = [];
  const opened: Array<{ uri: string; doc: vscode.TextDocument }> = [];
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
    snapshot.push({ uri: uriStr, text: reread.text });
    opened.push({ uri: uriStr, doc });
    changes += rec.patches.length;
  }

  if (appliedUris.length > 0) {
    const ok = await vscode.workspace.applyEdit(we);
    if (!ok) throw new Error('应用 WorkspaceEdit 失败，未写入任何文件。');
  }
  // 应用即保存：applyEdit 只改内存 buffer，必须显式 doc.save() 才会落盘。
  const saveFailures = await saveTouchedDocs(opened);
  return { appliedUris, changes, hashSkips, snapshot, saveFailures };
}

/** 逐个保存本次触碰的文档（不误伤用户其它未保存文件）。 */
async function saveTouchedDocs(
  opened: Array<{ uri: string; doc: vscode.TextDocument }>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const { uri, doc } of opened) {
    try {
      await doc.save();
    } catch (e) {
      failures.push(`${uri}：${(e as Error).message}`);
    }
  }
  return failures;
}

/** 一键回退：整文件还原为上次应用前原文，一次 WorkspaceEdit + 立即保存。 */
export async function restoreSnapshot(snapshot: SnapshotEntry[]): Promise<{
  restored: string[];
  saveFailures: string[];
}> {
  const we = new vscode.WorkspaceEdit();
  const opened: Array<{ uri: string; doc: vscode.TextDocument }> = [];
  const restored: string[] = [];
  for (const { uri, text } of snapshot) {
    const parsed = vscode.Uri.parse(uri);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(parsed);
    } catch {
      continue;
    }
    we.set(parsed, [
      vscode.TextEdit.replace(
        new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
        text,
      ),
    ]);
    opened.push({ uri, doc });
    restored.push(uri);
  }
  if (restored.length > 0) {
    const ok = await vscode.workspace.applyEdit(we);
    if (!ok) throw new Error('回退 WorkspaceEdit 失败，未还原任何文件。');
  }
  const saveFailures = await saveTouchedDocs(opened);
  return { restored, saveFailures };
}

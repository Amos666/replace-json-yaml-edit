/** §7.5 应用与一键回退 + §6.6 hash 二次校验（0.2.5 起字节写入，不打开编辑器）。 */

import * as vscode from 'vscode';
import { applyPatches, detectConflicts } from '../core/index.ts';
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
 * 0.2.5：宿主侧直接字节写入落盘（fs.writeFile），不经 TextDocument / 编辑器标签，
 * 应用时不会在 VS Code 编辑区打开任何被改文件。删除类变更同样直接写回；误改可用
 * 「一键回退」按原文快照整体还原。
 * 每个文件 apply 前重读并比对扫描时 hash，不一致跳过进报告（防扫描/应用之间被改动）。
 */
export async function applyChanges(
  state: HostState,
  cfg: HostConfig,
  uris: string[],
): Promise<ApplyResult> {
  const appliedUris: string[] = [];
  const hashSkips: SkipItem[] = [];
  const snapshot: SnapshotEntry[] = [];
  const writes: Array<{ uri: string; obj: vscode.Uri; text: string }> = [];
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

    // 0.2.5：宿主侧直接把补丁套到原文得到新文本，用 fs.writeFile 写字节。
    // 不再 openTextDocument / applyEdit / doc.save —— 不会在 VS Code 编辑区打开任何被改文件，
    // 也不污染编辑器撤销栈与「打开的编辑器」列表（误改用「一键回退」整文件还原）。
    const newText = applyPatches(reread.text, rec.patches);
    writes.push({ uri: uriStr, obj: vscode.Uri.parse(uriStr), text: newText });
    appliedUris.push(uriStr);
    snapshot.push({ uri: uriStr, text: reread.text });
    changes += rec.patches.length;
  }

  const saveFailures = await writeAllBytes(writes);
  return { appliedUris, changes, hashSkips, snapshot, saveFailures };
}

/** 用 workspace.fs.writeFile 直接落盘（不经 TextDocument，不打开编辑器标签）。 */
async function writeAllBytes(
  writes: Array<{ uri: string; obj: vscode.Uri; text: string }>,
): Promise<string[]> {
  const failures: string[] = [];
  const enc = new TextEncoder();
  for (const { uri, obj, text } of writes) {
    try {
      await vscode.workspace.fs.writeFile(obj, enc.encode(text));
    } catch (e) {
      failures.push(`${uri}：${(e as Error).message}`);
    }
  }
  return failures;
}

/** 一键回退：整文件还原为上次应用前原文（字节写入，不打开编辑器）。 */
export async function restoreSnapshot(snapshot: SnapshotEntry[]): Promise<{
  restored: string[];
  saveFailures: string[];
}> {
  const writes: Array<{ uri: string; obj: vscode.Uri; text: string }> = [];
  const restored: string[] = [];
  for (const { uri, text } of snapshot) {
    writes.push({ uri, obj: vscode.Uri.parse(uri), text });
    restored.push(uri);
  }
  const saveFailures = await writeAllBytes(writes);
  return { restored, saveFailures };
}

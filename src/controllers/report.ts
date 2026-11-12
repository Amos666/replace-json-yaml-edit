/** 执行报告（§8.2 报告态 / §12.4）：变更明细、跳过原因、冲突、解析失败 + Markdown 导出。 */

import * as vscode from 'vscode';
import type { HostToWebview, ReportPayload } from '../shared/protocol.ts';
import type { HostState, SkipItem } from './types.ts';

/** 汇总一次 apply 的结果：扫描期跳过 + apply 期 hash 跳过 + 冲突 + 变更明细。 */
export function buildReport(
  state: HostState,
  appliedUris: string[],
  changes: number,
  hashSkips: SkipItem[],
): ReportPayload {
  const details = appliedUris.map((uri) => {
    const rec = state.records.get(uri);
    return { uri, path: rec?.relPath ?? uri, changeCount: rec?.changeCount ?? 0 };
  });
  return {
    appliedAt: new Date().toLocaleString(),
    changedFiles: appliedUris.length,
    changes,
    skipped: [...state.scanSkipped, ...hashSkips],
    conflicts: state.scanConflicts.map((c) => ({ uri: c.uri, instructionIds: [...c.instructionIds] })),
    details,
  };
}

/** 审计用 Markdown（含本次扩展名策略与筛选条件，§12.4）。 */
export function reportToMarkdown(
  report: ReportPayload,
  meta?: { candidateExtensions?: string[] | 'all'; filterRaw?: string },
): string {
  const out: string[] = [];
  out.push('# Batch Replace for JSON & YAML — 执行报告');
  out.push('');
  out.push(`- 应用时间：${report.appliedAt}`);
  out.push(`- 变更文件：${report.changedFiles}`);
  out.push(`- 变更处数：${report.changes}`);
  if (meta) {
    const cand = meta.candidateExtensions === 'all'
      ? '全部文件类型'
      : (meta.candidateExtensions ?? []).join(', ') || '（无）';
    out.push(`- 本次扩展名策略（候选）：${cand}`);
    out.push(`- 本次筛选条件：${meta.filterRaw || '（无）'}`);
  }
  out.push('');

  out.push('## 变更明细');
  out.push('');
  if (report.details.length === 0) out.push('（无）');
  else {
    out.push('| 文件 | 变更处数 |');
    out.push('| --- | --- |');
    for (const d of report.details) out.push(`| ${d.path} | ${d.changeCount} |`);
  }
  out.push('');

  out.push('## 跳过原因（含解析失败 / 二进制 / 非 UTF-8 / 超限 / hash 不一致）');
  out.push('');
  if (report.skipped.length === 0) out.push('（无）');
  else {
    out.push('| 文件 | 原因 |');
    out.push('| --- | --- |');
    for (const s of report.skipped) out.push(`| ${s.uri} | ${s.reason.replace(/\|/g, '\\|')} |`);
  }
  out.push('');

  out.push('## 冲突（整文件未应用）');
  out.push('');
  if (report.conflicts.length === 0) out.push('（无）');
  else {
    out.push('| 文件 | 冲突指令 |');
    out.push('| --- | --- |');
    for (const c of report.conflicts) out.push(`| ${c.uri} | ${c.instructionIds.join(', ')} |`);
  }
  out.push('');
  return out.join('\n');
}

/** showReport 命令 / toolbar「历史」：下发上次报告，无报告时给出明确提示。 */
export function showReport(post: (m: HostToWebview) => void, state: HostState): void {
  if (!state.lastReport) {
    void vscode.window.showInformationMessage(
      'Batch Replace for JSON & YAML：暂无执行报告，请先应用一次变更。',
    );
    return;
  }
  post({ type: 'report', payload: state.lastReport });
  post({ type: 'state', payload: { phase: 'report', counts: state.counts } });
}

/** exportReport：showSaveDialog + workspace.fs，零外部依赖。 */
export async function exportReport(state: HostState): Promise<void> {
  if (!state.lastReport) {
    void vscode.window.showInformationMessage('Batch Replace for JSON & YAML：暂无执行报告可导出。');
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  const target = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder.uri, 'batch-replace-report.md') : undefined,
    filters: { Markdown: ['md'] },
    saveLabel: '导出报告',
  });
  if (!target) return;
  const md = reportToMarkdown(state.lastReport, {
    candidateExtensions: state.candidateExtensions,
    filterRaw: state.filter.raw,
  });
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(md));
  void vscode.window.showInformationMessage('Batch Replace for JSON & YAML：报告已导出。');
}

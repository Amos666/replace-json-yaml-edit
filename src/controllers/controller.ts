/**
 * 宿主层总控：WebviewPanel 生命周期、§8.2 状态机、onDidReceiveMessage 全消息分发、
 * 300ms 防抖重扫、扫描取消、7 个命令（附录 B）。
 *
 * 所有写回必须走 workspace.applyEdit(WorkspaceEdit)（§4.4 原则 2），由 apply.ts 完成。
 * 协议约定：selectAllMatches / sequentialReview 以 { type:'command', command } 转发给面板，
 * UI 端会忽略未知 type；宿主侧同时真正执行并回写 tree/review，保证功能可用。
 */

import * as vscode from 'vscode';
import {
  applyBatch, clearOverrides, matchTreeFilter, parseTreeFilter, pathToString,
  resetToGlob, reviewQueue, reviewStep, setSelected,
} from '../core/index.ts';
import type { FileScope, Instruction } from '../core/types.ts';
import type {
  BatchOp, HostToWebview, ReviewAction, ReviewPayload, WebviewToHost,
} from '../shared/protocol.ts';
import { applyChanges } from './apply.ts';
import { exportExpressionSet, importExpressionSet } from './expressionSet.ts';
import { buildHtml, createPanel } from './html.ts';
import { buildReport, exportReport, showReport } from './report.ts';
import {
  readConfig, recomputeFilter, refreshFileList, runScan, ScanCancelledError,
} from './scan.ts';
import {
  applyExpressionSet, buildEquivalentGlob, createInitialState, toInitPayload, toTreePayload,
} from './state.ts';
import { DISPLAY_NAME } from './types.ts';
import type { HostState, TextCacheEntry } from './types.ts';

let insSeq = 0;
function genInsId(): string {
  insSeq += 1;
  return `cmd${Date.now().toString(36)}${insSeq.toString(36)}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ScanOptions {
  refreshFiles: boolean;
  clearCache: boolean;
  sendInit: boolean;
}

export class PanelController {
  private readonly context: vscode.ExtensionContext;
  private readonly extensionUri: vscode.Uri;
  private readonly state: HostState = createInitialState();
  private readonly textCache = new Map<string, TextCacheEntry>();

  private panel: vscode.WebviewPanel | undefined;
  private panelReady = false;
  private readyQueue: Array<() => void> = [];
  private scanTimer: ReturnType<typeof setTimeout> | undefined;
  private filterTimer: ReturnType<typeof setTimeout> | undefined;
  private scanGeneration = 0;
  private scanCts: vscode.CancellationTokenSource | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.extensionUri = context.extensionUri;
  }

  /* ── 消息发送 / 错误 ─────────────────────────────────────── */

  private post(msg: HostToWebview): void {
    void this.panel?.webview.postMessage(msg);
  }

  /** 命令/消息统一错误出口：不静默吞掉，回发 {type:'error'}。 */
  postError(e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    this.post({
      type: 'error',
      payload: { message: err.message, detail: err.stack },
    });
  }

  private postState(phase: HostState['phase'], message?: string): void {
    this.post({
      type: 'state',
      payload: { phase, counts: this.state.counts, ...(message ? { message } : {}) },
    });
  }

  private postTree(): void {
    this.post({ type: 'tree', payload: toTreePayload(this.state) });
  }

  /** 协议约定转发：HostToWebview 未定义 command 类型，UI 端忽略未知 type。 */
  private postCommand(command: string): void {
    void this.panel?.webview.postMessage({ type: 'command', command });
  }

  /* ── 面板生命周期 ───────────────────────────────────────── */

  private async ensurePanel(): Promise<{ panel: vscode.WebviewPanel; created: boolean }> {
    if (this.panel) return { panel: this.panel, created: false };
    const panel = createPanel();
    this.panel = panel;

    // 先注册消息/释放回调，再 setHtml（webview 在 setHtml 后才执行脚本并可能立即发 ready）。
    panel.webview.onDidReceiveMessage(
      (msg: WebviewToHost) => { void this.onMessage(msg); },
      undefined,
      this.context.subscriptions,
    );
    panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.panelReady = false;
        this.readyQueue = [];
        this.cancelScan();
        this.textCache.clear();
      },
      undefined,
      this.context.subscriptions,
    );
    this.context.subscriptions.push(panel);
    panel.webview.html = await buildHtml(panel.webview, this.extensionUri);
    return { panel, created: true };
  }

  private afterReady(fn: () => void): void {
    if (this.panelReady) fn();
    else this.readyQueue.push(fn);
  }

  /* ── 扫描：防抖 / 取消 / 进度 ───────────────────────────── */

  private cancelScan(): void {
    if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = undefined; }
    if (this.filterTimer) { clearTimeout(this.filterTimer); this.filterTimer = undefined; }
    this.scanGeneration += 1;
    this.scanCts?.cancel();
    this.scanCts?.dispose();
    this.scanCts = undefined;
  }

  private scheduleRescan(delay = 300): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      void this.doScan({ refreshFiles: false, clearCache: false, sendInit: false });
    }, delay);
  }

  private scheduleFilter(): void {
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => {
      this.filterTimer = undefined;
      recomputeFilter(this.state);
      this.postTree();
    }, 150);
  }

  /** 一次完整扫描：findFiles（可选）→ runScan → init/tree + state，含进度与取消。 */
  private async doScan(opts: ScanOptions): Promise<void> {
    // 取消仍在进行的扫描（generation + findFiles token），避免旧结果覆盖新状态。
    this.scanCts?.cancel();
    this.scanCts?.dispose();
    this.scanCts = undefined;
    const gen = ++this.scanGeneration;
    const cancelled = (): boolean => gen !== this.scanGeneration;

    const cfg = readConfig();
    this.state.phase = 'scanning';
    this.post({
      type: 'state',
      payload: {
        phase: 'scanning',
        counts: { ...this.state.counts, scanned: 0, total: this.state.entries.length },
      },
    });

    try {
      if (opts.refreshFiles || this.state.entries.length === 0) {
        const cts = new vscode.CancellationTokenSource();
        this.scanCts = cts;
        await refreshFileList(this.state, cfg, cts.token);
        cts.dispose();
        if (this.scanCts === cts) this.scanCts = undefined;
      }
      if (cancelled()) return;
      if (opts.clearCache) this.textCache.clear();

      await runScan(this.state, cfg, this.textCache, cancelled, (scanned, total) => {
        if (cancelled()) return;
        this.post({
          type: 'state',
          payload: { phase: 'scanning', counts: { ...this.state.counts, scanned, total } },
        });
      });
      if (cancelled()) return;

      this.state.phase = 'results';
      if (opts.sendInit) {
        this.post({ type: 'init', payload: toInitPayload(this.state) });
      } else {
        this.postTree();
        this.postState('results');
      }
    } catch (e) {
      if (e instanceof ScanCancelledError || cancelled()) return;
      this.state.phase = 'results';
      this.postError(e);
      this.postState('results');
    }
  }

  /* ── uri ↔ relPath ─────────────────────────────────────── */

  private relOf(uri: string): string {
    return this.state.uriToRel.get(uri) ?? uri;
  }

  private uriOf(rel: string): string {
    return this.state.relToUri.get(rel) ?? rel;
  }

  /** 命中集 H（第 3 层）：宿主按 matchTreeFilter 求，供批量/审阅/命中高亮使用。 */
  private hitRelPaths(): string[] {
    return this.state.allRelPaths.filter((p) => matchTreeFilter(p, this.state.filter));
  }

  /* ── onDidReceiveMessage 全消息分发 ─────────────────────── */

  private async onMessage(msg: WebviewToHost): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          await this.doScan({ refreshFiles: true, clearCache: true, sendInit: true });
          this.panelReady = true;
          for (const fn of this.readyQueue.splice(0)) fn();
          break;
        case 'setInstructions': this.onSetInstructions(msg.instructions); break;
        case 'setFilter': this.onSetFilter(msg.raw, msg.view); break;
        case 'setScope': this.onSetScope(msg.instructionId, msg.scope); break;
        case 'select': this.onSelect(msg.uri, msg.checked); break;
        case 'selectFolder': this.onSelectFolder(msg.checked, msg.visibleUris); break;
        case 'batch': this.onBatch(msg.op, msg.hits, msg.dir); break;
        case 'review': this.onReview(msg.action, msg.uri); break;
        case 'setGlob': this.onSetGlob(msg.include, msg.exclude); break;
        case 'resetToGlob': this.onResetToGlob(); break;
        case 'scan': void this.doScan({ refreshFiles: true, clearCache: true, sendInit: false }); break;
        case 'cancelScan': this.cancelScan(); this.postState('input', '扫描已取消'); break;
        case 'previewAll':
          this.post({ type: 'preview', payload: { diffs: this.state.diffs } });
          break;
        case 'apply': await this.onApply(msg.uris, msg.confirmed); break;
        case 'openFile': await this.onOpenFile(msg.uri, msg.line); break;
        case 'importExpressionSet': await this.onImport(); break;
        case 'exportExpressionSet': await this.onExport(msg.data); break;
        case 'exportReport': await exportReport(this.state); break;
        case 'showReport': showReport((m) => this.post(m), this.state); break;
        case 'help': this.onHelp(); break;
        default: break;
      }
    } catch (e) {
      this.postError(e);
    }
  }

  private onSetInstructions(instructions: Instruction[]): void {
    this.state.instructions = instructions.map((i) => ({ ...i }));
    this.scheduleRescan(); // 指令变化 300ms 防抖重扫
  }

  private onSetScope(instructionId: string, scope: FileScope): void {
    const ins = this.state.instructions.find((i) => i.id === instructionId);
    if (!ins) return;
    ins.fileScope = scope;
    this.scheduleRescan(); // 扩展名策略变化触发重扫
  }

  private onSelect(uri: string, checked: boolean): void {
    setSelected(this.relOf(uri), checked, this.state.selection);
    this.state.equivalentGlob = buildEquivalentGlob(this.state);
    this.scheduleRescan();
  }

  private onSelectFolder(checked: boolean, visibleUris: string[]): void {
    for (const u of visibleUris) setSelected(this.relOf(u), checked, this.state.selection);
    this.state.equivalentGlob = buildEquivalentGlob(this.state);
    this.scheduleRescan();
  }

  /** §6.4 批量操作只作用于命中集 H 并写回 overrides。 */
  private onBatch(op: BatchOp, hits: string[], _dir?: string): void {
    const relHits = hits.map((h) => this.relOf(h));
    switch (op) {
      case 'selectAll':
      case 'deselectAll':
      case 'invert':
      case 'keepOnly':
        applyBatch(this.state.selection, relHits, this.state.allRelPaths, op);
        break;
      case 'selectDirHits':
        applyBatch(this.state.selection, relHits, this.state.allRelPaths, 'selectAll');
        break;
      case 'deselectDirHits':
        applyBatch(this.state.selection, relHits, this.state.allRelPaths, 'deselectAll');
        break;
      case 'clearFilter':
        // 恢复全量视图，勾选状态原样保留（不重扫、不改 overrides）
        this.state.filter = parseTreeFilter('', this.state.filter.view);
        this.state.selection.treeFilter = this.state.filter;
        recomputeFilter(this.state);
        this.state.equivalentGlob = buildEquivalentGlob(this.state);
        this.postTree();
        return;
      case 'onlyApplicable':
      case 'showAll':
        // 纯显示开关（UI 侧维护），宿主只回发当前树
        this.postTree();
        return;
      default:
        return;
    }
    this.state.equivalentGlob = buildEquivalentGlob(this.state);
    this.scheduleRescan();
  }

  private onSetFilter(raw: string, view: 'tree' | 'flat'): void {
    this.state.filter = parseTreeFilter(raw, view);
    this.state.selection.treeFilter = this.state.filter;
    if (this.state.review.active) {
      this.exitReview('筛选条件已变化，已退出逐个审阅，请重新进入。');
    }
    this.scheduleFilter(); // 150ms 防抖，仅重算命中高亮，不重新 findFiles
  }

  private onSetGlob(include: string[], exclude: string[]): void {
    resetToGlob(this.state.selection, include, exclude);
    this.state.selection.treeFilter = this.state.filter;
    this.state.equivalentGlob = buildEquivalentGlob(this.state);
    this.scheduleRescan();
  }

  private onResetToGlob(): void {
    clearOverrides(this.state.selection);
    this.state.equivalentGlob = buildEquivalentGlob(this.state);
    this.scheduleRescan();
  }

  /* ── 逐个审阅 §6.4 ─────────────────────────────────────── */

  private onReview(action: ReviewAction, _uri?: string): void {
    if (action === 'start') {
      const queue = reviewQueue(this.hitRelPaths());
      this.state.review = { active: queue.length > 0, index: 0, queue };
      this.postReview(queue.length ? undefined : '当前没有命中文件，无法进入逐个审阅。');
      return;
    }
    const step = reviewStep(
      this.state.selection,
      this.state.review.queue,
      this.state.review.index,
      action,
    );
    this.state.review = { active: step.active, index: step.index, queue: this.state.review.queue };
    this.state.equivalentGlob = buildEquivalentGlob(this.state);
    this.postReview();
    this.scheduleRescan(); // 每步即时写 overrides，与 glob 双向同步
  }

  private postReview(message?: string): void {
    const r = this.state.review;
    const payload: ReviewPayload = { active: r.active, index: r.index, total: r.queue.length };
    if (message) payload.message = message;
    if (r.active && r.queue.length > 0) {
      const rel = r.queue[Math.min(r.index, r.queue.length - 1)];
      const uri = this.uriOf(rel);
      const rec = this.state.records.get(uri);
      const diff = this.state.diffs.find((d) => d.uri === uri);
      payload.item = {
        uri,
        path: rel,
        ext: rec?.ext ?? '',
        instructionCount: rec?.instructionCount ?? 0,
        changeCount: rec?.changeCount ?? 0,
        ...(diff ? { diff } : {}),
      };
    } else if (!r.active && !message) {
      payload.message = '逐个审阅已结束。';
    }
    this.post({ type: 'review', payload });
  }

  private exitReview(message: string): void {
    this.state.review = { active: false, index: 0, queue: [] };
    this.post({ type: 'review', payload: { active: false, index: 0, total: 0, message } });
    this.postState(this.state.phase, message);
  }

  /* ── 应用 §7.5 ─────────────────────────────────────────── */

  private async onApply(uris: string[], confirmed: boolean): Promise<void> {
    if (!uris.length) {
      this.post({ type: 'error', payload: { message: '请先选择文件范围' } });
      return;
    }
    this.state.phase = 'applying';
    this.postState('applying');
    try {
      const cfg = readConfig();
      const result = await applyChanges(this.state, cfg, uris, confirmed);
      const report = buildReport(this.state, result.appliedUris, result.changes, result.hashSkips);
      this.state.lastReport = report;
      this.textCache.clear(); // 文件已变更，缓存失效
      this.state.phase = 'report';
      this.post({ type: 'report', payload: report });
      const toast = `已修改 ${result.appliedUris.length} 个文件 · ${result.changes} 处变更`;
      this.postState('report', toast);
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}：${toast}`);
    } catch (e) {
      this.state.phase = 'results';
      this.postError(e);
      this.postState('results');
    }
  }

  /* ── 其余 Webview 消息 ─────────────────────────────────── */

  private async onOpenFile(uri: string, line?: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    const options: vscode.TextDocumentShowOptions = {};
    if (line && line > 0) {
      const pos = new vscode.Position(line - 1, 0);
      options.selection = new vscode.Range(pos, pos);
    }
    await vscode.window.showTextDocument(doc, options);
  }

  private async onImport(): Promise<void> {
    const result = await importExpressionSet();
    if (!result) return;
    applyExpressionSet(this.state, result.set);
    this.textCache.clear();
    if (result.warnings.length) {
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}：${result.warnings.join(' ')}`);
    }
    await this.doScan({ refreshFiles: true, clearCache: true, sendInit: true });
  }

  private async onExport(data: unknown): Promise<void> {
    const result = await exportExpressionSet(data);
    if (!result) return;
    void vscode.window.showInformationMessage(
      result.warnings.length
        ? `${DISPLAY_NAME}：${result.warnings.join(' ')}`
        : `${DISPLAY_NAME}：表达式集已导出。`,
    );
  }

  private onHelp(): void {
    void vscode.window.showInformationMessage(
      `${DISPLAY_NAME}：在「指令」区添加结构化(JSON/YAML)或文本(sed 风格)替换；` +
      '在「文件范围」区用筛选条件与树勾选收敛范围；预览 Diff 后点「应用」，一次 Ctrl+Z 可整体撤销。',
    );
  }

  /* ── 7 个命令（附录 B） ────────────────────────────────── */

  /** 把一条新指令并入会话：新面板由 ready 的扫描带出，已有面板重发 init 刷新指令区。 */
  private async pushInstructionAndRefresh(ins: Instruction): Promise<void> {
    this.state.instructions.push(ins);
    const { created } = await this.ensurePanel();
    if (created) return;
    this.afterReady(() => {
      this.post({ type: 'init', payload: toInitPayload(this.state) });
      void this.doScan({ refreshFiles: false, clearCache: false, sendInit: false });
    });
  }

  async commandOpenPanel(): Promise<void> {
    const { panel, created } = await this.ensurePanel();
    panel.reveal();
    if (!created) this.afterReady(() => this.post({ type: 'init', payload: toInitPayload(this.state) }));
  }

  /** 编辑器右键：把光标处键名填入一条新的结构化指令（简化：取光标标识符为路径）。 */
  async commandUseCursorPath(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}：请先打开 JSON/YAML 文件并把光标放到目标键上。`);
      return;
    }
    const isYaml = /\.ya?ml$/i.test(editor.document.fileName);
    const isJson = /\.jsonc?$/i.test(editor.document.fileName);
    if (!isYaml && !isJson) {
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}：该命令仅支持 .json/.jsonc/.yaml/.yml 文件。`);
      return;
    }
    const format: 'json' | 'yaml' = isYaml ? 'yaml' : 'json';
    const key = this.cursorKey(editor);
    const ins: Instruction = {
      id: genInsId(),
      enabled: true,
      engine: 'structured',
      fileScope: { mode: 'fixed', format },
      format,
      kind: 'set',
      path: key ? pathToString([key]) : '$',
      value: '',
      scope: 'all',
    };
    await this.pushInstructionAndRefresh(ins);
  }

  private cursorKey(editor: vscode.TextEditor): string {
    const doc = editor.document;
    const sel = editor.selection;
    let raw = '';
    if (!sel.isEmpty) {
      raw = doc.getText(sel).trim().split(/[\s:]+/)[0] ?? '';
    } else {
      const range = doc.getWordRangeAtPosition(sel.active, /[A-Za-z0-9_.$@\-/]+/);
      if (range) raw = doc.getText(range);
    }
    return raw.replace(/^["']|["']$/g, '');
  }

  /** 编辑器右键：把选区转义成 JS RegExp 源文本，预填一条文本替换指令。 */
  async commandUseSelectionAsPattern(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}：请先选中一段文本。`);
      return;
    }
    let text = editor.document.getText(editor.selection).trim();
    if (!text) {
      const range = editor.document.getWordRangeAtPosition(editor.selection.active);
      if (range) text = editor.document.getText(range).trim();
    }
    if (!text) {
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}：请先选中一段文本作为匹配模式。`);
      return;
    }
    const ins: Instruction = {
      id: genInsId(),
      enabled: true,
      engine: 'text',
      fileScope: { mode: 'all' },
      textOp: 'replace',
      pattern: escapeRegExp(text),
      replacement: '',
      flags: 'g',
    };
    await this.pushInstructionAndRefresh(ins);
  }

  /** 直接应用某个 .structedit.json：导入 → 重扫 → 应用到全部勾选文件。 */
  async commandApplyFile(): Promise<void> {
    const result = await importExpressionSet();
    if (!result) return;
    applyExpressionSet(this.state, result.set);
    this.textCache.clear();
    await this.ensurePanel();
    await this.doScan({ refreshFiles: true, clearCache: true, sendInit: true });
    const uris = this.state.flat.filter((f) => f.checked).map((f) => f.uri);
    if (!uris.length) {
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}：表达式集未匹配到可应用的文件。`);
      return;
    }
    await this.onApply(uris, true);
  }

  async commandShowReport(): Promise<void> {
    await this.ensurePanel();
    this.afterReady(() => showReport((m) => this.post(m), this.state));
  }

  /** 后两者：转发 command 给面板（UI 忽略未知 type）+ 宿主侧真正执行。 */
  async commandSelectAllMatches(): Promise<void> {
    await this.ensurePanel();
    this.afterReady(() => {
      this.postCommand('selectAllMatches');
      const hits = this.hitRelPaths();
      applyBatch(this.state.selection, hits, this.state.allRelPaths, 'selectAll');
      this.state.equivalentGlob = buildEquivalentGlob(this.state);
      this.postState(this.state.phase, `已全选 ${hits.length} 个命中文件`);
      void this.doScan({ refreshFiles: false, clearCache: false, sendInit: false });
    });
  }

  async commandSequentialReview(): Promise<void> {
    await this.ensurePanel();
    this.afterReady(() => {
      this.postCommand('sequentialReview');
      this.onReview('start');
    });
  }
}

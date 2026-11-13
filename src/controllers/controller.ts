/**
 * 宿主层总控：WebviewPanel 生命周期、§8.2 状态机、onDidReceiveMessage 全消息分发、
 * 懒加载扫描（首屏不扫描）、轻量重算、扫描取消、命令（附录 B）。
 *
 * 所有写回必须走 workspace.applyEdit(WorkspaceEdit)（§4.4 原则 2），由 apply.ts 完成。
 * 协议约定：selectAllMatches / sequentialReview 以 { type:'command', command } 转发给面板，
 * UI 端会忽略未知 type；宿主侧同时真正执行并回写 tree/review，保证功能可用。
 */

import * as vscode from 'vscode';
import {
  applyBatch, clearOverrides, extOf, matchTreeFilter, parseTreeFilter, pathToString,
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

interface WebviewClient {
  webview: vscode.Webview;
  ready: boolean;
  queue: Array<() => void>;
  disposables: vscode.Disposable[];
}

export class PanelController {
  private readonly context: vscode.ExtensionContext;
  private readonly extensionUri: vscode.Uri;
  private readonly state: HostState = createInitialState();
  private readonly textCache = new Map<string, TextCacheEntry>();

  private panel: vscode.WebviewPanel | undefined;
  private readonly clients = new Set<WebviewClient>();
  private scanTimer: ReturnType<typeof setTimeout> | undefined;
  private filterTimer: ReturnType<typeof setTimeout> | undefined;
  private scanGeneration = 0;
  private scanCts: vscode.CancellationTokenSource | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.extensionUri = context.extensionUri;
  }

  /* ── 消息发送 / 错误 ─────────────────────────────────────── */

  /** 广播给所有已就绪的 Webview；未就绪的客户端在 ready 时统一发 init。 */
  private post(msg: HostToWebview): number {
    let delivered = 0;
    for (const client of this.clients) {
      if (!client.ready) continue;
      void client.webview.postMessage(msg);
      delivered += 1;
    }
    return delivered;
  }

  private postTo(client: WebviewClient, msg: HostToWebview): void {
    void client.webview.postMessage(msg);
  }

  /** 命令/消息统一错误出口：不静默吞掉，回发 {type:'error'}。 */
  postError(e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    const delivered = this.post({
      type: 'error',
      payload: { message: err.message, detail: err.stack },
    });
    if (!delivered) {
      void vscode.window.showErrorMessage(`${DISPLAY_NAME}：${err.message}`);
    }
  }

  private postState(phase: HostState['phase'], message?: string): void {
    this.post({
      type: 'state',
      payload: {
        phase,
        counts: this.state.counts,
        scopeRoot: this.state.scopeRoot,
        ...(message ? { message } : {}),
      },
    });
  }

  private postTree(): void {
    this.post({ type: 'tree', payload: toTreePayload(this.state) });
  }

  /** 协议约定转发：HostToWebview 未定义 command 类型，UI 端忽略未知 type。 */
  private postCommand(command: string): void {
    this.post({ type: 'command', command } as unknown as HostToWebview);
  }

  /* ── Webview 生命周期（编辑器面板 + 侧边栏视图共用） ─────── */

  private attachWebview(webview: vscode.Webview): WebviewClient {
    const client: WebviewClient = {
      webview, ready: false, queue: [], disposables: [],
    };
    client.disposables.push(webview.onDidReceiveMessage((msg: WebviewToHost) => {
      void this.onMessage(msg, client);
    }));
    this.clients.add(client);
    return client;
  }

  private detachClient(client: WebviewClient): void {
    client.ready = false;
    client.queue = [];
    for (const d of client.disposables.splice(0)) d.dispose();
    this.clients.delete(client);
    this.panel = undefined;
    // 面板关闭时停止扫描并释放缓存。
    if (this.clients.size === 0) {
      this.cancelScan();
      this.textCache.clear();
    }
  }

  private panelClient(): WebviewClient | undefined {
    return this.clients.values().next().value as WebviewClient | undefined;
  }

  private async createPanelClient(): Promise<WebviewClient> {
    const existing = this.panelClient();
    if (existing) return existing;
    const panel = createPanel();
    this.panel = panel;
    const client = this.attachWebview(panel.webview);
    panel.onDidDispose(() => this.detachClient(client), undefined, this.context.subscriptions);
    this.context.subscriptions.push(panel);
    panel.webview.html = await buildHtml(panel.webview, this.extensionUri);
    return client;
  }

  /** 命令入口：复用已打开的编辑器面板，否则新建。 */
  private async ensureClient(): Promise<{ client: WebviewClient; created: boolean }> {
    const panel = this.panelClient();
    if (panel) { this.panel?.reveal(); return { client: panel, created: false }; }
    return { client: await this.createPanelClient(), created: true };
  }

  private waitReady(client: WebviewClient): Promise<void> {
    if (client.ready) return Promise.resolve();
    return new Promise<void>((resolve) => { client.queue.push(resolve); });
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

  /**
   * 轻量重算（默认路径）：不 findFiles、不重复读盘（复用文本缓存），
   * 只对已加载的文件列表重跑「指令 → 补丁」。勾选 / 筛选 / 指令编辑都走这里，
   * 避免超大仓库里每次点击都全量扫描。
   */
  private async recomputePlans(): Promise<void> {
    if (!this.state.entries.length) {
      this.postState('input', '请先在「① 选择文件」点「扫描文件」载入文件列表。');
      return;
    }
    const cfg = readConfig();
    const gen = ++this.scanGeneration;
    const cancelled = (): boolean => gen !== this.scanGeneration;
    try {
      await runScan(this.state, cfg, this.textCache, cancelled);
      if (cancelled()) return;
      this.state.phase = 'results';
      this.postTree();
      this.postState('results');
    } catch (e) {
      if (e instanceof ScanCancelledError || cancelled()) return;
      this.state.phase = 'results';
      this.postError(e);
      this.postState('results');
    }
  }

  private scheduleRecompute(delay = 200): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      void this.recomputePlans();
    }, delay);
  }

  /**
   * 有挂起的轻量重算时立刻执行（previewAll / apply 前调用）。
   * UI 侧 setInstructions → 200ms 防抖窗口内若用户直接点预览/应用，
   * 否则会用上一版指令的补丁出 diff、写文件（反馈「修改值后不起效」）。
   */
  private async flushRecompute(): Promise<void> {
    if (!this.scanTimer) return;
    clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    await this.recomputePlans();
  }

  private scheduleFilter(): void {
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => {
      this.filterTimer = undefined;
      recomputeFilter(this.state);
      this.postTree();
    }, 150);
  }

  /** 显式扫描：用户点「扫描文件」→ findFiles → runScan → tree/state，含进度与取消。 */
  private async doScan(opts: ScanOptions): Promise<void> {
    // 取消仍在进行的扫描（generation + findFiles token），避免旧结果覆盖新状态。
    this.scanCts?.cancel();
    this.scanCts?.dispose();
    this.scanCts = undefined;
    const gen = ++this.scanGeneration;
    const cancelled = (): boolean => gen !== this.scanGeneration;

    const cfg = readConfig();
    // 没有文件列表且不是显式刷新 → 无效扫描，直接提示（页面首屏完全不扫描）。
    if (!opts.refreshFiles && this.state.entries.length === 0) {
      this.postState('input', '请先在「① 选择文件」设定范围并点「扫描文件」。');
      return;
    }

    this.state.phase = 'scanning';
    this.post({
      type: 'state',
      payload: {
        phase: 'scanning',
        counts: { ...this.state.counts, scanned: 0, total: this.state.entries.length },
      },
    });

    try {
      if (opts.refreshFiles) {
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
      const truncMsg = this.state.listTruncated
        ? `文件数已达到上限 ${cfg.maxFiles}，列表可能不完整；请用筛选条件缩小范围，或在设置中调高 batchReplace.maxFiles。`
        : undefined;
      if (opts.sendInit) {
        this.post({ type: 'init', payload: toInitPayload(this.state) });
        if (truncMsg) this.postState('results', truncMsg);
      } else {
        this.postTree();
        this.postState('results', truncMsg);
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

  private async onMessage(msg: WebviewToHost, client: WebviewClient): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': {
          if (client.ready) return;
          client.ready = true;
          // 懒加载：首屏绝不 findFiles / 读盘，只下发空 init + input 态提示。
          // 用户设定目录与过滤条件后，由「扫描文件」按钮的 scan 消息触发唯一一次扫描。
          this.postTo(client, { type: 'init', payload: toInitPayload(this.state) });
          this.postTo(client, {
            type: 'state',
            payload: {
              phase: 'input',
              counts: this.state.counts,
              message: '页面已就绪，尚未扫描任何文件。请在「① 选择文件」设定范围后点「扫描文件」。',
            },
          });
          for (const fn of client.queue.splice(0)) fn();
          break;
        }
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
        case 'pickDirectory': await this.onPickDirectory(); break;
        case 'resetScopeRoot': this.onResetScopeRoot(); break;
        case 'previewAll':
          // 应用/预览前先把「未落定的指令编辑」立即重算，避免拿到过期 diff（0.1.3 反馈：改值后不起效）。
          await this.flushRecompute();
          this.post({ type: 'preview', payload: { diffs: this.state.diffs } });
          break;
        case 'apply':
          await this.flushRecompute();
          await this.onApply(msg.uris, msg.confirmed);
          break;
        case 'openFile': await this.onOpenFile(msg.uri, msg.line); break;
        case 'previewFile': await this.onPreviewFile(msg.uri, msg.path); break;
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
    this.scheduleRecompute(); // 指令变化：只对已加载列表轻量重算
  }

  private onSetScope(instructionId: string, scope: FileScope): void {
    const ins = this.state.instructions.find((i) => i.id === instructionId);
    if (!ins) return;
    ins.fileScope = scope;
    this.scheduleRecompute(); // 扩展名策略变化：轻量重算补丁
  }

  private onSelect(uri: string, checked: boolean): void {
    setSelected(this.relOf(uri), checked, this.state.selection);
    this.state.equivalentGlob = buildEquivalentGlob(this.state);
    this.scheduleRecompute();
  }

  private onSelectFolder(checked: boolean, visibleUris: string[]): void {
    for (const u of visibleUris) setSelected(this.relOf(u), checked, this.state.selection);
    this.state.equivalentGlob = buildEquivalentGlob(this.state);
    this.scheduleRecompute();
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
    this.scheduleRecompute();
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
    this.scheduleRecompute();
    this.postState(this.state.phase, '文件范围已更新；点「扫描文件」可按新范围重新载入列表。');
  }

  private onResetToGlob(): void {
    clearOverrides(this.state.selection);
    this.state.equivalentGlob = buildEquivalentGlob(this.state);
    this.scheduleRecompute();
    this.postState(this.state.phase, '已重置为 glob；点「扫描文件」可重新载入列表。');
  }

  /* ── 选择目录（bug1）：默认工作区根目录，可弹窗改到任意目录 ── */

  /** 弹出目录选择框；选定后以该目录为扫描根立即重扫（可选工作区之外的目录）。 */
  private async onPickDirectory(): Promise<void> {
    const defaultPath = this.state.scopeRoot
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '选择扫描根目录',
      ...(defaultPath ? { defaultPath } : {}),
    });
    const dir = picked?.[0]?.fsPath;
    if (!dir) return; // 用户取消：范围保持不变
    this.state.scopeRoot = dir;
    this.textCache.clear();
    await this.doScan({ refreshFiles: true, clearCache: true, sendInit: false });
    this.postState(this.state.phase, `扫描根目录已切换为：${dir}`);
  }

  /** 恢复默认：以 VS Code 打开的工作区根目录扫描。 */
  private onResetScopeRoot(): void {
    if (!this.state.scopeRoot) return;
    this.state.scopeRoot = null;
    this.textCache.clear();
    void this.doScan({ refreshFiles: true, clearCache: true, sendInit: false })
      .then(() => this.postState(this.state.phase, '已恢复以工作区根目录扫描。'));
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
    this.scheduleRecompute(); // 每步即时写 overrides，与 glob 双向同步
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

  /** 双击文件行：只读预览源文件（带大小/截断保护），不改文件、不触发扫描。 */
  private async onPreviewFile(uriOrPath: string, relPath: string): Promise<void> {
    const uriStr = this.uriOf(uriOrPath) || uriOrPath;
    const ext = extOf(relPath || uriStr);
    let text = '';
    let truncated = false;
    let error: string | undefined;
    try {
      const uri = vscode.Uri.parse(uriStr);
      const st = await vscode.workspace.fs.stat(uri);
      const MAX_BYTES = 2 * 1024 * 1024;
      if (st.size > MAX_BYTES) {
        error = `文件 ${(st.size / 1024 / 1024).toFixed(1)} MB 超过预览上限（2 MB），请用「在编辑器中打开」查看。`;
      } else {
        const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriStr);
        // 已打开的文档用 getText() 含未保存内容；fatal:false 避免非 UTF-8 直接抛错。
        const full = open
          ? open.getText()
          : new TextDecoder('utf-8', { fatal: false }).decode(await vscode.workspace.fs.readFile(uri));
        const LIMIT = 128 * 1024;
        if (full.length > LIMIT) {
          text = full.slice(0, LIMIT);
          truncated = true;
        } else {
          text = full;
        }
      }
    } catch (e) {
      error = `读取失败：${(e as Error).message}`;
    }
    this.post({
      type: 'fileContent',
      payload: {
        uri: uriStr,
        path: relPath || uriStr,
        ext,
        text,
        truncated,
        ...(error ? { error } : {}),
      },
    });
  }

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

  /** 把一条新指令并入会话：右键命令是显式用户动作，主动按新 fileScope 扫描一次。 */
  private async pushInstructionAndRefresh(ins: Instruction): Promise<void> {
    this.state.instructions.push(ins);
    const { client, created } = await this.ensureClient();
    await this.waitReady(client);
    await this.doScan({ refreshFiles: true, clearCache: false, sendInit: false });
    if (!created) this.postTo(client, { type: 'init', payload: toInitPayload(this.state) });
  }

  async commandOpenPanel(): Promise<void> {
    if (this.panel) { this.panel.reveal(); return; }
    await this.createPanelClient();
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
    const { client } = await this.ensureClient();
    await this.waitReady(client);
    await this.doScan({ refreshFiles: true, clearCache: true, sendInit: true });
    const uris = this.state.flat.filter((f) => f.checked).map((f) => f.uri);
    if (!uris.length) {
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}：表达式集未匹配到可应用的文件。`);
      return;
    }
    await this.onApply(uris, true);
  }

  async commandShowReport(): Promise<void> {
    const { client } = await this.ensureClient();
    await this.waitReady(client);
    showReport((m) => this.post(m), this.state);
  }

  /** 后两者：转发 command 给面板（UI 忽略未知 type）+ 宿主侧真正执行。 */
  async commandSelectAllMatches(): Promise<void> {
    const { client } = await this.ensureClient();
    await this.waitReady(client);
    this.postCommand('selectAllMatches');
    const hits = this.hitRelPaths();
    applyBatch(this.state.selection, hits, this.state.allRelPaths, 'selectAll');
    this.state.equivalentGlob = buildEquivalentGlob(this.state);
    this.postState(this.state.phase, `已全选 ${hits.length} 个命中文件`);
    this.scheduleRecompute();
  }

  async commandSequentialReview(): Promise<void> {
    const { client } = await this.ensureClient();
    await this.waitReady(client);
    this.postCommand('sequentialReview');
    this.onReview('start');
  }
}


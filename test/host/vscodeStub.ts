/**
 * 最小可用的 `vscode` API 桩，供纯 Node 环境跑真实宿主管线（controllers/**）。
 *
 * 用法（见 flow.test.ts）：通过 module.registerHooks 把 `import 'vscode'`
 * 重定向到本文件，于是 scan.ts / apply.ts / controller.ts 全部跑真实逻辑，
 * 只有「磁盘 / Webview / 弹窗」三处被替换成可控实现：
 *   - 磁盘：真实的临时工作区目录（test/testdata/**，已在 .gitignore 内），
 *           findFiles 按真实 glob 在其上递归扫描；applyEdit 直接写回磁盘。
 *   - Webview：postMessage 记入 hostMessages 并回调 uiDeliver（测试接到 jsdom）；
 *           Webview→Host 走 webviewHandler（由 PanelController 注册）。
 *   - 弹窗：showOpenDialog 返回 stubState.openDialogResult。
 *
 * 单例性：本文件既是测试直接 import 的模块，也是被 hook 解析的 'vscode'，
 * 两者 URL 完全一致 → 同一模块实例、同一份 stubState。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { globToRegExp } from '../../src/core/extensionPolicy.ts';

/* ── 单例状态 ─────────────────────────────────────────────── */

export interface FindFilesCall {
  include: unknown;
  exclude: unknown;
  maxResults: unknown;
  /** include 是 RelativePattern 时的 base（否则为 null）。 */
  base: string | null;
}

export interface StubState {
  /** workspaceFolders（默认扫描根目录 = VS Code 打开的目录）。 */
  roots: string[];
  /** showOpenDialog 返回值（路径字符串或 Uri，均接受）。 */
  openDialogResult: Array<string | { fsPath: string }> | undefined;
  openDialogCalls: Array<Record<string, unknown>>;
  findFilesCalls: FindFilesCall[];
  infoMessages: string[];
  errorMessages: string[];
  /** Host → Webview 消息全量记录。 */
  hostMessages: Array<Record<string, unknown>>;
  /** 测试注入：把宿主消息投递进 jsdom window。 */
  uiDeliver: ((msg: Record<string, unknown>) => void) | null;
  /** PanelController 注册：Webview 消息入口。 */
  webviewHandler: ((msg: Record<string, unknown>) => void) | null;
  queuedToHost: Array<Record<string, unknown>>;
  /** 最近一次 webview.html（buildHtml 的产物）。 */
  lastWebviewHtml: string;
  panelCount: number;
  config: Record<string, unknown>;
  applyEditCalls: number;
}

export const stubState: StubState = {
  roots: [],
  openDialogResult: undefined,
  openDialogCalls: [],
  findFilesCalls: [],
  infoMessages: [],
  errorMessages: [],
  hostMessages: [],
  uiDeliver: null,
  webviewHandler: null,
  queuedToHost: [],
  lastWebviewHtml: '',
  panelCount: 0,
  config: {},
  applyEditCalls: 0,
};

export function resetStub(opts: { roots: string[] }): void {
  stubState.roots = opts.roots.map((r) => path.resolve(r));
  stubState.openDialogResult = undefined;
  stubState.openDialogCalls = [];
  stubState.findFilesCalls = [];
  stubState.infoMessages = [];
  stubState.errorMessages = [];
  stubState.hostMessages = [];
  stubState.uiDeliver = null;
  stubState.webviewHandler = null;
  stubState.queuedToHost = [];
  stubState.lastWebviewHtml = '';
  stubState.panelCount = 0;
  stubState.config = {};
  stubState.applyEditCalls = 0;
  openDocs.clear();
}

/** UI（jsdom）→ Host。 */
export function uiToHost(msg: Record<string, unknown>): void {
  if (stubState.webviewHandler) stubState.webviewHandler(msg);
  else stubState.queuedToHost.push(msg);
}

/** Host → UI（jsdom）。 */
export function hostToUi(msg: Record<string, unknown>): void {
  stubState.hostMessages.push(msg);
  if (stubState.uiDeliver) stubState.uiDeliver(msg);
}

export function flushQueuedToHost(): void {
  while (stubState.queuedToHost.length && stubState.webviewHandler) {
    const m = stubState.queuedToHost.shift()!;
    stubState.webviewHandler(m);
  }
}

/* ── Uri ──────────────────────────────────────────────────── */

class UriImpl {
  readonly scheme: string;
  readonly fsPath: string;

  private constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
  }

  static file(p: string): UriImpl {
    return new UriImpl('file', path.resolve(p));
  }

  static parse(s: string): UriImpl {
    if (s.startsWith('file://')) {
      return new UriImpl('file', decodeURIComponent(s.slice('file://'.length)));
    }
    const idx = s.indexOf(':');
    if (idx > 1) return new UriImpl(s.slice(0, idx), s.slice(idx + 1));
    return new UriImpl('file', path.resolve(s));
  }

  static joinPath(base: UriImpl, ...segments: string[]): UriImpl {
    return new UriImpl(base.scheme, path.resolve(base.fsPath, ...segments));
  }

  get path(): string { return this.fsPath; }

  toString(): string {
    return this.scheme === 'file' ? `file://${this.fsPath}` : `${this.scheme}:${this.fsPath}`;
  }
}

/* ── 位置 / 编辑 ──────────────────────────────────────────── */

// 注意：test/** 由 node 原生类型剥离执行，禁止 TS parameter property / enum 等非擦除语法。
export class Position {
  readonly line: number;
  readonly character: number;
  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(start: Position, end: Position) {
    this.start = start;
    this.end = end;
  }
}

export class TextEdit {
  readonly range: Range;
  readonly newText: string;
  private constructor(range: Range, newText: string) {
    this.range = range;
    this.newText = newText;
  }
  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }
}

export class WorkspaceEdit {
  private readonly entries = new Map<string, Array<{ uri: UriImpl; edits: TextEdit[] }>>();

  set(uri: UriImpl, edits: TextEdit[]): void {
    this.entries.set(uri.toString(), [{ uri, edits }]);
  }

  get(uriStr: string): TextEdit[] {
    return this.entries.get(uriStr)?.[0]?.edits ?? [];
  }

  files(): Array<{ uri: UriImpl; edits: TextEdit[] }> {
    return [...this.entries.values()].flat();
  }
}

/* ── 文本文档 ─────────────────────────────────────────────── */

const openDocs = new Map<string, TextDocumentImpl>();

export class TextDocumentImpl {
  readonly uri: UriImpl;
  private text: string;

  constructor(uri: UriImpl, text: string) {
    this.uri = uri;
    this.text = text;
  }

  getText(): string { return this.text; }
  setText(t: string): void { this.text = t; }

  positionAt(offset: number): Position {
    const o = Math.max(0, Math.min(offset, this.text.length));
    let line = 0;
    let last = 0;
    for (let i = 0; i < o; i += 1) {
      if (this.text.charCodeAt(i) === 10) { line += 1; last = i + 1; }
    }
    return new Position(line, o - last);
  }

  offsetAt(pos: Position): number {
    const lines = this.text.split('\n');
    let off = 0;
    for (let i = 0; i < pos.line && i < lines.length; i += 1) off += lines[i].length + 1;
    return off + pos.character;
  }

  async save(): Promise<boolean> {
    fs.writeFileSync(this.uri.fsPath, this.text, 'utf8');
    return true;
  }
}

/* ── RelativePattern / CancellationToken ──────────────────── */

export class RelativePattern {
  readonly base: string;
  readonly pattern: string;

  constructor(base: string | UriImpl | { uri: UriImpl }, pattern: string) {
    if (typeof base === 'string') this.base = path.resolve(base);
    else if (base instanceof UriImpl) this.base = base.fsPath;
    else this.base = base.uri.fsPath;
    this.pattern = pattern;
  }
}

export class CancellationToken {
  isCancellationRequested = false;
  onCancellationRequested(): { dispose(): void } { return { dispose() {} }; }
}

export class CancellationTokenSource {
  token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  };
  cancel(): void { this.token.isCancellationRequested = true; }
  dispose(): void {}
}

export class Disposable {
  private readonly fn: () => void;
  constructor(fn: () => void) { this.fn = fn; }
  dispose(): void { this.fn(); }
  static from(...items: Array<{ dispose(): void }>): Disposable {
    return new Disposable(() => items.forEach((i) => i.dispose()));
  }
}

/* ── glob 工具（findFiles 用） ────────────────────────────── */

/** 只展开一层顶层 `{a,b}`（宿主默认 exclude 与 include 都是这种写法）。 */
function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  const before = pattern.slice(0, m.index);
  const after = pattern.slice(m.index + m[0].length);
  const out: string[] = [];
  for (const alt of m[1].split(',')) {
    for (const expanded of expandBraces(before + alt + after)) out.push(expanded);
  }
  return out;
}

function compile(patterns: string): RegExp[] {
  return patterns ? expandBraces(patterns).map((p) => globToRegExp(p)) : [];
}

function walk(
  base: string,
  inc: RegExp[],
  exc: RegExp[],
  max: number,
  out: UriImpl[],
): void {
  if (out.length >= max) return;
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of names) {
    if (out.length >= max) return;
    const abs = path.join(base, ent.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (ent.isDirectory()) {
      if (exc.some((r) => r.test(rel) || r.test(`${rel}/`))) continue;
      walk(abs, inc, exc, max, out);
    } else if (ent.isFile()) {
      if (exc.some((r) => r.test(rel))) continue;
      if (inc.length && !inc.some((r) => r.test(rel))) continue;
      out.push(UriImpl.file(abs));
    }
  }
}

function findFilesImpl(
  include: string | RelativePattern,
  exclude?: string | null,
  maxResults?: number,
  token?: { isCancellationRequested: boolean },
): UriImpl[] {
  const max = maxResults && maxResults > 0 ? maxResults : 1000;
  const pattern = include instanceof RelativePattern ? include.pattern : include;
  const baseList = include instanceof RelativePattern ? [include.base] : stubState.roots;
  const inc = compile(pattern);
  const exc = compile(exclude ?? '');
  const out: UriImpl[] = [];
  stubState.findFilesCalls.push({
    include: include instanceof RelativePattern ? include.pattern : include,
    exclude: exclude ?? null,
    maxResults: maxResults ?? null,
    base: include instanceof RelativePattern ? include.base : null,
  });
  for (const base of baseList) {
    if (token?.isCancellationRequested) break;
    walk(base, inc, exc, max, out);
  }
  out.sort((a, b) => (a.fsPath < b.fsPath ? -1 : a.fsPath > b.fsPath ? 1 : 0));
  return out.slice(0, max);
}

/* ── vscode 命名空间导出 ──────────────────────────────────── */

export const Uri = UriImpl;
export type Uri = UriImpl;
export type WorkspaceFolder = { uri: UriImpl; name: string; index: number };

export const ViewColumn = { One: 1, Two: 2, Active: -1 };

export const workspace = {
  get workspaceFolders(): WorkspaceFolder[] {
    return stubState.roots.map((r, i) => ({
      uri: UriImpl.file(r), name: path.basename(r), index: i,
    }));
  },

  get textDocuments(): TextDocumentImpl[] {
    return [...openDocs.values()];
  },

  getWorkspaceFolder(uri: UriImpl): WorkspaceFolder | undefined {
    const hit = stubState.roots.findIndex(
      (r) => uri.fsPath === r || uri.fsPath.startsWith(r + path.sep),
    );
    if (hit < 0) return undefined;
    return { uri: UriImpl.file(stubState.roots[hit]), name: path.basename(stubState.roots[hit]), index: hit };
  },

  findFiles: findFilesImpl,

  getConfiguration(section?: string) {
    return {
      get<T>(key: string, defaultValue: T): T {
        const full = `${section ? `${section}.` : ''}${key}`;
        return (stubState.config[full] as T) ?? defaultValue;
      },
      has(key: string): boolean {
        return `${section ? `${section}.` : ''}${key}` in stubState.config;
      },
      update(): Promise<void> { return Promise.resolve(); },
    };
  },

  async openTextDocument(uri: UriImpl | string): Promise<TextDocumentImpl> {
    const u = typeof uri === 'string' ? UriImpl.parse(uri) : uri;
    const key = u.toString();
    const existing = openDocs.get(key);
    if (existing) return existing;
    const text = fs.readFileSync(u.fsPath, 'utf8');
    const doc = new TextDocumentImpl(u, text);
    openDocs.set(key, doc);
    return doc;
  },

  async applyEdit(we: WorkspaceEdit): Promise<boolean> {
    stubState.applyEditCalls += 1;
    // 从后往前套用补丁，避免同一文件内偏移错乱。
    for (const { uri, edits } of we.files()) {
      const doc = await workspace.openTextDocument(uri);
      const sorted = [...edits].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start));
      let text = doc.getText();
      for (const e of sorted) {
        const s = doc.offsetAt(e.range.start);
        const t = doc.offsetAt(e.range.end);
        text = text.slice(0, s) + e.newText + text.slice(t);
      }
      doc.setText(text);
      fs.writeFileSync(uri.fsPath, text, 'utf8');
    }
    return true;
  },

  fs: {
    async readFile(uri: UriImpl): Promise<Uint8Array> {
      // buildHtml 读 dist/ui/panel.html；测试环境可能还没跑 build，回退到 src 模板。
      let p = uri.fsPath;
      if (p.endsWith(`${path.sep}dist${path.sep}ui${path.sep}panel.html`) && !fs.existsSync(p)) {
        p = p.replace(`${path.sep}dist${path.sep}ui${path.sep}panel.html`, `${path.sep}src${path.sep}ui${path.sep}panel.html`);
      }
      const buf = fs.readFileSync(p);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    async stat(uri: UriImpl): Promise<{ size: number; type: string }> {
      const st = fs.statSync(uri.fsPath);
      return { size: st.size, type: st.isDirectory() ? 'Directory' : 'File' };
    },
    async writeFile(uri: UriImpl, content: Uint8Array): Promise<void> {
      fs.writeFileSync(uri.fsPath, content);
    },
    async delete(uri: UriImpl): Promise<void> {
      fs.rmSync(uri.fsPath, { recursive: true, force: true });
    },
  },
};

export const window = {
  activeTextEditor: undefined as unknown,
  createWebviewPanel(
    _viewType: string,
    _title: string,
    _column: unknown,
    _options: unknown,
  ) {
    stubState.panelCount += 1;
    let html = '';
    const webview = {
      cspSource: 'https://vscode-resource.example',
      asWebviewUri: (u: UriImpl) => u,
      get html(): string { return html; },
      set html(v: string) { html = v; stubState.lastWebviewHtml = v; },
      onDidReceiveMessage(cb: (msg: Record<string, unknown>) => void): { dispose(): void } {
        stubState.webviewHandler = (m) => { void cb(m); };
        return { dispose() { if (stubState.webviewHandler) stubState.webviewHandler = null; } };
      },
      postMessage(msg: Record<string, unknown>): Promise<boolean> {
        hostToUi(msg);
        return Promise.resolve(true);
      },
    };
    return {
      webview,
      onDidDispose(): { dispose(): void } { return { dispose() {} }; },
      reveal(): void {},
      dispose(): void {},
      get visible(): boolean { return true; },
    };
  },
  async showOpenDialog(options: Record<string, unknown>): Promise<UriImpl[] | undefined> {
    stubState.openDialogCalls.push(options);
    // 真实 API 返回 Uri[]；测试里直接给路径字符串也接受，这里统一归一化。
    return stubState.openDialogResult?.map(
      (p) => (typeof p === 'string' ? UriImpl.file(p) : p as unknown as UriImpl),
    );
  },
  async showSaveDialog(): Promise<UriImpl | undefined> { return undefined; },
  async showInformationMessage(msg: string): Promise<string | undefined> {
    stubState.infoMessages.push(msg);
    return undefined;
  },
  async showErrorMessage(msg: string): Promise<string | undefined> {
    stubState.errorMessages.push(msg);
    return undefined;
  },
  async showTextDocument(doc: TextDocumentImpl): Promise<unknown> { return doc; },
  onDidChangeActiveTextEditor(): { dispose(): void } { return { dispose() {} }; },
};

export const commands = {
  registerCommand(_id: string, _fn: (...args: unknown[]) => unknown): { dispose(): void } {
    return { dispose() {} };
  },
  async executeCommand(): Promise<unknown> { return undefined; },
  async getCommands(): Promise<string[]> { return []; },
};

export default {
  Uri, Position, Range, TextEdit, WorkspaceEdit, RelativePattern,
  CancellationTokenSource, Disposable, ViewColumn,
  workspace, window, commands,
};

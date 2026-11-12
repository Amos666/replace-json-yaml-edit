/**
 * §6 三层过滤管道 + §6.6 读取与一致性 + §5.3 安全跳过 + 扫描结果/树/diff 构建。
 *
 * 管道：
 *   第 1 层 目录/路径选择：workspace.findFiles 一次拉取（§6.5），glob + overrides 求范围集 S
 *   第 2 层 扩展名策略：candidateExtensions / matchScope（唯一真相 §5.4）
 *   第 3 层 树筛选条件：parseTreeFilter / matchTreeFilter 求命中集 H（只影响显示/批量，不改勾选态）
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  applyPatches, candidateExtensions, effectiveFiles, extOf, isSelected,
  matchScope, matchTreeFilter, planFile,
} from '../core/index.ts';
import type { TreeFilter } from '../core/types.ts';
import type { DiffLine, FileDiff, FlatItem, TreeNode } from '../shared/protocol.ts';
import { buildEquivalentGlob } from './state.ts';
import type { FileEntry, FileRecord, HostConfig, HostState, SkipItem, TextCacheEntry } from './types.ts';

export class ScanCancelledError extends Error {
  constructor() { super('扫描已取消'); }
}

export function readConfig(): HostConfig {
  const c = vscode.workspace.getConfiguration('batchReplace');
  return {
    maxMatches: c.get<number>('maxMatchesPerFile', 2000),
    maxFileSizeMB: c.get<number>('maxFileSizeMB', 5),
    defaultExclude: c.get<string[]>('defaultExclude', [
      '**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**',
    ]),
  };
}

/** 第 1 层：一次 findFiles（2 万上限），建 FileEntry[] 与 uri↔relPath 双向映射。 */
export async function refreshFileList(
  state: HostState,
  cfg: HostConfig,
  token?: vscode.CancellationToken,
): Promise<void> {
  const exclude = cfg.defaultExclude.length
    ? `{${cfg.defaultExclude.join(',')}}`
    : undefined;
  const uris = await vscode.workspace.findFiles('**/*', exclude, 20000, token);
  const folders = vscode.workspace.workspaceFolders ?? [];

  const entries: FileEntry[] = [];
  const uriToRel = new Map<string, string>();
  const relToUri = new Map<string, string>();
  for (const uri of uris) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) continue; // §6.6 / §9：工作区外文件不跟随
    const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    const relPath = folders.length > 1 ? `${folder.name}/${rel}` : rel;
    const name = relPath.split('/').pop() ?? relPath;
    const uriStr = uri.toString();
    entries.push({ uri: uriStr, relPath, name, ext: extOf(name) });
    uriToRel.set(uriStr, relPath);
    relToUri.set(relPath, uriStr);
  }
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  state.entries = entries;
  state.allRelPaths = entries.map((e) => e.relPath);
  state.uriToRel = uriToRel;
  state.relToUri = relToUri;
}

/** §6.6 hash：扫描时记录内容 hash，apply 前重读比对。 */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 符号链接 / 工作区外：best-effort realpath 不跟随出界（远程/虚拟工作区退化为不疑罪）。 */
async function insideWorkspace(uri: vscode.Uri, folder: vscode.WorkspaceFolder): Promise<boolean> {
  try {
    const real = await realpath(uri.fsPath);
    const root = await realpath(folder.uri.fsPath);
    return real === root || real.startsWith(root + path.sep);
  } catch {
    return true;
  }
}

/**
 * §6.6 读取一致性：已打开用 openTextDocument().getText()（含未保存），
 * 否则 workspace.fs.readFile + fatal UTF-8。§5.3 安全跳过：8KB NUL / 非 UTF-8 / 超限大小。
 */
export async function readText(
  uriStr: string,
  cfg: HostConfig,
): Promise<{ text: string; hash: string; skip?: string }> {
  const uri = vscode.Uri.parse(uriStr);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return { text: '', hash: '', skip: '工作区外文件已忽略' };
  if (!(await insideWorkspace(uri, folder))) {
    return { text: '', hash: '', skip: '符号链接指向工作区外，已跳过' };
  }
  const maxBytes = Math.max(1, cfg.maxFileSizeMB) * 1024 * 1024;
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriStr);
  let text: string;
  let byteLen: number;
  if (open) {
    text = open.getText(); // 含未保存内容
    byteLen = new TextEncoder().encode(text).length;
  } else {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (e) {
      return { text: '', hash: '', skip: `读取失败：${(e as Error).message}` };
    }
    byteLen = bytes.length;
    if (byteLen > maxBytes) return { text: '', hash: '', skip: '文件超过大小上限，已跳过' };
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { text: '', hash: '', skip: '非 UTF-8 文本已忽略' };
    }
  }
  if (byteLen > maxBytes) return { text: '', hash: '', skip: '文件超过大小上限，已跳过' };
  if (text.slice(0, 8192).includes('\u0000')) return { text: '', hash: '', skip: '二进制文件已忽略' };
  return { text, hash: hashText(text) };
}

/**
 * 第 3 层：命中集 H 的高亮区间。raw 为空时 UI 会把全部文件纳入 H（返回 [] 即可）。
 * 命中但无可高亮片段时用零宽标记，保证 UI 的 hitPathSet 把它算作命中。
 */
export function computeHitRanges(
  entry: { relPath: string; ext: string },
  filter: TreeFilter,
): Array<[number, number]> {
  if (!filter.raw.trim()) return [];
  if (!matchTreeFilter(entry.relPath, filter)) return [];
  const lower = entry.relPath.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const cond of filter.include) {
    const c = cond.toLowerCase();
    if (c.startsWith('ext:')) {
      if (entry.ext) {
        const idx = lower.lastIndexOf(`.${entry.ext}`);
        if (idx >= 0) ranges.push([idx, idx + entry.ext.length + 1]);
      }
    } else if (c.includes('*') || c.includes('?') || c.includes('/')) {
      const nameStart = lower.lastIndexOf('/') + 1;
      ranges.push([nameStart, entry.relPath.length]);
    } else {
      const idx = lower.indexOf(c);
      if (idx >= 0) ranges.push([idx, idx + c.length]);
    }
  }
  if (!ranges.length) return [[0, 0]];
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

export function buildFlat(state: HostState): FlatItem[] {
  return state.entries.map((e) => {
    const rec = state.records.get(e.uri);
    return {
      uri: e.uri,
      path: e.relPath,
      ext: e.ext,
      applicable: rec?.applicable ?? false,
      instructionCount: rec?.instructionCount ?? 0,
      changeCount: rec?.changeCount ?? 0,
      checked: isSelected(e.relPath, state.selection),
      hitRanges: rec?.hitRanges ?? [],
    };
  });
}

interface DirBucket {
  node: TreeNode;
  dirs: Map<string, DirBucket>;
}

/** flat 的 hitRanges 以完整相对路径为坐标系；树文件行只显示 basename，需裁剪到 basename。 */
function toBasenameRanges(
  relPath: string,
  name: string,
  ranges: Array<[number, number]>,
): Array<[number, number]> {
  const offset = relPath.length - name.length;
  const out: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    const ns = Math.max(0, s - offset);
    const ne = Math.min(name.length, e - offset);
    if (ne > ns) out.push([ns, ne]);
  }
  return out;
}

/** 由 flat 反建目录树（相对路径分段），目录 checked 自底向上三态汇总。 */
export function buildTree(state: HostState): TreeNode[] {
  const root: DirBucket = {
    node: {
      path: '', name: '', kind: 'dir', checked: false, applicable: true,
      changeCount: 0, ext: '', children: [],
    },
    dirs: new Map(),
  };
  const bucketByNode = new Map<TreeNode, DirBucket>();

  const ensureDir = (parent: DirBucket, seg: string, fullPath: string): DirBucket => {
    let bucket = parent.dirs.get(seg);
    if (!bucket) {
      const node: TreeNode = {
        path: fullPath, name: seg, kind: 'dir', checked: false, applicable: true,
        changeCount: 0, ext: '', children: [],
      };
      bucket = { node, dirs: new Map() };
      parent.dirs.set(seg, bucket);
      parent.node.children!.push(node);
      bucketByNode.set(node, bucket);
    }
    return bucket;
  };

  for (const f of state.flat) {
    const parts = f.path.split('/');
    let bucket = root;
    let acc = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      bucket = ensureDir(bucket, parts[i], acc);
    }
    const name = parts[parts.length - 1];
    const rec = state.records.get(f.uri);
    // reason 供 UI「灰显/跳过说明」分组（§8.2）：解析失败独立分组、仅结构化跳过标注。
    let reason: string | undefined;
    if (!f.applicable) {
      reason = `当前指令不适用此类型（.${f.ext || '无扩展名'}）`;
    } else if (rec?.parseErrors.length) {
      reason = `${rec.changeCount > 0 ? '仅结构化跳过' : '解析失败'}：${rec.parseErrors.join('；')}`;
    } else if (rec?.skippedReason) {
      reason = rec.skippedReason;
    }
    bucket.node.children!.push({
      path: f.path,
      name,
      kind: 'file',
      checked: f.checked,
      applicable: f.applicable,
      changeCount: f.changeCount,
      ext: f.ext,
      hitRanges: toBasenameRanges(f.path, name, f.hitRanges ?? []),
      ...(reason ? { reason } : {}),
    });
  }

  const finalize = (b: DirBucket): boolean | 'mixed' => {
    const children = b.node.children!;
    children.sort((a, b2) => {
      if (a.kind !== b2.kind) return a.kind === 'dir' ? -1 : 1;
      return a.path < b2.path ? -1 : a.path > b2.path ? 1 : 0;
    });
    let anyChecked = false;
    let allChecked = true;
    for (const c of children) {
      let cs: boolean | 'mixed';
      if (c.kind === 'dir') {
        const sub = bucketByNode.get(c)!;
        cs = finalize(sub);
        c.checked = cs;
      } else {
        cs = c.checked;
      }
      if (cs === true || cs === 'mixed') anyChecked = true;
      if (cs !== true) allChecked = false;
    }
    const value: boolean | 'mixed' = allChecked && anyChecked ? true : anyChecked ? 'mixed' : false;
    b.node.checked = value;
    return value;
  };
  finalize(root);
  return root.node.children!;
}

/** 行级 diff（公共前缀/后缀法，局部补丁足够且 O(n)）。 */
export function diffLines(before: string[], after: string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let eb = before.length - 1;
  let ea = after.length - 1;
  while (eb >= start && ea >= start && before[eb] === after[ea]) { eb -= 1; ea -= 1; }
  const lines: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  const context = (text: string): void => {
    lines.push({ kind: 'context', text, oldNo: oldNo++, newNo: newNo++ });
  };
  for (let i = 0; i < start; i += 1) context(before[i]);
  for (let i = start; i <= eb; i += 1) lines.push({ kind: 'remove', text: before[i], oldNo: oldNo++ });
  for (let i = start; i <= ea; i += 1) lines.push({ kind: 'add', text: after[i], newNo: newNo++ });
  for (let i = eb + 1; i < before.length; i += 1) context(before[i]);
  return lines;
}

export function makeFileDiff(rec: FileRecord, text: string): FileDiff {
  const before = text.split('\n');
  const after = applyPatches(text, rec.patches).split('\n');
  return { uri: rec.uri, path: rec.relPath, lines: diffLines(before, after) };
}

/** 轻量：仅筛选条件变化 → 重算命中高亮并重建树/扁平，不重新读盘、不重新 findFiles。 */
export function recomputeFilter(state: HostState): void {
  for (const rec of state.records.values()) {
    rec.hitRanges = computeHitRanges(rec, state.filter);
  }
  state.flat = buildFlat(state);
  state.tree = buildTree(state);
}

/**
 * 完整扫描：按 fileScope 挑选适用指令（§5.4 唯一真相）→ planFile → detectConflicts 语义
 * （planFile 内部已裁决重叠，整文件标红不部分应用）→ 计数 / 树 / 扁平 / diff / 报告素材。
 * 文本缓存复用，apply 前仍由 applyChanges 重读做 hash 二次校验。
 */
export async function runScan(
  state: HostState,
  cfg: HostConfig,
  cache: Map<string, TextCacheEntry>,
  cancelled: () => boolean,
  progress?: (scanned: number, total: number) => void,
): Promise<void> {
  const cand = candidateExtensions(state.instructions);
  const candSet = cand === 'all' ? null : cand;
  state.candidateExtensions = cand === 'all' ? 'all' : [...cand].sort();

  // 兼容以完整 URI 记录 overrides 的表达式集（附录 A 示例），统一换算到相对路径空间。
  for (const [uriStr, rel] of state.uriToRel) {
    if (state.selection.overrides.add.delete(uriStr)) state.selection.overrides.add.add(rel);
    if (state.selection.overrides.remove.delete(uriStr)) state.selection.overrides.remove.add(rel);
  }

  const selectedRel = new Set(effectiveFiles(state.allRelPaths, state.selection));
  const records = new Map<string, FileRecord>();
  const diffs: FileDiff[] = [];
  const skipped: SkipItem[] = [];
  const conflicts = state.scanConflicts;
  conflicts.length = 0;

  let changes = 0;
  let filesWithChanges = 0;
  let warnings = 0;
  let parseErrors = 0;
  let conflictFiles = 0;
  let scanned = 0;
  const total = state.entries.length;
  const opts = {
    maxMatches: cfg.maxMatches,
    maxBytes: Math.max(1, cfg.maxFileSizeMB) * 1024 * 1024,
  };

  for (const entry of state.entries) {
    if (cancelled()) throw new ScanCancelledError();
    const applicableFor = state.instructions.filter(
      (i) => i.enabled && matchScope({ path: entry.relPath, name: entry.name }, i.fileScope),
    );
    const applicable = cand === 'all' || (candSet?.has(entry.ext) ?? false) || applicableFor.length > 0;
    const checked = selectedRel.has(entry.relPath);
    const rec: FileRecord = {
      uri: entry.uri,
      relPath: entry.relPath,
      name: entry.name,
      ext: entry.ext,
      applicable,
      instructionCount: applicableFor.length,
      changeCount: 0,
      checked,
      hitRanges: computeHitRanges(entry, state.filter),
      hash: '',
      patches: [],
      parseErrors: [],
      conflictIds: [],
      scanned: false,
      ...(applicable ? {} : { reason: `当前指令不适用此类型（.${entry.ext || '无扩展名'}）` }),
    };

    if (checked && applicable && applicableFor.length > 0) {
      scanned += 1;
      let cached = cache.get(entry.uri);
      if (!cached) {
        const r = await readText(entry.uri, cfg);
        if (r.skip) {
          rec.skippedReason = r.skip;
          skipped.push({ uri: entry.uri, reason: r.skip });
          records.set(entry.uri, rec);
          continue;
        }
        cached = { text: r.text, hash: r.hash };
        cache.set(entry.uri, cached);
      }
      rec.hash = cached.hash;
      rec.scanned = true;

      const plan = planFile(cached.text, entry.uri, applicableFor, opts);
      rec.patches = plan.patches;
      rec.parseErrors = plan.parseErrors ?? [];
      rec.changeCount = plan.patches.length;
      if (rec.changeCount >= cfg.maxMatches) warnings += 1;
      for (const p of plan.patches) if (p.match.risky) warnings += 1;

      // planFile 对重叠补丁已整文件标红（清空 patches 并写入冲突消息），不部分应用。
      const conflict = rec.parseErrors.some((m) => m.includes('补丁区间重叠冲突'));
      if (conflict) {
        conflictFiles += 1;
        rec.conflictIds = applicableFor.map((i) => i.id);
        conflicts.push({ uri: entry.uri, instructionIds: rec.conflictIds });
      } else if (rec.parseErrors.length) {
        parseErrors += 1;
        if (rec.changeCount === 0) {
          // 结构化解析失败且文本指令未产出 → 整文件跳过进报告
          skipped.push({ uri: entry.uri, reason: `解析失败：${rec.parseErrors.join('；')}` });
        }
      }
      changes += rec.changeCount;
      if (rec.changeCount > 0) {
        filesWithChanges += 1;
        diffs.push(makeFileDiff(rec, cached.text));
      }
    }

    records.set(entry.uri, rec);
    if (progress && scanned % 10 === 0) progress(scanned, total);
  }

  state.records = records;
  state.diffs = diffs;
  state.scanSkipped = skipped;
  state.counts = {
    changes,
    files: filesWithChanges,
    warnings,
    parseErrors,
    conflicts: conflictFiles,
    scanned,
    total,
  };
  state.flat = buildFlat(state);
  state.tree = buildTree(state);
  state.equivalentGlob = buildEquivalentGlob(state);
}

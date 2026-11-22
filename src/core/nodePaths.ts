/**
 * 0.2.6 需求1：为源文件预览生成"节点路径清单"，供用户点击复制 `$.aa.bb`。
 * 纯函数、无 vscode。JSON 用 jsonc-parser AST，YAML 用 yaml AST + LineCounter。
 * 只采集前 maxLines 行内的节点（与预览截断一致），每个节点带 1-based 行号。
 */

import * as jsonc from 'jsonc-parser';
import {
  parseAllDocuments, isMap, isSeq, isScalar, LineCounter,
} from 'yaml';
import { pathToString } from './pathLang.ts';
import type { Seg, ValueType } from './types.ts';

export interface PreviewNode {
  path: string;
  line: number;
  type: ValueType;
  preview: string;
}

function typeOfValue(v: unknown): ValueType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'object';
    default: return 'string';
  }
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

function previewOf(v: unknown, type: ValueType): string {
  if (type === 'string') return String(v);
  if (type === 'object' || type === 'array') {
    const s = JSON.stringify(v);
    return s.length > 40 ? s.slice(0, 37) + '…' : s;
  }
  return String(v);
}

/** JSON/JSONC：递归遍历 jsonc AST，按 key/index 重建路径。 */
function jsonNodes(text: string, maxLines: number): PreviewNode[] {
  const root = jsonc.parseTree(text);
  if (!root) return [];
  const out: PreviewNode[] = [];
  const walk = (node: jsonc.Node, segs: Seg[]): void => {
    const line = lineAt(text, node.offset);
    if (line > maxLines) return;
    const val = jsonc.getNodeValue(node);
    const type = typeOfValue(val);
    if (segs.length) {
      out.push({ path: pathToString(segs), line, type, preview: previewOf(val, type) });
    }
    if (node.type === 'object' && Array.isArray(node.children)) {
      for (const pair of node.children) {
        const keyNode = pair.children?.[0];
        const valNode = pair.children?.[1];
        if (!keyNode || !valNode) continue;
        const key = typeof keyNode.value === 'string' || typeof keyNode.value === 'number'
          ? keyNode.value : String(keyNode.value ?? '');
        walk(valNode, [...segs, key]);
      }
    } else if (node.type === 'array' && Array.isArray(node.children)) {
      node.children.forEach((child, idx) => walk(child, [...segs, idx]));
    }
  };
  walk(root, []);
  return out;
}

/** YAML：递归遍历 yaml AST，LineCounter 定位行号。 */
function yamlNodes(text: string, maxLines: number): PreviewNode[] {
  const counter = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: counter }) as any[];
  if (!docs.length) return [];
  const out: PreviewNode[] = [];
  const lineOf = (node: any): number => {
    const pos = node?.range?.[0];
    if (typeof pos !== 'number') return 1;
    return counter.linePos(pos).line;
  };
  const walk = (node: any, segs: Seg[]): void => {
    if (!node || node === null) return;
    const line = lineOf(node);
    if (line > maxLines) return;
    if (isScalar(node)) {
      if (segs.length) {
        const type = typeOfValue(node.value);
        out.push({ path: pathToString(segs), line, type, preview: previewOf(node.value, type) });
      }
      return;
    }
    if (isMap(node)) {
      if (segs.length) {
        out.push({ path: pathToString(segs), line, type: 'object', preview: '{…}' });
      }
      for (const pair of node.items) {
        const keyNode = pair?.key;
        let key: Seg = '';
        if (isScalar(keyNode)) key = String(keyNode.value);
        else key = String((keyNode as any)?.value ?? '');
        walk(pair?.value, [...segs, key]);
      }
      return;
    }
    if (isSeq(node)) {
      if (segs.length) {
        out.push({ path: pathToString(segs), line, type: 'array', preview: '[…]' });
      }
      node.items.forEach((item: any, idx: number) => walk(item, [...segs, idx]));
      return;
    }
  };
  walk(docs[0].contents, []);
  return out;
}

/**
 * 生成预览节点清单。format: 'json' | 'yaml' | 其它（返回空）。
 */
export function collectPreviewNodes(
  text: string,
  format: 'json' | 'yaml' | 'text',
  maxLines = 1500,
): PreviewNode[] {
  try {
    if (format === 'json') return jsonNodes(text, maxLines);
    if (format === 'yaml') return yamlNodes(text, maxLines);
  } catch {
    return [];
  }
  return [];
}

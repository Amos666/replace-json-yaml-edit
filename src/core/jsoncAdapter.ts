import * as jsonc from 'jsonc-parser';
import type { Instruction, Match, MinimalPatch, Seg, ValueType } from './types.ts';
import { compilePath, type PathToken } from './pathLang.ts';

export interface StructPlanResult {
  patches: MinimalPatch[];
  parseErrors?: string[];
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function nodeType(node: jsonc.Node | undefined): ValueType {
  switch (node?.type) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'object': return 'object';
    case 'array': return 'array';
    default: return 'string';
  }
}

function findChild(node: jsonc.Node, key: Seg): jsonc.Node | undefined {
  if (node.type === 'array' && typeof key === 'number') return node.children?.[key];
  if (node.type === 'object' && typeof key === 'string') {
    for (const prop of node.children ?? []) {
      if (prop.children?.[0]?.value === key) return prop.children?.[1];
    }
  }
  return undefined;
}

/** §5.1 通配符在目标文档上展开为绝对路径集合 */
function expandPath(node: jsonc.Node | undefined, tokens: PathToken[], prefix: Seg[]): Seg[][] {
  if (tokens.length === 0) return node ? [prefix] : [];
  if (!node) return [];
  const [head, ...rest] = tokens;

  if (head.kind === 'wildcard') {
    const out: Seg[][] = [];
    if (node.type === 'array') {
      (node.children ?? []).forEach((child, idx) => {
        out.push(...expandPath(child, rest, [...prefix, idx]));
      });
    } else if (node.type === 'object') {
      for (const prop of node.children ?? []) {
        const keyNode = prop.children?.[0];
        if (keyNode && typeof keyNode.value === 'string') {
          out.push(...expandPath(prop.children?.[1], rest, [...prefix, keyNode.value]));
        }
      }
    }
    return out;
  }

  const key: Seg = head.value;
  return expandPath(findChild(node, key), rest, [...prefix, key]);
}

/** §5.2 类型与值解析；解析失败报错而非静默转字符串 */
function parseValue(raw: string | undefined, explicit: ValueType | undefined, oldType: ValueType): unknown {
  const text = raw ?? '';
  switch (explicit ?? oldType) {
    case 'string': return text;
    case 'number': {
      const n = Number(text);
      if (Number.isNaN(n)) throw new Error(`无法解析为数字：${text}`);
      return n;
    }
    case 'boolean':
      if (text === 'true' || text === 'false') return text === 'true';
      throw new Error(`无法解析为布尔值：${text}`);
    case 'null': return null;
    case 'object': {
      const v: unknown = JSON.parse(text);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('值必须是 JSON 对象');
      return v;
    }
    case 'array': {
      const v: unknown = JSON.parse(text);
      if (!Array.isArray(v)) throw new Error('值必须是 JSON 数组');
      return v;
    }
  }
}

/** 大整数（> 2^53）以字面量原样写入，避免精度丢失 */
function bigIntLiteral(raw: string | undefined, type: ValueType): string | null {
  if (type !== 'number' || !raw || !/^-?\d+$/.test(raw.trim())) return null;
  return Number.isSafeInteger(Number(raw)) ? null : raw.trim();
}

export function planJsonc(text: string, instructions: Instruction[]): StructPlanResult {
  const errors: jsonc.ParseError[] = [];
  const root = jsonc.parseTree(text, errors);
  if (!root || errors.length) {
    return {
      patches: [],
      parseErrors: errors.length
        ? errors.map(e => `JSON 解析错误（offset ${e.offset}）：${jsonc.printParseErrorCode(e.error)}`)
        : ['JSON 解析失败'],
    };
  }

  const patches: MinimalPatch[] = [];
  for (const ins of instructions) {
    if (ins.engine !== 'structured' || ins.format !== 'json') continue;
    if (!ins.path) continue;

    const tokens = compilePath(ins.path);
    let paths = expandPath(root, tokens, []);
    // §7.1 insert：新键走不存在的 path，由 modify 自动追加到对象末尾
    if (ins.kind === 'insert' && paths.length === 0) {
      paths = [tokens.map(t => (t.kind === 'wildcard' ? '*' : t.value))];
    }
    if (ins.scope === 'first') paths = paths.slice(0, 1);

    for (const segs of paths) {
      const node = jsonc.findNodeAtLocation(root, segs);
      const oldType = nodeType(node);
      const oldValue = node ? text.slice(node.offset, node.offset + node.length) : undefined;

      let value: unknown;
      let literal: string | null = null;
      if (ins.kind === 'delete') {
        value = undefined;
      } else {
        value = parseValue(ins.value, ins.valueType, oldType);
        literal = bigIntLiteral(ins.value, ins.valueType ?? oldType);
      }

      // §7.1 优先 jsonc.modify，不传 formattingOptions（避免重排编辑点附近）
      const lastSeg = segs[segs.length - 1];
      const isArrayInsert = ins.kind === 'insert' && typeof lastSeg === 'number';
      const edits = jsonc.modify(text, segs, value, {
        ...(isArrayInsert ? { isArrayInsertion: true } : {}),
      });

      for (const edit of edits) {
        let start = edit.offset;
        let end = edit.offset + edit.length;
        let note: string | undefined;

        // §7.1 delete 后若残留整行空白，收敛补丁一并删除
        if (ins.kind === 'delete') {
          const lineStart = text.lastIndexOf('\n', start - 1) + 1;
          let lineEnd = text.indexOf('\n', end);
          lineEnd = lineEnd === -1 ? text.length : lineEnd + 1;
          if ((text.slice(lineStart, start) + text.slice(end, lineEnd)).trim() === '') {
            start = lineStart;
            end = lineEnd;
            note = '删除后收敛空行';
          }
        }

        const match: Match = {
          instructionId: ins.id,
          engine: 'structured',
          segs,
          range: { start, end },
          oldValue,
          oldType,
          line: lineOf(text, start),
        };
        patches.push({
          match,
          start,
          end,
          newText: literal ?? edit.content,
          ...(note ? { note } : {}),
        });
      }
    }
  }
  return { patches };
}

import { parseAllDocuments, LineCounter, isScalar, isMap, isSeq, isAlias } from 'yaml';
import type { Document, Scalar, Node as YamlNode } from 'yaml';
import type { Instruction, Match, MinimalPatch, Seg, ValueType } from './types.ts';
import { compilePath, type PathToken } from './pathLang.ts';

export interface StructPlanResult {
  patches: MinimalPatch[];
  parseErrors?: string[];
}

type ParsedDoc = Document.Parsed;

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}
function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}
function lineEnd(text: string, offset: number): number {
  const i = text.indexOf('\n', offset);
  return i === -1 ? text.length : i + 1;
}
function indentOf(text: string, offset: number): string {
  return /^[ \t]*/.exec(text.slice(lineStart(text, offset), offset))?.[0] ?? '';
}

function keyOf(node: unknown): string {
  return node && isScalar(node) ? String(node.value) : '';
}
function typeOf(v: unknown): ValueType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'object';
    default: return 'string';
  }
}

function findChild(node: YamlNode | undefined, key: Seg): YamlNode | undefined {
  if (!node) return undefined;
  if (isSeq(node) && typeof key === 'number') return node.items[key] as YamlNode | undefined;
  if (isMap(node) && typeof key === 'string') {
    for (const pair of node.items) {
      if (keyOf(pair.key) === key) return pair.value as YamlNode;
    }
  }
  return undefined;
}

function expandPath(node: YamlNode | undefined, tokens: PathToken[], prefix: Seg[]): Seg[][] {
  if (tokens.length === 0) return node ? [prefix] : [];
  if (!node) return [];
  const [head, ...rest] = tokens;
  if (head.kind === 'wildcard') {
    const out: Seg[][] = [];
    if (isSeq(node)) {
      node.items.forEach((child, idx) => out.push(...expandPath(child as YamlNode, rest, [...prefix, idx])));
    } else if (isMap(node)) {
      for (const pair of node.items) {
        out.push(...expandPath(pair.value as YamlNode, rest, [...prefix, keyOf(pair.key)]));
      }
    }
    return out;
  }
  const key: Seg = head.value;
  return expandPath(findChild(node, key), rest, [...prefix, key]);
}

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
    case 'object': case 'array': return JSON.parse(text);
  }
}

function stringifyScalar(value: unknown, type: ValueType): string {
  if (type === 'string') return JSON.stringify(String(value));
  if (type === 'null') return 'null';
  return String(value);
}

/** §5.2 PLAIN 字符串在必要时加引号，避免写出隐式类型 */
function needsQuotes(s: string): boolean {
  if (s === '' || /^\s|\s$/.test(s)) return true;
  if (/^(-?\d+(\.\d+)?|true|false|null|~|yes|no|on|off)$/i.test(s)) return true;
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s)) return true;
  // YAML PLAIN 允许 'a:b'；只有冒号后接空白、'#' 前有空白或含换行才必须加引号
  if (/:\s|\s#|\n/.test(s)) return true;
  return false;
}

/**
 * §7.2 沿用原 Scalar.type 渲染新值。
 * 注意：yaml@2.9.1 的 Scalar.toString() 只返回 String(value)，不保留引号风格，
 * 因此这里按 scalar.type 自行渲染（QUOTE_DOUBLE / QUOTE_SINGLE / PLAIN）。
 */
function renderScalar(scalar: Scalar<unknown>, value: unknown, type: ValueType): string {
  const s = String(value);
  switch (scalar.type) {
    case 'QUOTE_DOUBLE': return JSON.stringify(s);
    case 'QUOTE_SINGLE': return `'${s.replace(/'/g, "''")}'`;
    case 'PLAIN':
    default:
      if (type !== 'string') return s;
      return needsQuotes(s) ? JSON.stringify(s) : s;
  }
}

/** §7.2 锚点 / 别名 / merge / 多文档防护 */
function riskyFor(
  node: YamlNode | undefined,
  parent: YamlNode | undefined,
  docIndex: number,
): Match['risky'] {
  if (docIndex > 0) return 'multiDoc';
  if (node && isAlias(node)) return 'alias';
  if (node && (node as Scalar).anchor) return 'anchor';
  if (parent && isMap(parent) && parent.items.some(p => keyOf(p.key) === '<<')) return 'merge';
  return undefined;
}

export function planYaml(text: string, instructions: Instruction[]): StructPlanResult {
  const docs = parseAllDocuments(text, {
    keepSourceTokens: true,
    lineCounter: new LineCounter(),
  }) as unknown as ParsedDoc[];

  const parseErrors: string[] = [];
  for (const doc of docs) {
    for (const err of doc.errors) parseErrors.push(`YAML 解析错误：${err.message}`);
  }
  if (parseErrors.length) return { patches: [], parseErrors };

  const patches: MinimalPatch[] = [];
  for (const ins of instructions) {
    if (ins.engine !== 'structured' || ins.format !== 'yaml' || !ins.path) continue;
    const tokens = compilePath(ins.path);

    for (let di = 0; di < docs.length; di += 1) {
      const doc = docs[di];
      let paths = expandPath(doc.contents as YamlNode, tokens, []);
      if (ins.kind === 'insert' && paths.length === 0) {
        paths = [tokens.map(t => (t.kind === 'wildcard' ? '*' : t.value))];
      }
      if (ins.scope === 'first') paths = paths.slice(0, 1);

      for (const segs of paths) {
        const node = doc.getIn(segs, true) as YamlNode | undefined;
        if (!node) continue;
        const parentSegs = segs.slice(0, -1);
        const parent = (parentSegs.length
          ? doc.getIn(parentSegs, true)
          : doc.contents) as YamlNode | undefined;
        const start = node.range?.[0];
        const valueEnd = node.range?.[1];
        if (start === undefined || valueEnd === undefined) continue;

        const oldValue = isScalar(node) ? node.value : undefined;
        const oldType = typeOf(oldValue);
        const risky = riskyFor(node, parent, di);
        const baseMatch: Omit<Match, 'range'> = {
          instructionId: ins.id,
          engine: 'structured',
          segs,
          oldValue,
          oldType,
          line: lineOf(text, start),
          ...(risky ? { risky } : {}),
        };

        if (ins.kind === 'delete') {
          let s = lineStart(text, start);
          while (s > 0) {
            const prevStart = lineStart(text, s - 1);
            if (/^\s*#/.test(text.slice(prevStart, s - 1))) s = prevStart;
            else break;
          }
          patches.push({
            match: { ...baseMatch, range: { start: s, end: lineEnd(text, start) } },
            start: s,
            end: lineEnd(text, start),
            newText: '',
          });
          continue;
        }

        if (ins.kind === 'insert') {
          if (!parent || !isMap(parent)) continue;
          const key = String(segs[segs.length - 1]);
          const lastPair = parent.items[parent.items.length - 1];
          const anchor = (lastPair?.value as YamlNode | undefined)?.range?.[2] ?? start;
          const at = lineEnd(text, anchor);
          const type = ins.valueType ?? 'string';
          const value = parseValue(ins.value, type, 'string');
          patches.push({
            match: { ...baseMatch, range: { start: at, end: at } },
            start: at,
            end: at,
            newText: `${indentOf(text, anchor)}${key}: ${stringifyScalar(value, type)}\n`,
          });
          continue;
        }

        // §7.2 set：复用原 Scalar 对象，用 value-end 保留行尾注释，禁止整篇输出
        if (!isScalar(node)) continue;
        const scalar = node as Scalar<unknown>;
        const valueType = ins.valueType ?? oldType;
        const value = parseValue(ins.value, ins.valueType, oldType);
        scalar.value = value;
        scalar.source = undefined;
        patches.push({
          match: { ...baseMatch, range: { start, end: valueEnd } },
          start,
          end: valueEnd,
          newText: renderScalar(scalar, value, valueType),
        });
      }
    }
  }
  return { patches, ...(parseErrors.length ? { parseErrors } : {}) };
}

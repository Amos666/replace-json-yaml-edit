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
  if (type === 'object' || type === 'array') return JSON.stringify(value);
  return String(value);
}

/** 删除时定位「键所在行的起点」：Map 用 pair.key.range，Seq 用节点行首（含 '- ' 标记）。 */
function keyStartOf(parent: YamlNode | undefined, segs: Seg[], start: number): number {
  if (parent && isMap(parent)) {
    const key = String(segs[segs.length - 1]);
    for (const pair of parent.items) {
      if (keyOf(pair.key) === key) {
        const keyNode = pair.key as YamlNode | undefined;
        return keyNode?.range?.[0] ?? start;
      }
    }
  }
  return start;
}

/** insert：目标键不存在时，追加一行到父映射/序列末尾（0.1.5 反馈：新增指令无效）。 */
/** 从全文推断 YAML 基本缩进单位（最小非零缩进），至少 2 空格。 */
function yamlBaseUnit(text: string): string {
  let min = Infinity;
  for (const line of text.split(/\r?\n/)) {
    const m = /^( +)\S/.exec(line);
    if (m) min = Math.min(min, m[1].length);
  }
  return ' '.repeat(Number.isFinite(min) ? Math.max(2, min) : 2);
}

/**
 * 0.2.3：为 insert 构造补丁。沿路径找到"最深已存在的父容器"，把缺失的中间段
 * 逐级渲染成嵌套映射（沿用文件缩进），标量值放最内层。
 *  - Map 父：新增一行 `key:` 链，如 $.config.bbb.aa → `bbb:\n  aa: 33333`
 *  - Seq 父 + 字符串键：降级为追加一个元素，如 $.tags.bbb.aa → `- bbb:\n    aa: 33333`
 *  - 纯插入，不改任何已有字符；末尾无换行时补 eol。
 */
function insertMissingPatch(
  text: string,
  doc: ParsedDoc,
  segs: Seg[],
  ins: Instruction,
  di: number,
): MinimalPatch | null {
  if (segs.length === 0) return null;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const unit = yamlBaseUnit(text);
  const type = ins.valueType ?? 'string';
  let value: unknown;
  try {
    value = parseValue(ins.value, type, 'string');
  } catch (e) {
    return null; // 值解析失败由上层 parseErrors 记账，这里静默跳过
  }

  // 找最深已存在的父容器
  let parentNode: YamlNode | undefined = doc.contents as YamlNode | undefined;
  let existing = 0;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const next: YamlNode | undefined = parentNode ? findChild(parentNode, segs[i]) : undefined;
    if (!next) break;
    if (!isMap(next) && !isSeq(next)) return null; // 标量父节点不可写
    parentNode = next;
    existing = i + 1;
  }

  const keySeg = segs[segs.length - 1];
  // 新增键 = 第一个缺失段；其后各段（含末段）逐级嵌套，值放最内层。
  const newKey = String(segs[existing]);
  const keyChain = segs.slice(existing).map(s => String(s));
  // 若末段是数组下标（数字），无键名，直接把值作为元素
  const hasKeyChain = typeof keySeg === 'string';

  let at: number;
  let baseIndent: string;
  let seqPrefix = '';
  if (parentNode && isMap(parentNode)) {
    if (parentNode.items.some(pair => keyOf(pair.key) === newKey)) return null; // 不产生重复键
    const lastPair = parentNode.items[parentNode.items.length - 1];
    if (lastPair) {
      const keyNode = lastPair.key as YamlNode | undefined;
      const valNode = lastPair.value as YamlNode | undefined;
      const anchor = valNode?.range?.[2] ?? keyNode?.range?.[2] ?? 0;
      at = lineEnd(text, Math.max(0, anchor - 1));
      baseIndent = indentOf(text, keyNode?.range?.[0] ?? anchor);
    } else {
      const pStart = parentNode.range?.[0] ?? 0;
      at = lineEnd(text, pStart);
      baseIndent = indentOf(text, pStart) + unit;
    }
  } else if (parentNode && isSeq(parentNode)) {
    const lastItem = parentNode.items[parentNode.items.length - 1] as YamlNode | undefined;
    const itemLine = lastItem
      ? lineStart(text, lastItem.range?.[0] ?? 0)
      : lineStart(text, parentNode.range?.[0] ?? 0);
    const itemIndent = /^[ \t]*/.exec(text.slice(itemLine))?.[0] ?? '';
    seqPrefix = itemIndent + '- ';
    const anchor = lastItem?.range?.[2] ?? parentNode.range?.[2] ?? 0;
    at = lineEnd(text, Math.max(0, anchor - 1));
    baseIndent = itemIndent + unit;
  } else {
    return null;
  }

  // 渲染键链（逐级 +unit 缩进），最内层放值
  const scalar = stringifyScalar(value, type);
  const lines: string[] = [];
  if (hasKeyChain) {
    for (let i = 0; i < keyChain.length; i += 1) {
      const isLast = i === keyChain.length - 1;
      const lineIndent = i === 0
        ? (seqPrefix || baseIndent)
        : baseIndent + unit.repeat(i - 1) + unit;
      lines.push(isLast
        ? `${lineIndent}${keyChain[i]}: ${scalar}`
        : `${lineIndent}${keyChain[i]}:`);
    }
  } else {
    // 数组下标插入：直接一个 `- value` 元素
    lines.push(`${seqPrefix || baseIndent}${scalar}`);
  }
  let rendered = lines.join(eol) + eol;
  if (at > 0 && text[at - 1] !== '\n') rendered = eol + rendered;

  const match: Match = {
    instructionId: ins.id,
    engine: 'structured',
    segs,
    range: { start: at, end: at },
    oldValue: undefined,
    oldType: type,
    line: lineOf(text, at),
    ...(di > 0 ? { risky: 'multiDoc' as const } : {}),
  };
  return { match, start: at, end: at, newText: rendered };
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
  const insertPatches = new Set<MinimalPatch>();
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
        const parentSegs = segs.slice(0, -1);
        const parent = (parentSegs.length
          ? doc.getIn(parentSegs, true)
          : doc.contents) as YamlNode | undefined;
        // 目标键不存在 → 追加（含深层路径创建、数组降级、沿用缩进）
        if (ins.kind === 'insert' && !node) {
          const patch = insertMissingPatch(text, doc, segs, ins, di);
          if (patch) { patches.push(patch); insertPatches.add(patch); }
          continue;
        }
        if (!node) continue;
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
          // 删除父节点：从键所在行开始，一直删到整个值（含全部子键/子项）结束，
          // 不能再只删节点 range 起点的那一行，否则会留下孤儿子节点。
          const keyStart = keyStartOf(parent, segs, start);
          let s = lineStart(text, keyStart);
          while (s > 0) {
            const prevStart = lineStart(text, s - 1);
            if (/^\s*#/.test(text.slice(prevStart, s - 1))) s = prevStart;
            else break;
          }
          const e = lineEnd(text, Math.max(keyStart, valueEnd - 1));
          patches.push({
            match: { ...baseMatch, range: { start: s, end: e } },
            start: s,
            end: e,
            newText: '',
          });
          continue;
        }

        // 键已存在的 insert 视为 set（标量）；集合类型不产生重复键。
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
  // 0.2.3：多条 insert 锚在同一 offset（同一父级末尾）时，按指令顺序合并为一个补丁，
  // 否则 applyPatches 逆序应用会让新增键顺序颠倒（与 JSON 侧处理保持一致）。
  const merged: MinimalPatch[] = [];
  const groups = new Map<number, MinimalPatch[]>();
  for (const p of patches) {
    if (insertPatches.has(p) && p.start === p.end) {
      const g = groups.get(p.start);
      if (g) g.push(p); else groups.set(p.start, [p]);
    } else {
      merged.push(p);
    }
  }
  for (const [start, group] of groups) {
    if (group.length === 1) { merged.push(group[0]); continue; }
    merged.push({
      ...group[0],
      start,
      end: start,
      newText: group.map(g => g.newText).join(''),
      match: { ...group[0].match, range: { start, end: start } },
    });
  }
  return { patches: merged, ...(parseErrors.length ? { parseErrors } : {}) };
}

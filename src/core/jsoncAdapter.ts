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

/**
 * 0.2.1：检查写入路径的父链是否都是容器（对象/数组）。
 * 只检查"确实存在的中间段"：末尾那段可以不存在（insert 追加新键是允许的）。
 * 若某个中间段是标量（string/number/boolean/null），jsonc.modify 会抛
 * "Can not add index to parent of type string"，因此提前判定为不可写。
 */
function pathParentIsContainer(root: jsonc.Node, segs: Seg[]): boolean {
  if (segs.length <= 1) return true;
  let node: jsonc.Node | undefined = root;
  for (let i = 0; i < segs.length - 1; i += 1) {
    node = findChild(node, segs[i]);
    if (!node) return true; // 中间段不存在：交给后续处理（可能可追加）
    if (node.type !== 'object' && node.type !== 'array') return false; // 标量父节点
  }
  return true;
}

/**
 * 0.2.3：通用子节点缩进检测（对象属性 / 数组元素）。
 * 返回 '' 表示单行内联（不换行），非空串表示多行子缩进（2/4 空格或 tab）。
 */
function detectChildIndent(text: string, node: jsonc.Node | undefined): string {
  if (!node) return '';
  const body = text.slice(node.offset, node.offset + node.length);
  if (!body.includes('\n')) return '';
  for (const k of node.children ?? []) {
    const lineStart = text.lastIndexOf('\n', k.offset - 1) + 1;
    const leading = text.slice(lineStart, k.offset);
    if (/^[ \t]+$/.test(leading)) return leading;
  }
  const lineStart = text.lastIndexOf('\n', node.offset - 1) + 1;
  const base = /^[ \t]*/.exec(text.slice(lineStart, node.offset))?.[0] ?? '';
  return base + '  ';
}

/** 缩进单位：从全文推断基本缩进增量（最小非零缩进宽度），沿用 tab。至少 2 空格。
 * 例如根级 2 空格、config 内 4 空格 → 基本单位 2 空格。 */
function detectBaseUnit(text: string): string {
  if (/\r?\n[ \t]*\t/.test(text) || text.includes('\n\t')) return '\t';
  let min = Infinity;
  for (const line of text.split(/\r?\n/)) {
    const m = /^( +)\S/.exec(line);
    if (m && m[1].length > 0) min = Math.min(min, m[1].length);
  }
  return ' '.repeat(Number.isFinite(min) ? Math.max(2, min) : 2);
}

/** 把值渲染成 JSON 文本；多行文件按缩进展开复合值，单行内联文件保持一行。 */
function renderInsertValue(
  value: unknown, baseIndent: string, unit: string, eol: string, multiline: boolean,
): string {
  if (!multiline) {
    try { return JSON.stringify(value) ?? 'null'; } catch { return 'null'; }
  }
  let json: string;
  try {
    json = JSON.stringify(value, null, unit.includes('\t') ? '\t' : unit.length) ?? 'null';
  } catch {
    return 'null';
  }
  if (!json.includes('\n')) return json;
  return json.split('\n').map((line, i) => (i === 0 ? line : baseIndent + line)).join(eol);
}

/**
 * 0.2.3：为 insert 指令自己构造补丁（不依赖 jsonc.modify 的 content，只借它定位插入 offset）。
 * 支持：顶层/嵌套新增、中间段不存在时创建带缩进的嵌套对象、数组父节点用字符串键时降级为追加对象元素。
 * 只做纯插入（start===end），不改任何已有字符；格式与文件统一。
 */
function planInsertPatch(
  text: string,
  root: jsonc.Node,
  segs: Seg[],
  value: unknown,
  ins: Instruction,
  parseErrors: string[],
  eol: string,
): MinimalPatch | null {
  if (segs.length === 0) return null;
  // 沿路径找最深已存在的父容器
  let parentNode: jsonc.Node | undefined = root;
  let existing = 0;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const next: jsonc.Node | undefined = parentNode ? findChild(parentNode, segs[i]) : undefined;
    if (!next) break;
    if (next.type !== 'object' && next.type !== 'array') {
      parseErrors.push(`路径 ${ins.path} 的父节点不是对象/数组，无法写入（已跳过）`);
      return null;
    }
    parentNode = next;
    existing = i + 1;
  }
  const keySeg = segs[segs.length - 1];
  // 第一个缺失段 = 要新增的键；其后各段包成嵌套对象，标量值放在最内层。
  // $.config.bbb.aa（config 存在）→ 在 config 下新增 "bbb": { "aa": v }
  // $.new.x.y（new 不存在）→ 在根下新增 "new": { "x": { "y": v } }
  const newKey = String(segs[existing]);
  let nestedValue = value;
  for (let i = segs.length - 1; i > existing; i -= 1) {
    nestedValue = { [String(segs[i])]: nestedValue };
  }
  let finalValue = nestedValue;
  // 数组父节点 + 非数字键：降级为向数组追加一个元素（把键路径包成对象）
  const arrayAppend = parentNode?.type === 'array' && typeof keySeg === 'string';
  let writeSegs: Seg[] = segs;
  let finalAtKey: string | null = newKey;
  if (arrayAppend) {
    const idx = parentNode!.children?.length ?? 0;
    writeSegs = [...segs.slice(0, existing), idx];
    // 追加元素 = { newKey: nestedValue }（把整个剩余路径作为对象元素）
    finalValue = { [newKey]: nestedValue };
    finalAtKey = null;
  } else if (typeof keySeg === 'number' && existing < segs.length - 1) {
    // 数组下标插入：无键名
    writeSegs = segs;
    finalAtKey = null;
  }

  // 借 jsonc.modify 精确定位插入 offset（传 finalValue 保证深层路径也能定位）
  let edits: jsonc.Edit[];
  try {
    edits = jsonc.modify(text, writeSegs, finalValue, {
      ...(arrayAppend || typeof keySeg === 'number' ? { isArrayInsertion: true } : {}),
    });
  } catch (e) {
    parseErrors.push(`路径 ${ins.path} 无法写入：${(e as Error).message}（已跳过）`);
    return null;
  }
  const insertEdit = edits.find(ed => ed.length === 0);
  if (!insertEdit) {
    parseErrors.push(`路径 ${ins.path} 新增未产生插入（已跳过）`);
    return null;
  }

  const leading = detectChildIndent(text, parentNode);
  const multiline = leading !== '';
  const unit = detectBaseUnit(text);
  const baseIndent = multiline ? leading : '';
  const prefix = multiline ? ',' + eol + leading : ', ';
  const renderedValue = renderInsertValue(finalValue, baseIndent, unit, eol, multiline);
  const body = finalAtKey !== null
    ? JSON.stringify(finalAtKey) + ': ' + renderedValue
    : renderedValue;
  const newText = prefix + body;

  const match: Match = {
    instructionId: ins.id,
    engine: 'structured',
    segs,
    range: { start: insertEdit.offset, end: insertEdit.offset },
    oldValue: undefined,
    oldType: 'object',
    line: lineOf(text, insertEdit.offset),
  };
  return { match, start: insertEdit.offset, end: insertEdit.offset, newText, note: '新增 key' };
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
  const parseErrors: string[] = [];
  const insertPatches = new Set<MinimalPatch>();
  for (const ins of instructions) {
    if (ins.engine !== 'structured' || ins.format !== 'json') continue;
    if (!ins.path) continue;

    const tokens = compilePath(ins.path);
    let paths = expandPath(root, tokens, []);
    // §7.1 insert：新键走不存在的 path，由 modify 自动追加到对象末尾
    if (ins.kind === 'insert' && paths.length === 0) {
      paths = [tokens.map(t => (t.kind === 'wildcard' ? '*' : t.value))];
    }
    // 0.2.1：set/delete 路径若因"父节点是标量"而无命中，给出明确说明，
    // 避免用户看到 0 处变更却不知道原因。
    if (ins.kind !== 'insert' && paths.length === 0 &&
      tokens.length > 1 && !pathParentIsContainer(root, tokens.map(tk => (tk.kind === 'wildcard' ? '*' : tk.value)))) {
      parseErrors.push(`路径 ${ins.path} 的父节点不是对象/数组，无法写入（已跳过）`);
      continue;
    }
    if (ins.scope === 'first') paths = paths.slice(0, 1);

    for (const segs of paths) {
      // 0.2.1：insert/set 的路径不能穿过标量（string/number/boolean/null），
      // 否则 jsonc.modify 会抛 "Can not add index to parent of type string" 并中断整个扫描。
      if (ins.kind !== 'delete' && !pathParentIsContainer(root, segs)) {
        parseErrors.push(`路径 ${ins.path} 的父节点不是对象/数组，无法写入（已跳过）`);
        continue;
      }
      const node = jsonc.findNodeAtLocation(root, segs);
      const oldType = nodeType(node);
      const oldValue = node ? text.slice(node.offset, node.offset + node.length) : undefined;

      let value: unknown;
      let literal: string | null = null;
      if (ins.kind === 'delete') {
        value = undefined;
      } else {
        try {
          value = parseValue(ins.value, ins.valueType, oldType);
          literal = bigIntLiteral(ins.value, ins.valueType ?? oldType);
        } catch (e) {
          parseErrors.push(`指令 ${ins.id} 的值无法解析：${(e as Error).message}（已跳过）`);
          continue;
        }
      }

      // 0.2.3：insert 且目标不存在 → 自己构造带缩进的新增补丁
      // （支持深层路径创建、数组父节点降级、嵌套值缩进），不走 jsonc.modify 的 content。
      if (ins.kind === 'insert' && node === undefined) {
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        const patch = planInsertPatch(text, root, segs, value, ins, parseErrors, eol);
        if (patch) { patches.push(patch); insertPatches.add(patch); }
        continue;
      }

      // §7.1 set / delete / insert 到已存在节点：jsonc.modify，不传 formattingOptions
      const lastSeg = segs[segs.length - 1];
      const isArrayInsert = ins.kind === 'insert' && typeof lastSeg === 'number';
      let edits: jsonc.Edit[];
      try {
        edits = jsonc.modify(text, segs, value, {
          ...(isArrayInsert ? { isArrayInsertion: true } : {}),
        });
      } catch (e) {
        // jsonc-parser 在路径穿过标量父节点时会抛异常；降级为跳过该路径，不让整个扫描崩溃
        parseErrors.push(`路径 ${ins.path} 无法写入：${(e as Error).message}（已跳过）`);
        continue;
      }

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
  // 0.2.3：多个 insert 锚在同一 offset（同一父对象末尾）时，按指令顺序合并为一个补丁，
  // 否则 applyPatches 逆序应用会让新增键顺序颠倒。合并后仍是纯插入，格式逐条带缩进。
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

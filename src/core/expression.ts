/**
 * 0.2.6：受限表达式求值（需求2 一期）——派生值 + 条件判断。
 * 纯函数、无 vscode、无 eval / new Function（安全底线）：自行词法分析 + 递归下降。
 *
 * 支持的"上下文"是单个文档解析出的 JS 值（JSON.parse / YAML.toJS 的结果）。
 * 表达式里通过 ${$.a.b[0]} 引用文档中其它节点的值，读取的是"扫描时的原文值"，
 * 不是其它指令改后的值（避免指令顺序依赖的歧义）。
 *
 * 语法（最小可用集）：
 *   - ${<path>}        路径取值，如 ${$.config.port}、${$.items[0].name}
 *   - 数字 / 布尔 / null 字面量
 *   - 单引号/双引号字符串字面量
 *   - 算术 + - * / （数字运算；+ 对字符串做拼接）
 *   - concat(a, b, ...) 字符串拼接函数
 *   - 括号分组
 * 条件 when：{ path, op, value, valueType }，全部满足才应用（AND）。
 */

import type { CondOp, Instruction, ValueType, WhenCond } from './types.ts';
import { compilePath } from './pathLang.ts';

export interface ExprResult {
  ok: boolean;
  value?: unknown;
  valueType?: ValueType;
  error?: string;
}

/** 按统一路径语法从文档对象取值；返回 {found, value}。 */
export function getPathValue(root: unknown, path: string): { found: boolean; value: unknown } {
  let tokens;
  try {
    tokens = compilePath(path);
  } catch {
    return { found: false, value: undefined };
  }
  let cur: any = root;
  for (const t of tokens) {
    if (t.kind === 'wildcard') return { found: false, value: undefined };
    if (cur == null || (typeof cur !== 'object' && !Array.isArray(cur))) {
      return { found: false, value: undefined };
    }
    const key: any = t.value;
    if (!(key in cur)) return { found: false, value: undefined };
    cur = cur[key];
  }
  return { found: true, value: cur };
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

/** 把字符串按 valueType 解析成比较用字面量（不抛错，失败返回原串）。 */
function coerceLiteral(raw: string | undefined, vt: ValueType): unknown {
  const s = raw ?? '';
  switch (vt) {
    case 'number': {
      const n = Number(s);
      return Number.isNaN(n) ? s : n;
    }
    case 'boolean': return s === 'true';
    case 'null': return null;
    case 'object': case 'array':
      try { return JSON.parse(s); } catch { return s; }
    default: return s;
  }
}

function compare(a: unknown, b: unknown, op: CondOp): boolean {
  switch (op) {
    case 'exists': case 'notExists': return true; // 由调用处按 found 判定
    case 'eq': return a === b || String(a) === String(b);
    case 'ne': return !(a === b || String(a) === String(b));
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const na = Number(a), nb = Number(b);
      const bothNum = !Number.isNaN(na) && !Number.isNaN(nb) &&
        typeof a !== 'boolean' && typeof b !== 'boolean';
      const x: any = bothNum ? na : String(a);
      const y: any = bothNum ? nb : String(b);
      if (op === 'gt') return x > y;
      if (op === 'gte') return x >= y;
      if (op === 'lt') return x < y;
      return x <= y;
    }
    case 'contains': {
      if (Array.isArray(a)) return a.some(v => v === b || String(v) === String(b));
      return String(a).includes(String(b));
    }
    default: return false;
  }
}

/** 评估所有条件（AND）。空条件返回 true。 */
export function evalWhen(root: unknown, when: WhenCond[] | undefined): { ok: boolean; error?: string } {
  if (!when || !when.length) return { ok: true };
  for (const c of when) {
    if (!c || !c.path) return { ok: false, error: '条件缺少 path' };
    const { found, value } = getPathValue(root, c.path);
    if (c.op === 'exists') { if (!found) return { ok: false }; continue; }
    if (c.op === 'notExists') { if (found) return { ok: false }; continue; }
    if (!found) return { ok: false, error: `条件路径不存在：${c.path}` };
    const b = coerceLiteral(c.value, c.valueType ?? 'string');
    if (!compare(value, b, c.op)) return { ok: false };
  }
  return { ok: true };
}

/* ───────────────────────── 表达式词法 + 递归下降 ───────────────────────── */

type Tok =
  | { t: 'path'; v: string }
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }
  | { t: 'eof' };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue; }
    if (ch === '$' && src[i + 1] === '{') {
      const end = src.indexOf('}', i + 2);
      if (end === -1) throw new Error('表达式路径缺少 }');
      out.push({ t: 'path', v: src.slice(i + 2, end).trim() });
      i = end + 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch; i += 1; let buf = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) { buf += src[i + 1]; i += 2; }
        else { buf += src[i]; i += 1; }
      }
      if (i >= src.length) throw new Error('表达式字符串引号未闭合');
      i += 1;
      out.push({ t: 'str', v: buf });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let buf = '';
      if (ch === '-') { buf += '-'; i += 1; }
      while (i < src.length && /[0-9]/.test(src[i])) { buf += src[i]; i += 1; }
      if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        buf += '.'; i += 1;
        while (i < src.length && /[0-9]/.test(src[i])) { buf += src[i]; i += 1; }
      }
      out.push({ t: 'num', v: Number(buf) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let buf = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) { buf += src[i]; i += 1; }
      out.push({ t: 'ident', v: buf });
      continue;
    }
    if ('+-*/(),'.includes(ch)) { out.push({ t: 'op', v: ch }); i += 1; continue; }
    throw new Error(`表达式含非法字符：${ch}`);
  }
  out.push({ t: 'eof' });
  return out;
}

/** 递归下降解析器。 */
class Parser {
  private i = 0;
  private toks: Tok[];
  private root: unknown;
  constructor(toks: Tok[], root: unknown) { this.toks = toks; this.root = root; }

  private peek(): Tok { return this.toks[this.i]; }
  private next(): Tok { return this.toks[this.i++]; }

  parse(): unknown {
    const v = this.expr();
    if (this.peek().t !== 'eof') throw new Error('表达式尾部有多余内容');
    return v;
  }

  private expr(): unknown {
    let left = this.term();
    while (this.peek().t === 'op' && ['+', '-'].includes((this.peek() as any).v)) {
      const op = (this.next() as any).v;
      const right = this.term();
      if (op === '+') {
        left = (typeof left === 'number' && typeof right === 'number')
          ? left + right
          : String(left) + String(right);
      } else {
        left = Number(left) - Number(right);
      }
    }
    return left;
  }

  private term(): unknown {
    let left = this.factor();
    while (this.peek().t === 'op' && ['*', '/'].includes((this.peek() as any).v)) {
      const op = (this.next() as any).v;
      const right = this.factor();
      if (op === '*') left = Number(left) * Number(right);
      else {
        const n = Number(right);
        if (n === 0) throw new Error('表达式除数为 0');
        left = Number(left) / n;
      }
    }
    return left;
  }

  private factor(): unknown {
    const t = this.next();
    if (t.t === 'num') return t.v;
    if (t.t === 'str') return t.v;
    if (t.t === 'path') {
      const { found, value } = getPathValue(this.root, t.v);
      if (!found) throw new Error(`表达式路径不存在：${t.v}`);
      return value;
    }
    if (t.t === 'op' && t.v === '(') {
      const v = this.expr();
      if (!(this.peek().t === 'op' && (this.peek() as any).v === ')')) {
        throw new Error('表达式缺少 )');
      }
      this.next();
      return v;
    }
    if (t.t === 'ident') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      if (t.v === 'concat') {
        if (!(this.peek().t === 'op' && (this.peek() as any).v === '(')) {
          throw new Error('concat 后缺少 (');
        }
        this.next();
        const parts: string[] = [];
        if (!(this.peek().t === 'op' && (this.peek() as any).v === ')')) {
          while (true) {
            parts.push(String(this.expr()));
            if (this.peek().t === 'op' && (this.peek() as any).v === ',') { this.next(); continue; }
            break;
          }
        }
        if (!(this.peek().t === 'op' && (this.peek() as any).v === ')')) {
          throw new Error('concat 缺少 )');
        }
        this.next();
        return parts.join('');
      }
      throw new Error(`未知表达式函数：${t.v}`);
    }
    if (t.t === 'op' && t.v === '-') {
      // 一元负号（如 -${$.a}）
      return -Number(this.factor());
    }
    throw new Error('表达式语法错误');
  }
}

/** 求值表达式，返回带类型的结果。失败时 ok=false + error。 */
export function evalExpr(root: unknown, expr: string): ExprResult {
  try {
    const toks = tokenize(expr);
    if (toks.length <= 1) return { ok: false, error: '表达式为空' };
    const value = new Parser(toks, root).parse();
    return { ok: true, value, valueType: typeOfValue(value) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 把求值结果序列化成 instruction 可消费的 value 字符串 + valueType。
 * number/boolean/null/string 直接 String；object/array 用 JSON.stringify。
 */
export function exprToValue(expr: ExprResult): { value: string; valueType: ValueType } | null {
  if (!expr.ok || expr.value === undefined) return null;
  const vt = expr.valueType ?? typeOfValue(expr.value);
  if (vt === 'object' || vt === 'array') return { value: JSON.stringify(expr.value), valueType: vt };
  if (vt === 'null') return { value: 'null', valueType: 'null' };
  return { value: String(expr.value), valueType: vt };
}

/** 判断一条指令是否使用了表达式/条件（一期特性）。 */
export function usesExprFeatures(ins: Instruction): boolean {
  return !!ins.valueExpr || !!(ins.when && ins.when.length);
}

/** 解析指令结果：resolved 指令列表 + 告警（条件不满足跳过、表达式错误等）。 */
export interface ResolveResult {
  instructions: Instruction[];
  errors: string[];
}

/**
 * 需求2 一期：把带 when/valueExpr 的指令解析成 adapter 可直接消费的普通指令。
 * - when 不满足 → 跳过该指令（不产补丁）；
 * - valueExpr → 求值并写入 value/valueType（覆盖字面量）；
 * 无表达式/条件的指令原样保留。root 是文档解析出的 JS 值。
 */
export function resolveInstructions(
  instructions: Instruction[],
  root: unknown,
): ResolveResult {
  const out: Instruction[] = [];
  const errors: string[] = [];
  for (const ins of instructions) {
    if (ins.engine !== 'structured' || !usesExprFeatures(ins)) {
      out.push(ins);
      continue;
    }
    const cond = evalWhen(root, ins.when);
    if (!cond.ok) {
      if (cond.error) errors.push(`指令 ${ins.id} 条件未满足：${cond.error}（已跳过）`);
      else errors.push(`指令 ${ins.id} 条件未满足（已跳过）`);
      continue;
    }
    if (ins.valueExpr) {
      const r = evalExpr(root, ins.valueExpr);
      const concrete = exprToValue(r);
      if (!concrete) {
        errors.push(`指令 ${ins.id} 表达式求值失败：${r.error ?? '未知错误'}（已跳过）`);
        continue;
      }
      out.push({ ...ins, value: concrete.value, valueType: concrete.valueType, valueExpr: undefined });
      continue;
    }
    out.push(ins);
  }
  return { instructions: out, errors };
}

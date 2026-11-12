import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planJsonc,
  planYaml,
  planText,
  applyPatches,
  reversePatches,
} from '../../src/core/index.ts';
import type { Instruction, ValueType } from '../../src/core/index.ts';

function structured(
  id: string,
  format: 'json' | 'yaml',
  kind: 'set' | 'delete' | 'insert',
  path: string,
  value?: string,
  valueType?: ValueType,
): Instruction {
  return {
    id, enabled: true, engine: 'structured', format,
    fileScope: { mode: 'fixed', format }, kind, path,
    ...(value !== undefined ? { value } : {}),
    ...(valueType ? { valueType } : {}),
  };
}

function text(
  id: string,
  textOp: 'replace' | 'deleteLine',
  pattern: string,
  replacement?: string,
  flags = 'g',
): Instruction {
  return {
    id, enabled: true, engine: 'text', fileScope: { mode: 'all' },
    textOp, pattern, flags,
    ...(replacement !== undefined ? { replacement } : {}),
  };
}

test('§10.1 JSONC set 最小补丁：注释/键序/缩进/行尾逐字节保留', () => {
  const before = '{\n  // comment\n  "a": 1,   /* inline */\n  "b": [1, 2]\n}\n';
  const r = planJsonc(before, [structured('i1', 'json', 'set', '$.a', '2', 'number')]);
  assert.equal(r.parseErrors, undefined);
  assert.equal(
    applyPatches(before, r.patches),
    '{\n  // comment\n  "a": 2,   /* inline */\n  "b": [1, 2]\n}\n',
  );
});

test('§10.1 JSONC 幂等：改回去逐字节还原', () => {
  const before = '{\n  "a": 1,\n  "b": 2\n}\n';
  const after = applyPatches(before, planJsonc(before, [structured('i1', 'json', 'set', '$.a', '9', 'number')]).patches);
  const back = applyPatches(after, planJsonc(after, [structured('i2', 'json', 'set', '$.a', '1', 'number')]).patches);
  assert.equal(back, before);
});

test('§10.3 JSONC 超精度大整数以字面量原样写入', () => {
  const before = '{\n  "n": 9007199254740991\n}\n';
  const r = planJsonc(before, [structured('i', 'json', 'set', '$.n', '9007199254740993', 'number')]);
  assert.equal(r.patches[0]?.newText, '9007199254740993');
});

test('§10.1 JSONC delete / insert', () => {
  const before = '{\n  "a": 1,\n  "b": 2\n}\n';
  const del = planJsonc(before, [structured('d', 'json', 'delete', '$.a')]);
  assert.equal(applyPatches(before, del.patches).includes('"a"'), false);
  const ins = planJsonc(before, [structured('i', 'json', 'insert', '$.c', '3', 'number')]);
  assert.match(applyPatches(before, ins.patches), /"c": 3/);
});

test('§10.1 YAML set 保持引号风格与行尾注释', () => {
  const before = 'a: "5432"   # keep\nb: 123\nc: 中文注释\n';
  const r = planYaml(before, [structured('i', 'yaml', 'set', '$.a', '9999', 'string')]);
  assert.equal(r.parseErrors, undefined);
  assert.equal(applyPatches(before, r.patches), 'a: "9999"   # keep\nb: 123\nc: 中文注释\n');
});

test('§10.1 YAML 幂等', () => {
  const before = 'a: hello\nb: world\n';
  const after = applyPatches(before, planYaml(before, [structured('i', 'yaml', 'set', '$.a', 'bye', 'string')]).patches);
  const back = applyPatches(after, planYaml(after, [structured('i2', 'yaml', 'set', '$.a', 'hello', 'string')]).patches);
  assert.equal(back, before);
});

test('§7.2 YAML 多文档命中标记 multiDoc', () => {
  const before = 'a: 1\n---\na: 2\n';
  const r = planYaml(before, [structured('i', 'yaml', 'set', '$.a', '9', 'number')]);
  assert.equal(r.patches.length, 2);
  assert.ok(r.patches.some(p => p.match.risky === 'multiDoc'));
});

test('§10.3 Text CRLF / BOM / 无尾换行保留', () => {
  const before = '\uFEFFa: foo\r\nb: foo';
  const r = planText(before, [text('t', 'replace', 'foo', 'bar')]);
  assert.equal(applyPatches(before, r.patches), '\uFEFFa: bar\r\nb: bar');
});

test('§10.3 Text deleteLine 连同 CRLF 行尾', () => {
  const before = 'keep\r\nDROP me\r\ntail\r\n';
  const r = planText(before, [text('t', 'deleteLine', '^DROP')]);
  assert.equal(applyPatches(before, r.patches), 'keep\r\ntail\r\n');
});

test('§10.3 Text 中文 / emoji 代理对不拆', () => {
  const before = 'a😀b 中文 foo\n';
  const r = planText(before, [text('t', 'replace', 'foo', 'bar')]);
  assert.equal(applyPatches(before, r.patches), 'a😀b 中文 bar\n');
});

test('§10.3 二进制 / 巨型文件跳过', () => {
  assert.match(planText('a\u0000b', [text('t', 'replace', 'a', 'x')]).skipReason ?? '', /二进制/);
  assert.match(
    planText('x'.repeat(10), [text('t', 'replace', 'x', 'y')], { maxBytes: 5 }).skipReason ?? '',
    /大小/,
  );
});

test('§10.1 补丁求逆逐字节还原', () => {
  const before = 'x = foo\nfoo = bar\n';
  const r = planText(before, [text('t', 'replace', 'foo', 'baz')]);
  const after = applyPatches(before, r.patches);
  assert.equal(after, 'x = baz\nbaz = bar\n');
  assert.equal(applyPatches(after, reversePatches(before, r.patches)), before);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPathValue, evalWhen, evalExpr, exprToValue, resolveInstructions,
} from '../../src/core/expression.ts';
import type { Instruction } from '../../src/core/types.ts';

const root = {
  a: 10,
  b: 5,
  config: { port: 8080, name: 'demo', host: 'localhost' },
  items: [{ price: 3, qty: 2 }, { price: 7, qty: 1 }],
  flag: true,
  empty: null,
  tags: ['x', 'y'],
};

function ins(patch: Partial<Instruction>): Instruction {
  return {
    id: 'i', enabled: true, engine: 'structured', format: 'json',
    kind: 'set', fileScope: { mode: 'fixed', format: 'json' },
    path: '$.x', value: '', ...patch,
  } as Instruction;
}

/* ── getPathValue ── */
test('expr getPathValue：对象/数组路径', () => {
  assert.deepEqual(getPathValue(root, '$.config.port'), { found: true, value: 8080 });
  assert.deepEqual(getPathValue(root, '$.items[0].price'), { found: true, value: 3 });
  assert.deepEqual(getPathValue(root, 'config.name'), { found: true, value: 'demo' });
});
test('expr getPathValue：不存在 / 穿过标量返回 found=false', () => {
  assert.equal(getPathValue(root, '$.config.nope').found, false);
  assert.equal(getPathValue(root, '$.a.foo').found, false);
  assert.equal(getPathValue(root, '$[*]').found, false); // 通配不支持
});

/* ── evalExpr ── */
test('expr evalExpr：算术 + 路径取值', () => {
  const r = evalExpr(root, '${$.a} + ${$.b}');
  assert.equal(r.ok, true);
  assert.equal(r.value, 15);
  assert.equal(r.valueType, 'number');
});
test('expr evalExpr：乘除与括号优先级', () => {
  assert.equal(evalExpr(root, '(${$.a} + ${$.b}) * 2').value, 30);
  assert.equal(evalExpr(root, '${$.a} - ${$.b} * 2').value, 0);
  assert.equal(evalExpr(root, '9 / 2').value, 4.5);
});
test('expr evalExpr：+ 对字符串拼接、concat 函数', () => {
  assert.equal(evalExpr(root, "'v' + ${$.config.port}").value, 'v8080');
  assert.equal(evalExpr(root, "concat(${$.config.name}, '-', ${$.config.port})").value, 'demo-8080');
});
test('expr evalExpr：字面量 true/false/null/数字', () => {
  assert.equal(evalExpr(root, 'true').value, true);
  assert.equal(evalExpr(root, 'false').value, false);
  assert.equal(evalExpr(root, 'null').value, null);
  assert.equal(evalExpr(root, '42').value, 42);
});
test('expr evalExpr：错误表达式 ok=false 且带 error', () => {
  assert.equal(evalExpr(root, '${$.nope}').ok, false);
  assert.equal(evalExpr(root, '1 / 0').ok, false);
  assert.equal(evalExpr(root, 'bogus(1)').ok, false);
  assert.equal(evalExpr(root, '${$.a} +').ok, false);
});

/* ── exprToValue ── */
test('expr exprToValue：各类型序列化', () => {
  assert.deepEqual(exprToValue(evalExpr(root, '${$.a} + ${$.b}')), { value: '15', valueType: 'number' });
  assert.deepEqual(exprToValue(evalExpr(root, "'a' + 'b'")), { value: 'ab', valueType: 'string' });
  assert.deepEqual(exprToValue(evalExpr(root, 'true')), { value: 'true', valueType: 'boolean' });
});

/* ── evalWhen ── */
test('expr evalWhen：eq/ne/gt/gte/lt/lte', () => {
  assert.equal(evalWhen(root, [{ path: '$.a', op: 'gt', value: '5', valueType: 'number' }]).ok, true);
  assert.equal(evalWhen(root, [{ path: '$.a', op: 'lt', value: '5', valueType: 'number' }]).ok, false);
  assert.equal(evalWhen(root, [{ path: '$.config.name', op: 'eq', value: 'demo' }]).ok, true);
  assert.equal(evalWhen(root, [{ path: '$.a', op: 'ne', value: '11', valueType: 'number' }]).ok, true);
});
test('expr evalWhen：contains / exists / notExists', () => {
  assert.equal(evalWhen(root, [{ path: '$.tags', op: 'contains', value: 'y' }]).ok, true);
  assert.equal(evalWhen(root, [{ path: '$.config.port', op: 'exists' }]).ok, true);
  assert.equal(evalWhen(root, [{ path: '$.config.nope', op: 'notExists' }]).ok, true);
  assert.equal(evalWhen(root, [{ path: '$.config.nope', op: 'exists' }]).ok, false);
});
test('expr evalWhen：多条件 AND', () => {
  const ok = evalWhen(root, [
    { path: '$.a', op: 'gt', value: '5', valueType: 'number' },
    { path: '$.flag', op: 'eq', value: 'true', valueType: 'boolean' },
  ]);
  assert.equal(ok.ok, true);
  const fail = evalWhen(root, [
    { path: '$.a', op: 'gt', value: '5', valueType: 'number' },
    { path: '$.flag', op: 'eq', value: 'false', valueType: 'boolean' },
  ]);
  assert.equal(fail.ok, false);
});

/* ── resolveInstructions ── */
test('expr resolveInstructions：条件不满足跳过、表达式解析为 value', () => {
  const list = [
    ins({ id: 'skip', when: [{ path: '$.a', op: 'lt', value: '5', valueType: 'number' }] }),
    ins({ id: 'expr', valueExpr: '${$.a} + ${$.b}' }),
    ins({ id: 'plain', value: 'hello' }),
  ];
  const r = resolveInstructions(list, root);
  assert.deepEqual(r.instructions.map(i => i.id), ['expr', 'plain']);
  const expr = r.instructions.find(i => i.id === 'expr')!;
  assert.equal(expr.value, '15');
  assert.equal(expr.valueType, 'number');
  assert.equal(expr.valueExpr, undefined, '解析后清掉 valueExpr，避免适配器误读');
  assert.equal(r.errors.length, 1);
});

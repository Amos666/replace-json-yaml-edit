import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, compilePath, pathToString } from '../../src/core/index.ts';

test('§5.1 精确定位', () => {
  assert.deepEqual(parsePath('$.a.b[0].c'), ['a', 'b', 0, 'c']);
  assert.deepEqual(parsePath('a.b[0].c'), ['a', 'b', 0, 'c']);
});

test('§5.1 数组通配与对象键通配', () => {
  assert.deepEqual(parsePath('$.items[*].name'), ['items', '*', 'name']);
  assert.deepEqual(parsePath('$.*.port'), ['*', 'port']);
  assert.deepEqual(compilePath('$.items[*].name')[1], { kind: 'wildcard' });
});

test('§5.1 含点/特殊字符的键', () => {
  assert.deepEqual(parsePath('$.a["weird.key"]'), ['a', 'weird.key']);
  assert.deepEqual(parsePath("$.a['x y']"), ['a', 'x y']);
});

test('§5.1 转义与往返', () => {
  assert.deepEqual(parsePath('$.a["say\\"hi"]'), ['a', 'say"hi']);
  assert.equal(pathToString(['a', 'weird.key']), '$.a["weird.key"]');
  assert.equal(pathToString(['items', 0, 'name']), '$.items[0].name');
});

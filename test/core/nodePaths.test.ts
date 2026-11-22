import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPreviewNodes } from '../../src/core/nodePaths.ts';

test('nodePaths：JSON 对象/数组逐层路径与行号', () => {
  const text = '{\n  "aa": 1,\n  "bb": { "cc": [3, 4] }\n}\n';
  const nodes = collectPreviewNodes(text, 'json');
  const paths = nodes.map(n => n.path);
  assert.ok(paths.includes('$.aa'));
  assert.ok(paths.includes('$.bb'));
  assert.ok(paths.includes('$.bb.cc'));
  assert.ok(paths.includes('$.bb.cc[0]'));
  assert.ok(paths.includes('$.bb.cc[1]'));
  assert.equal(nodes.find(n => n.path === '$.aa')!.line, 2);
  assert.equal(nodes.find(n => n.path === '$.aa')!.type, 'number');
  assert.equal(nodes.find(n => n.path === '$.bb.cc')!.type, 'array');
});

test('nodePaths：YAML 嵌套映射路径', () => {
  const text = 'aa: 1\nbb:\n  cc: 3\n';
  const nodes = collectPreviewNodes(text, 'yaml');
  const paths = nodes.map(n => n.path);
  assert.ok(paths.includes('$.aa'));
  assert.ok(paths.includes('$.bb.cc'));
  assert.equal(nodes.find(n => n.path === '$.bb.cc')!.type, 'number');
});

test('nodePaths：文本/非法格式返回空', () => {
  assert.deepEqual(collectPreviewNodes('plain text', 'text'), []);
  assert.deepEqual(collectPreviewNodes('{bad json', 'json'), []);
});

test('nodePaths：maxLines 截断', () => {
  const text = '{\n' + Array.from({ length: 20 }, (_, i) => `  "k${i}": ${i}`).join(',\n') + '\n}\n';
  const all = collectPreviewNodes(text, 'json');
  const limited = collectPreviewNodes(text, 'json', 5);
  assert.ok(all.length > limited.length);
  assert.ok(limited.every(n => n.line <= 5));
});

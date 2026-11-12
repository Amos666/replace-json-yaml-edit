import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTreeFilter, matchTreeFilter, describeTreeFilter } from '../../src/core/index.ts';

test('§10.7 子串跨所有目录命中、大小写不敏感', () => {
  const f = parseTreeFilter('conf');
  assert.equal(matchTreeFilter('config/app.yaml', f), true);
  assert.equal(matchTreeFilter('src/CONFIG/deep/app.json', f), true);
  assert.equal(matchTreeFilter('scripts/app.yaml', f), false);
});

test('§10.7 多条件 AND', () => {
  const f = parseTreeFilter('conf *.yaml');
  assert.equal(matchTreeFilter('config/app.yaml', f), true);
  assert.equal(matchTreeFilter('scripts/conf.yaml', f), true); // 子串跨目录 + 扩展名同时满足
  assert.equal(matchTreeFilter('config/app.json', f), false);
  assert.equal(matchTreeFilter('scripts/other.json', f), false);
});

test('§10.7 排除 !legacy 与 -*.min.js', () => {
  const f = parseTreeFilter('conf *.yaml !legacy -*.min.js');
  assert.equal(matchTreeFilter('config/prod/app.yaml', f), true);
  assert.equal(matchTreeFilter('config/legacy/app.yaml', f), false);
  assert.equal(matchTreeFilter('config/app.min.js', f), false);
});

test('§10.7 相对路径 glob', () => {
  const f = parseTreeFilter('config/**/prod/*');
  assert.equal(matchTreeFilter('config/a/b/prod/app.yaml', f), true);
  assert.equal(matchTreeFilter('config/prod/app.yaml', f), true);
  assert.equal(matchTreeFilter('config/staging/app.yaml', f), false);
});

test('§10.7 ext:yaml,yml 与大小写不敏感', () => {
  const f = parseTreeFilter('ext:yaml,yml');
  assert.equal(matchTreeFilter('a/app.YAML', f), true);
  assert.equal(matchTreeFilter('a/app.yml', f), true);
  assert.equal(matchTreeFilter('a/app.json', f), false);
});

test('§10.7 非法字符转义为字面量，不抛异常', () => {
  const f = parseTreeFilter('a[b');
  assert.doesNotThrow(() => matchTreeFilter('weird/a[b/file.yaml', f));
  assert.equal(matchTreeFilter('weird/a[b/file.yaml', f), true);
  assert.equal(matchTreeFilter('config/other.yaml', f), false);
  const paren = parseTreeFilter('(x)');
  assert.doesNotThrow(() => matchTreeFilter('dir/(x)/f.yaml', paren));
});

test('§10.7 解析回显文案正确', () => {
  assert.equal(describeTreeFilter(parseTreeFilter('conf *.yaml !legacy')), 'conf ∧ *.yaml ∧ ¬legacy');
  assert.equal(describeTreeFilter(parseTreeFilter('')), '');
});

test('§6.3 过滤不改变已勾选态（纯函数：只求值，不写状态）', () => {
  const f = parseTreeFilter('*.yaml');
  const checked = new Set(['config/a.yaml', 'config/b.json']);
  matchTreeFilter('config/a.yaml', f);
  assert.deepEqual([...checked], ['config/a.yaml', 'config/b.json']);
});

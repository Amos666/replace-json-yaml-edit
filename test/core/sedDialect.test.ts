import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSed } from '../../src/core/index.ts';

test('§10.2 s/foo/bar/g 与标志组合', () => {
  const r = parseSed('s/foo/bar/g');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.fields, {
      engine: 'text', textOp: 'replace', pattern: 'foo', replacement: 'bar', flags: 'g',
    });
  }
  const gi = parseSed('s/foo/bar/gi');
  assert.equal(gi.ok, true);
  if (gi.ok) assert.equal(gi.fields.flags, 'gi');
});

test('§10.2 自定义分隔符 s|a|b| 与 ~', () => {
  const pipe = parseSed('s|foo|bar|g');
  assert.equal(pipe.ok, true);
  if (pipe.ok) assert.equal(pipe.fields.pattern, 'foo');
  const tilde = parseSed('s~foo~bar~i');
  assert.equal(tilde.ok, true);
  if (tilde.ok) assert.equal(tilde.fields.flags, 'i');
});

test('§10.2 \\1 转 $1、\\/ 还原、转义保留', () => {
  const r = parseSed('s/registry\\.acme\\/payments:v1/\\1-x/g');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fields.pattern, 'registry\\.acme/payments:v1');
    assert.equal(r.fields.replacement, '$1-x');
  }
});

test('§10.2 /pat/d 识别为 deleteLine', () => {
  const r = parseSed('/^\\s*#\\s*TODO.*$/d');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fields.textOp, 'deleteLine');
    assert.equal(r.fields.pattern, '^\\s*#\\s*TODO.*$');
  }
});

test('§10.2 非法 flag / 非法正则报错', () => {
  const badFlag = parseSed('s/foo/bar/z');
  assert.equal(badFlag.ok, false);
  if (!badFlag.ok) assert.match(badFlag.error, /flag/);
  const badRe = parseSed('s/(/x/g');
  assert.equal(badRe.ok, false);
  if (!badRe.ok) assert.match(badRe.error, /正则/);
});

test('§10.2 不支持特性给友好报错（; / p / w / \\U）', () => {
  for (const expr of ['s/a/b/g;h', '/pat/p', '/pat/w', 's/a/\\Ub/g', '1,10d']) {
    const r = parseSed(expr);
    assert.equal(r.ok, false, expr);
    if (!r.ok) assert.ok(r.error.length > 0, expr);
  }
});

test('§5.3 无 g 时仅首个命中（保留原 flags）', () => {
  const r = parseSed('s/foo/bar/');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.fields.flags, '');
});

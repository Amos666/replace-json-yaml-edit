import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllDocuments } from 'yaml';
import {
  planJsonc,
  planYaml,
  planText,
  planFile,
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

test('§7.2 YAML insert 新键（0.1.5 修复：不再产生 0 补丁）', () => {
  const before = 'version: 1\nconfig:\n  host: localhost\n  port: 8080\ntags:\n  - a\n';
  const nested = planYaml(before, [structured('i1', 'yaml', 'insert', '$.config.newKey', 'hello', 'string')]);
  assert.equal(nested.patches.length, 1);
  assert.equal(
    applyPatches(before, nested.patches),
    'version: 1\nconfig:\n  host: localhost\n  port: 8080\n  newKey: "hello"\ntags:\n  - a\n',
  );
  const root = planYaml(before, [structured('i2', 'yaml', 'insert', '$.added', '42', 'number')]);
  assert.equal(applyPatches(before, root.patches).includes('added: 42'), true);
  const seq = planYaml(before, [structured('i3', 'yaml', 'insert', '$.tags[2]', 'c', 'string')]);
  assert.match(applyPatches(before, seq.patches), /  - "c"\n$/);
  const obj = planYaml(before, [structured('i4', 'yaml', 'insert', '$.meta', '{"a":1}', 'object')]);
  assert.match(applyPatches(before, obj.patches), /meta: \{"a":1\}\n/);
});

test('§7.2 YAML 删除父节点时子节点一并删除（0.1.5 修复）', () => {
  const before = 'version: 1\nconfig:\n  host: localhost\n  port: 8080\n  debug: true\ntags:\n  - a\n  - b\n';
  const r = planYaml(before, [structured('d', 'yaml', 'delete', '$.config')]);
  const after = applyPatches(before, r.patches);
  assert.equal(after, 'version: 1\ntags:\n  - a\n  - b\n');
  const r2 = planYaml(before, [structured('d2', 'yaml', 'delete', '$.tags')]);
  assert.equal(applyPatches(before, r2.patches), 'version: 1\nconfig:\n  host: localhost\n  port: 8080\n  debug: true\n');
  const r3 = planYaml(before, [structured('d3', 'yaml', 'delete', '$.config.host')]);
  assert.equal(applyPatches(before, r3.patches).includes('host: localhost'), false);
});

test('§7.1 JSON 删除多行父节点时子节点一并删除', () => {
  const before = '{\n  "version": 1,\n  "config": {\n    "host": "localhost",\n    "port": 8080\n  },\n  "tags": ["a", "b"]\n}\n';
  const r = planJsonc(before, [structured('d', 'json', 'delete', '$.config')]);
  const after = applyPatches(before, r.patches);
  assert.equal(after, '{\n  "version": 1,\n  "tags": ["a", "b"]\n}\n');
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

/* ── 0.2.1：路径穿过标量父节点时不抛异常，降级为跳过 + 明确说明 ── */
test('0.2.1 JSON insert 到标量子键不抛错，跳过并记录原因', () => {
  const before = '{\n  "name": "demo",\n  "image": "old:v1",\n  "config": { "host": "localhost" }\n}\n';
  const mk = (kind: 'set' | 'delete' | 'insert', path: string) =>
    structured('i', 'json', kind, path, 'x', 'string');
  for (const path of ['$.name.foo', '$.image.a.b']) {
    for (const kind of ['insert', 'set', 'delete'] as const) {
      const r = planJsonc(before, [mk(kind, path)]);
      assert.ok(Array.isArray(r.parseErrors), `${kind} ${path} 应给出跳过说明`);
      assert.match(r.parseErrors!.join(' '), /父节点不是对象|无法写入/, `${kind} ${path} 说明应指明标量父节点`);
      assert.equal(applyPatches(before, r.patches), before, `${kind} ${path} 不应产生补丁`);
    }
  }
  // 正常路径仍照常工作
  const ok = planJsonc(before, [structured('i2', 'json', 'insert', '$.config.port', '8080', 'number')]);
  assert.equal(ok.patches.length, 1);
  assert.match(applyPatches(before, ok.patches), /"port": 8080/);
});

test('0.2.1 值解析失败不抛错，跳过并记录原因', () => {
  const before = '{ "n": 1 }\n';
  const r = planJsonc(before, [structured('i', 'json', 'set', '$.n', 'not-a-number', 'number')]);
  assert.ok(r.parseErrors?.length, '非法数值应被记录而非抛出');
  assert.match(r.parseErrors!.join(' '), /无法解析|值无法解析/);
});

test('0.2.1 planFile 遇到标量父节点路径不抛异常，只记账跳过', () => {
  const before = '{\n  "name": "demo",\n  "config": { "host": "localhost" }\n}\n';
  const ins = [
    structured('i1', 'json', 'insert', '$.name.foo', 'x', 'string'),
    structured('i2', 'json', 'set', '$.config.host', 'newhost', 'string'),
  ];
  // planFile 是 core 层的统一入口，必须不抛，且正常指令仍产生补丁
  const plan = planFile(before, 'app.json', ins);
  assert.equal(plan.patches.length, 1, '正常 set 指令应仍产生 1 处补丁');
  assert.ok(plan.parseErrors?.some((e) => /父节点|无法写入/.test(e)), '标量父节点路径应被记录为跳过');
  assert.match(applyPatches(before, plan.patches), /newhost/);
});

/* ── 0.2.2：新增 key 沿用原文件缩进，最小修改、不全量格式化 ── */
test('0.2.2 JSON 新增 key 沿用 2/4 空格与 tab 缩进，不改已有内容', () => {
  const cases: Array<[string, string, string]> = [
    ['2空格', '{\n  "a": 1,\n  "b": 2\n}\n', '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n'],
    ['4空格', '{\n    "a": 1,\n    "b": 2\n}\n', '{\n    "a": 1,\n    "b": 2,\n    "c": 3\n}\n'],
    ['tab', '{\n\t"a": 1,\n\t"b": 2\n}\n', '{\n\t"a": 1,\n\t"b": 2,\n\t"c": 3\n}\n'],
    ['单行内联', '{ "a": 1, "b": 2 }\n', '{ "a": 1, "b": 2, "c": 3 }\n'],
  ];
  for (const [label, before, expected] of cases) {
    const r = planJsonc(before, [structured('i', 'json', 'insert', '$.c', '3', 'number')]);
    assert.equal(r.patches.length, 1, `${label} 应产生 1 处补丁`);
    assert.equal(applyPatches(before, r.patches), expected, `${label} 新增 key 缩进应与原文件一致`);
    // 最小修改：补丁是纯插入（start===end），且 newText 不含任何已有 key 名
    assert.equal(r.patches[0].start, r.patches[0].end, `${label} 应只插入、不替换已有内容`);
  }
});

test('0.2.2 JSON 嵌套对象新增 key 沿用父级缩进', () => {
  const before = '{\n  "cfg": {\n    "host": "x"\n  }\n}\n';
  const r = planJsonc(before, [structured('i', 'json', 'insert', '$.cfg.port', '8080', 'number')]);
  assert.equal(applyPatches(before, r.patches), '{\n  "cfg": {\n    "host": "x",\n    "port": 8080\n  }\n}\n');
});

test('0.2.2 JSON CRLF 文件新增 key 不混用换行符', () => {
  const before = '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n';
  const r = planJsonc(before, [structured('i', 'json', 'insert', '$.c', '3', 'number')]);
  const after = applyPatches(before, r.patches);
  assert.equal(after, '{\r\n  "a": 1,\r\n  "b": 2,\r\n  "c": 3\r\n}\r\n');
  assert.ok(!/(^|[^\r])\n/.test(after.replace(/\r\n/g, '')), '不应出现孤立 LF');
});

test('0.2.2 YAML 新增 key 沿用嵌套缩进；末尾无换行时补换行不挤行', () => {
  // 嵌套 2/4 空格
  for (const [ind, expected] of [
    ['  ', 'server:\n  host: localhost\n  port: 8080\n  timeout: 30\n'],
    ['    ', 'server:\n    host: localhost\n    port: 8080\n    timeout: 30\n'],
  ] as Array<[string, string]>) {
    const before = `server:\n${ind}host: localhost\n${ind}port: 8080\n`;
    const r = planYaml(before, [structured('i', 'yaml', 'insert', '$.server.timeout', '30', 'number')]);
    assert.equal(applyPatches(before, r.patches), expected);
  }
  // 末尾无换行
  const noNl = 'server:\n  host: localhost';
  const r2 = planYaml(noNl, [structured('i', 'yaml', 'insert', '$.server.port', '30', 'number')]);
  assert.equal(applyPatches(noNl, r2.patches), 'server:\n  host: localhost\n  port: 30\n');
});

/* ── 0.2.2：删除命令必须在 diff 中体现为 − 行 ── */
test('0.2.2 删除命令的 diff 含 remove 行（− 体现删除）', () => {
  const before = 'name: demo\nimage: old:v1\nenv: dev\nconfig:\n  host: localhost\n';
  const plan = planFile(before, 'a.yaml', [structured('d', 'yaml', 'delete', '$.env')]);
  const after = applyPatches(before, plan.patches);
  assert.ok(!/env: dev/.test(after), '删除后 env 行应消失');
  // 用与宿主 makeFileDiff 相同的 diffLines 算法（此处内联等价实现校验 remove 行）
  const bl = before.split('\n');
  const al = after.split('\n');
  let start = 0;
  while (start < bl.length && start < al.length && bl[start] === al[start]) start += 1;
  let eb = bl.length - 1;
  let ea = al.length - 1;
  while (eb >= start && ea >= start && bl[eb] === al[ea]) { eb -= 1; ea -= 1; }
  const removed: string[] = [];
  for (let i = start; i <= eb; i += 1) removed.push(bl[i]);
  assert.ok(removed.includes('env: dev'), `删除行应作为 remove 出现在 diff：${JSON.stringify(removed)}`);
});

/* ── 0.2.3：深层路径新增、数组父降级、多命令顺序与缩进 ── */
test('0.2.3 深层路径中间段不存在：创建嵌套对象、键序与逐层缩进正确', () => {
  const before = '{\n  "config": {\n    "host": "localhost"\n  }\n}\n';
  const r = planJsonc(before, [structured('i', 'json', 'insert', '$.config.bbb.aa', '33333', 'number')]);
  assert.equal(r.patches.length, 1, '应产生 1 处纯插入补丁');
  assert.equal(r.patches[0].start, r.patches[0].end, '只插入不替换');
  assert.equal(applyPatches(before, r.patches),
    '{\n  "config": {\n    "host": "localhost",\n    "bbb": {\n      "aa": 33333\n    }\n  }\n}\n');
});

test('0.2.3 顶层两级不存在：逐层嵌套、每层 +2 缩进', () => {
  const before = '{ "a": 1 }\n';
  const r = planJsonc(before, [structured('i', 'json', 'insert', '$.new.x.y', '9', 'number')]);
  assert.equal(applyPatches(before, r.patches), '{ "a": 1, "new": {"x":{"y":9}} }\n');
});

test('0.2.3 数组父节点用字符串键：降级为追加对象元素，不再报错跳过', () => {
  const before = '{\n  "tags": [\n    "a",\n    "b"\n  ]\n}\n';
  const r = planJsonc(before, [structured('i', 'json', 'insert', '$.tags.bbb.aa', '33333', 'number')]);
  assert.equal(r.patches.length, 1, '应产生补丁而非跳过');
  assert.ok(!r.parseErrors?.length, `不应报错：${JSON.stringify(r.parseErrors)}`);
  const out = applyPatches(before, r.patches);
  assert.match(out, /"bbb"/);
  assert.match(out, /"aa": 33333/);
  // 结果仍是合法 JSON
  assert.doesNotThrow(() => JSON.parse(out));
  // 缩进沿用：新增对象元素 4 空格、其内 6 空格
  assert.match(out, /\n    \{\n      "bbb": \{\n        "aa": 33333\n      \}\n    \}/);
});

test('0.2.3 多命令同父新增：按指令顺序、逐个沿用缩进（不逆序、不挤行）', () => {
  const before = '{\n  "a": 1\n}\n';
  const list = [
    structured('i1', 'json', 'insert', '$.c', '3', 'number'),
    structured('i2', 'json', 'insert', '$.d', '4', 'number'),
    structured('i3', 'json', 'insert', '$.e', '5', 'number'),
  ];
  const r = planJsonc(before, list);
  assert.equal(applyPatches(before, r.patches),
    '{\n  "a": 1,\n  "c": 3,\n  "d": 4,\n  "e": 5\n}\n');
});

test('0.2.3 混合深度多命令：深层与顶层都正确、顺序稳定', () => {
  const before = '{\n  "config": {\n    "host": "x"\n  }\n}\n';
  const list = [
    structured('i1', 'json', 'insert', '$.config.port', '8080', 'number'),
    structured('i2', 'json', 'insert', '$.extra', '1', 'number'),
  ];
  const r = planJsonc(before, list);
  const out = applyPatches(before, r.patches);
  assert.match(out, /"port": 8080/);
  assert.match(out, /"extra": 1/);
  assert.doesNotThrow(() => JSON.parse(out));
  // 每个新增键都换行 + 沿用缩进
  assert.ok(!/"host": "x","port"/.test(out), '深层新增不能挤在上一行');
  assert.match(out, /\},\n  "extra": 1/, '顶层新增应换行并沿用 2 空格缩进');
});


/* ── 0.2.3：YAML 深层路径新增、数组父降级（用户报告 $.tags.bbb.aa = 33333） ── */
test('0.2.3 YAML 深层路径中间段不存在：创建嵌套映射、逐层缩进正确', () => {
  const before = 'version: 1\nname: demo\ntags:\n  - a\n  - b\nmetadata:\n  owner: me\n  tier: gold\n';
  const r = planYaml(before, [structured('i', 'yaml', 'insert', '$.metadata.bbb.aa', '33333', 'number')]);
  assert.equal(r.patches.length, 1, '应产生 1 处纯插入补丁');
  assert.equal(r.patches[0].start, r.patches[0].end, '只插入不替换');
  assert.ok(!r.parseErrors?.length, `不应报错：${JSON.stringify(r.parseErrors)}`);
  assert.equal(applyPatches(before, r.patches),
    'version: 1\nname: demo\ntags:\n  - a\n  - b\nmetadata:\n  owner: me\n  tier: gold\n  bbb:\n    aa: 33333\n');
});

test('0.2.3 YAML 顶层两级不存在：逐层嵌套、每层 +2 缩进', () => {
  const before = 'version: 1\nname: demo\ntags:\n  - a\n  - b\nmetadata:\n  owner: me\n  tier: gold\n';
  const r = planYaml(before, [structured('i', 'yaml', 'insert', '$.new.x.y', '33333', 'number')]);
  assert.equal(applyPatches(before, r.patches),
    'version: 1\nname: demo\ntags:\n  - a\n  - b\nmetadata:\n  owner: me\n  tier: gold\nnew:\n  x:\n    y: 33333\n');
});

test('0.2.3 YAML 数组父节点用字符串键：降级为追加对象元素，不再静默跳过', () => {
  const before = 'version: 1\nname: demo\ntags:\n  - a\n  - b\nmetadata:\n  owner: me\n  tier: gold\n';
  const r = planYaml(before, [structured('i', 'yaml', 'insert', '$.tags.bbb.aa', '33333', 'number')]);
  assert.equal(r.patches.length, 1, '应产生补丁而非 0 补丁跳过');
  assert.ok(!r.parseErrors?.length, `不应报错：${JSON.stringify(r.parseErrors)}`);
  const out = applyPatches(before, r.patches);
  assert.equal(out,
    'version: 1\nname: demo\ntags:\n  - a\n  - b\n  - bbb:\n      aa: 33333\nmetadata:\n  owner: me\n  tier: gold\n');
});

test('0.2.3 YAML 深层新增结果仍是合法 YAML 且结构正确', () => {
  const before = 'version: 1\nname: demo\ntags:\n  - a\n  - b\nmetadata:\n  owner: me\n  tier: gold\n';
  for (const path of ['$.tags.bbb.aa', '$.metadata.bbb.aa', '$.new.x.y']) {
    const r = planYaml(before, [structured('i', 'yaml', 'insert', path, '33333', 'number')]);
    const out = applyPatches(before, r.patches);
    const docs = parseAllDocuments(out);
    assert.equal(docs[0].errors.length, 0, `${path} 结果应为合法 YAML`);
    const js: any = docs[0].toJS();
    if (path === '$.tags.bbb.aa') assert.deepEqual(js.tags[2], { bbb: { aa: 33333 } });
    if (path === '$.metadata.bbb.aa') assert.deepEqual(js.metadata.bbb, { aa: 33333 });
    if (path === '$.new.x.y') assert.deepEqual(js.new, { x: { y: 33333 } });
  }
});


test('0.2.3 YAML 多命令同父新增：按指令顺序、不逆序', () => {
  const before = 'version: 1\nname: demo\nmetadata:\n  owner: me\n';
  const r = planYaml(before, [
    structured('i1', 'yaml', 'insert', '$.aaa', '1', 'number'),
    structured('i2', 'yaml', 'insert', '$.bbb', '2', 'number'),
    structured('i3', 'yaml', 'insert', '$.ccc', '3', 'number'),
  ]);
  assert.equal(applyPatches(before, r.patches),
    'version: 1\nname: demo\nmetadata:\n  owner: me\naaa: 1\nbbb: 2\nccc: 3\n');
});

test('0.2.3 YAML 用户场景：两条顶层新增 + 深层 $.tags.bbb.aa 均生效、缩进正确', () => {
  const before = 'version: 1\nname: demo\ntags:\n  - a\n  - b\nmetadata:\n  owner: me\n  tier: gold\n';
  const r = planYaml(before, [
    structured('i1', 'yaml', 'insert', '$.aaa', '1', 'number'),
    structured('i2', 'yaml', 'insert', '$.bbb', '2', 'number'),
    structured('i3', 'yaml', 'insert', '$.tags.bbb.aa', '33333', 'number'),
  ]);
  assert.ok(!r.parseErrors?.length, `不应报错：${JSON.stringify(r.parseErrors)}`);
  const out = applyPatches(before, r.patches);
  assert.equal(out,
    'version: 1\nname: demo\ntags:\n  - a\n  - b\n  - bbb:\n      aa: 33333\nmetadata:\n  owner: me\n  tier: gold\naaa: 1\nbbb: 2\n');
  const js: any = parseAllDocuments(out)[0].toJS();
  assert.equal(parseAllDocuments(out)[0].errors.length, 0, '结果应为合法 YAML');
  assert.equal(js.aaa, 1);
  assert.equal(js.bbb, 2);
  assert.deepEqual(js.tags[2], { bbb: { aa: 33333 } });
});

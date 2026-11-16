import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSelection,
  effectiveFiles,
  isSelected,
  setSelected,
  applyBatch,
  reviewQueue,
  reviewStep,
  toGlobSummary,
  resetToGlob,
} from '../../src/core/index.ts';

const all = ['config/a.yaml', 'config/b.yaml', 'scripts/c.sh', 'docs/d.md'];

test('§10.4 glob ↔ overrides 双向换算', () => {
  const s = createSelection(['config/**'], []);
  assert.equal(isSelected('config/a.yaml', s), true);
  setSelected('config/a.yaml', false, s);
  assert.equal(isSelected('config/a.yaml', s), false);
  setSelected('docs/d.md', true, s);
  assert.equal(isSelected('docs/d.md', s), true);
  assert.deepEqual(effectiveFiles(all, s).sort(), ['config/b.yaml', 'docs/d.md']);
});

test('§10.7 全选命中只作用于 H，不误伤 H 外已选项', () => {
  const s = createSelection([], []);
  setSelected('scripts/c.sh', true, s);
  applyBatch(s, ['config/a.yaml', 'config/b.yaml'], all, 'selectAll');
  assert.equal(isSelected('scripts/c.sh', s), true);
  assert.equal(isSelected('config/a.yaml', s), true);
  assert.equal(isSelected('docs/d.md', s), false);
});

test('§10.7 取消命中 / 反选命中 / 仅保留命中', () => {
  const s = createSelection([], []);
  const hits = ['config/a.yaml', 'config/b.yaml'];
  applyBatch(s, hits, all, 'selectAll');
  applyBatch(s, ['config/a.yaml'], all, 'deselectAll');
  assert.equal(isSelected('config/a.yaml', s), false);
  assert.equal(isSelected('config/b.yaml', s), true);

  applyBatch(s, hits, all, 'invert');
  assert.equal(isSelected('config/a.yaml', s), true);
  assert.equal(isSelected('config/b.yaml', s), false);

  setSelected('scripts/c.sh', true, s);
  applyBatch(s, hits, all, 'keepOnly');
  assert.equal(isSelected('config/a.yaml', s), true);
  assert.equal(isSelected('config/b.yaml', s), true);
  assert.equal(isSelected('scripts/c.sh', s), false);
});

test('§10.7 目录节点「仅勾选本目录命中项」', () => {
  const s = createSelection([], []);
  applyBatch(s, all.filter(x => x.startsWith('config/')), all, 'selectAll');
  assert.equal(isSelected('config/a.yaml', s), true);
  assert.equal(isSelected('scripts/c.sh', s), false);
});

test('§10.7 清除筛选保留勾选态', () => {
  const s = createSelection([], []);
  applyBatch(s, ['config/a.yaml'], all, 'selectAll');
  const before = isSelected('config/a.yaml', s);
  s.treeFilter = { ...s.treeFilter, raw: '', include: [], exclude: [] };
  assert.equal(isSelected('config/a.yaml', s), before);
});

test('§10.7 逐个审阅队列按相对路径稳定排序，每步即时写 overrides', () => {
  const q = reviewQueue(['docs/d.md', 'config/b.yaml', 'config/a.yaml']);
  assert.deepEqual(q, ['config/a.yaml', 'config/b.yaml', 'docs/d.md']);
  const s = createSelection([], []);
  let r = reviewStep(s, q, 0, 'selectNext');
  assert.equal(isSelected('config/a.yaml', s), true);
  assert.equal(r.index, 1);
  r = reviewStep(s, q, r.index, 'skip');
  assert.equal(isSelected('config/b.yaml', s), false);
  r = reviewStep(s, q, r.index, 'prev');
  assert.equal(r.index, 1);
  r = reviewStep(s, q, r.index, 'selectRest');
  assert.equal(r.active, false);
  assert.equal(isSelected('docs/d.md', s), true);
});

test('§10.7 审阅空队列与队列末尾处理', () => {
  const s = createSelection([], []);
  assert.equal(reviewStep(s, [], 0, 'selectNext').active, false);
  assert.equal(reviewStep(s, ['a'], 0, 'end').active, false);
  assert.equal(reviewStep(s, ['a'], 0, 'selectNext').active, false);
});

test('§6.2 文件夹勾选生成等效 glob；重置回纯 glob', () => {
  assert.deepEqual(toGlobSummary(['config/a.yaml', 'config/b.yaml', 'README.md']), ['config/**', 'README.md']);
  const s = createSelection([], []);
  setSelected('docs/d.md', true, s);
  resetToGlob(s, ['config/**'], []);
  assert.equal(s.overrides.add.size, 0);
  assert.equal(isSelected('config/a.yaml', s), true);
  assert.equal(isSelected('docs/d.md', s), false);
});

/* ── 0.2.0：默认全不选，选择集由 overrides 累积 ───────────────── */
test('0.2.0 createSelection() 默认全不选', () => {
  const s = createSelection();
  assert.deepEqual(s.baseInclude, []);
  assert.equal(isSelected('config/a.yaml', s), false);
  assert.equal(isSelected('docs/d.md', s), false);
  assert.deepEqual(effectiveFiles(all, s), [], '默认没有任何文件进入选择集');
});

test('0.2.0 全选匹配只加入命中集，换筛选条件不清空（可多次追加）', () => {
  const s = createSelection();
  applyBatch(s, ['config/a.yaml'], all, 'selectAll'); // 第一次筛选结果
  assert.equal(isSelected('config/a.yaml', s), true);
  assert.equal(isSelected('config/b.yaml', s), false);
  assert.equal(isSelected('scripts/c.sh', s), false);
  // 模拟「换筛选条件」：第二次命中集不同，全选追加，之前选中的保留
  applyBatch(s, ['config/b.yaml', 'docs/d.md'], all, 'selectAll');
  assert.equal(isSelected('config/a.yaml', s), true, '第一次的选择应保留');
  assert.equal(isSelected('config/b.yaml', s), true);
  assert.equal(isSelected('docs/d.md', s), true);
  assert.deepEqual(effectiveFiles(all, s).sort(),
    ['config/a.yaml', 'config/b.yaml', 'docs/d.md']);
});

test('0.2.0 全选/取消全选/清空全部', () => {
  const s = createSelection();
  applyBatch(s, all, all, 'selectAll');
  assert.equal(effectiveFiles(all, s).length, all.length, '全选应选中全部');
  applyBatch(s, all, all, 'deselectAll');
  assert.deepEqual(effectiveFiles(all, s), [], '取消全选应回到全不选');

  applyBatch(s, ['config/a.yaml', 'scripts/c.sh'], all, 'selectAll');
  assert.equal(effectiveFiles(all, s).length, 2);
  applyBatch(s, [], all, 'clearAll');
  assert.deepEqual(effectiveFiles(all, s), [], '清空全部应清除所有累积选择');
  assert.equal(s.overrides.add.size, 0);
  assert.equal(s.overrides.remove.size, 0);
  assert.deepEqual(s.baseInclude, []);
});

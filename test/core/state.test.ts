import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchIncludeGlob } from '../../src/controllers/state.ts';
import type { FileScope, Instruction } from '../../src/core/index.ts';

function ins(fileScope: FileScope, enabled = true): Instruction {
  return {
    id: Math.random().toString(36).slice(2),
    enabled,
    engine: 'text',
    fileScope,
    textOp: 'replace',
    pattern: 'a',
    replacement: 'b',
    flags: 'g',
  };
}

test('searchIncludeGlob：无启用指令时返回空串（调用方跳过 findFiles）', () => {
  assert.equal(searchIncludeGlob([]), '');
  assert.equal(searchIncludeGlob([ins({ mode: 'all' }, false)]), '');
});

test('searchIncludeGlob：fileScope=all 无法收窄', () => {
  assert.equal(searchIncludeGlob([ins({ mode: 'all' })]), '**/*');
});

test('searchIncludeGlob：固定格式收窄为对应扩展名', () => {
  assert.equal(searchIncludeGlob([ins({ mode: 'fixed', format: 'json' })]), '**/*.{json,jsonc}');
  assert.equal(searchIncludeGlob([ins({ mode: 'fixed', format: 'yaml' })]), '**/*.{yaml,yml}');
});

test('searchIncludeGlob：多条固定格式合并为 brace 列表', () => {
  const glob = searchIncludeGlob([
    ins({ mode: 'fixed', format: 'json' }),
    ins({ mode: 'fixed', format: 'yaml' }),
  ]);
  assert.equal(glob, '{**/*.{json,jsonc},**/*.{yaml,yml}}');
});

test('searchIncludeGlob：custom 扩展名、通配与相对路径都保留', () => {
  assert.equal(
    searchIncludeGlob([ins({ mode: 'custom', include: ['py', 'md'] })]),
    '{**/py,**/md,**/*.{py,md}}',
  );
  assert.equal(searchIncludeGlob([ins({ mode: 'custom', include: ['*.json'] })]), '**/*.json');
  assert.equal(
    searchIncludeGlob([ins({ mode: 'custom', include: ['config/**/*.yaml'] })]),
    '**/config/**/*.yaml',
  );
});

test('searchIncludeGlob：custom 空 include 等同全部文件', () => {
  assert.equal(searchIncludeGlob([ins({ mode: 'custom', include: [] })]), '**/*');
});

test('searchIncludeGlob：只统计启用指令，忽略禁用项', () => {
  const glob = searchIncludeGlob([
    ins({ mode: 'fixed', format: 'json' }),
    ins({ mode: 'all' }, false),
  ]);
  assert.equal(glob, '**/*.{json,jsonc}');
});

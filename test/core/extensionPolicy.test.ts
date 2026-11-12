import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchScope,
  candidateExtensions,
  scopeToGlob,
  validateInstruction,
  FIXED_EXTS,
} from '../../src/core/index.ts';
import type { FileScope, Instruction } from '../../src/core/index.ts';

const f = (name: string) => ({ path: `src/${name}`, name });

function ins(id: string, scope: FileScope, enabled = true, format?: 'json' | 'yaml'): Instruction {
  return {
    id,
    enabled,
    engine: scope.mode === 'fixed' ? 'structured' : 'text',
    fileScope: scope,
    ...(format ? { format } : {}),
  };
}

function setOf(x: Set<string> | 'all'): string[] {
  assert.notEqual(x, 'all');
  return [...(x as Set<string>)].sort();
}

test('§10.7 fixed/json：.json/.jsonc/.JSON 命中，其他不命中', () => {
  const s: FileScope = { mode: 'fixed', format: 'json' };
  for (const n of ['a.json', 'a.jsonc', 'A.JSON', 'a.config.json']) {
    assert.equal(matchScope(f(n), s), true, n);
  }
  for (const n of ['a.yaml', 'a.py', 'Dockerfile', '.env']) {
    assert.equal(matchScope(f(n), s), false, n);
  }
});

test('§10.7 fixed/yaml：.yaml/.yml/.YML 命中，.json 不命中', () => {
  const s: FileScope = { mode: 'fixed', format: 'yaml' };
  for (const n of ['a.yaml', 'a.yml', 'A.YML']) assert.equal(matchScope(f(n), s), true, n);
  assert.equal(matchScope(f('a.json'), s), false);
});

test('§10.7 all：所有文件（含点文件、无扩展名）命中', () => {
  const s: FileScope = { mode: 'all' };
  for (const n of ['a.json', '.env', '.gitignore', 'Dockerfile', 'Makefile', 'a.py']) {
    assert.equal(matchScope(f(n), s), true, n);
  }
});

test('§10.7 custom include py/sh：大小写不敏感，md 不命中', () => {
  const s: FileScope = { mode: 'custom', include: ['py', 'sh'] };
  for (const n of ['a.py', 'A.PY', 'a.sh']) assert.equal(matchScope(f(n), s), true, n);
  assert.equal(matchScope(f('a.md'), s), false);
});

test('§10.7 custom 点文件/无扩展名/通配命中', () => {
  const s: FileScope = { mode: 'custom', include: ['.env', 'Dockerfile', 'Makefile', '*.tf*'] };
  for (const n of ['.env', 'Dockerfile', 'Makefile', 'app.tfvars']) {
    assert.equal(matchScope(f(n), s), true, n);
  }
  assert.equal(matchScope(f('a.md'), s), false);
  // 点文件按 basename 精确命中，未被 include 列出的不命中
  assert.equal(matchScope(f('.gitignore'), { mode: 'custom', include: ['.env'] }), false);
  assert.equal(matchScope(f('.gitignore'), { mode: 'custom', include: ['.gitignore'] }), true);
});

test('§10.7 custom exclude 优先于 include；空 include = 全部（除 exclude）', () => {
  const s: FileScope = { mode: 'custom', include: ['py', 'sh'], exclude: ['min.js', '*.lock'] };
  assert.equal(matchScope(f('app.py'), s), true);
  assert.equal(matchScope(f('app.min.js'), s), false);
  assert.equal(matchScope(f('package.lock'), s), false);
  const open: FileScope = { mode: 'custom', exclude: ['*.lock'] };
  assert.equal(matchScope(f('anything.md'), open), true);
  assert.equal(matchScope(f('package.lock'), open), false);
});

test('§10.7 candidateExtensions：并集 / all / 禁用指令不计入', () => {
  const json = ins('j', { mode: 'fixed', format: 'json' }, true, 'json');
  const yaml = ins('y', { mode: 'fixed', format: 'yaml' }, true, 'yaml');
  const all = ins('a', { mode: 'all' });
  const custom = ins('c', { mode: 'custom', include: ['env', 'sh'] });
  const disabled = ins('d', { mode: 'all' }, false);

  assert.deepEqual(setOf(candidateExtensions([json])), ['json', 'jsonc']);
  assert.deepEqual(setOf(candidateExtensions([json, yaml])), ['json', 'jsonc', 'yaml', 'yml']);
  assert.equal(candidateExtensions([json, all]), 'all');
  assert.deepEqual(setOf(candidateExtensions([disabled])), []);
  assert.deepEqual(setOf(candidateExtensions([disabled, custom])), ['env', 'sh']);
});

test('§10.7 scopeToGlob：fixed / custom / all', () => {
  assert.deepEqual(scopeToGlob({ mode: 'fixed', format: 'json' }), ['**/*.{json,jsonc}']);
  assert.deepEqual(scopeToGlob({ mode: 'fixed', format: 'yaml' }), ['**/*.{yaml,yml}']);
  assert.deepEqual(scopeToGlob({ mode: 'custom', include: ['py', 'sh'] }), ['**/*.{py,sh}']);
  assert.deepEqual(scopeToGlob({ mode: 'all' }), []);
});

test('§10.7 format 与 fileScope 一致性校验（不一致报错，不静默）', () => {
  assert.equal(validateInstruction(ins('ok', { mode: 'fixed', format: 'json' }, true, 'json')), null);
  assert.match(validateInstruction(ins('bad', { mode: 'fixed', format: 'json' }, true, 'yaml')) ?? '', /不一致/);
  const txtFixed: Instruction = {
    id: 'txt', enabled: true, engine: 'text', fileScope: { mode: 'fixed', format: 'json' },
  };
  assert.match(validateInstruction(txtFixed) ?? '', /文本指令/);
  const badStructured: Instruction = {
    id: 'bad2', enabled: true, engine: 'structured', format: 'json',
    fileScope: { mode: 'all' },
  };
  assert.match(validateInstruction(badStructured) ?? '', /fixed/);
});

test('FIXED_EXTS 固定映射', () => {
  assert.deepEqual(FIXED_EXTS.json, ['json', 'jsonc']);
  assert.deepEqual(FIXED_EXTS.yaml, ['yaml', 'yml']);
});

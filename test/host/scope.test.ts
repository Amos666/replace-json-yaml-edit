/**
 * 扫描根 / include glob 归一化（bug1、bug2 宿主侧）。
 * scan.ts 顶层 import 'vscode'，这里用与 flow.test.ts 相同的 registerHooks 注入桩。
 */
import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const stubUrl = new URL('./vscodeStub.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: stubUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { normalizeIncludeGlob } = await import('../../src/controllers/scan.ts');

test('normalizeIncludeGlob：不含分隔符的模式补任意深度前缀', () => {
  assert.equal(normalizeIncludeGlob('*.yml'), '**/*.yml');
  assert.equal(normalizeIncludeGlob(' *.env '), '**/*.env');
  assert.equal(normalizeIncludeGlob('app.yaml'), '**/app.yaml');
});

test('normalizeIncludeGlob：含路径的模式按扫描根原样使用', () => {
  assert.equal(normalizeIncludeGlob('aaa/bbbb/xs*.yml'), 'aaa/bbbb/xs*.yml');
  assert.equal(normalizeIncludeGlob('**/already/*.yml'), '**/already/*.yml');
  assert.equal(normalizeIncludeGlob('/abs/path/*.yml'), '/abs/path/*.yml');
  assert.equal(normalizeIncludeGlob('./rel/*.yml'), './rel/*.yml');
});

test('normalizeIncludeGlob：空值返回空串（调用方会过滤掉）', () => {
  assert.equal(normalizeIncludeGlob(''), '');
  assert.equal(normalizeIncludeGlob('   '), '');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXED_EXTS } from '../../src/core/types.ts';

test('FIXED_EXTS 固定映射符合 §6.1', () => {
  assert.deepEqual(FIXED_EXTS.json, ['json', 'jsonc']);
  assert.deepEqual(FIXED_EXTS.yaml, ['yaml', 'yml']);
});

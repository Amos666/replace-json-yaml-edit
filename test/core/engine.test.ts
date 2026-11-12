import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSession, applyPatches } from '../../src/core/index.ts';
import type { Instruction } from '../../src/core/index.ts';

function join(files: Array<{ uri: string; name: string; text: string }>, plans: ReturnType<typeof planSession>['plans']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const plan of plans) {
    const f = files.find(x => x.uri === plan.uri);
    if (f) out[plan.uri] = applyPatches(f.text, plan.patches);
  }
  return out;
}

test('§5.4 / §10.5 混合会话：每种文件只被其 fileScope 命中的指令改动', () => {
  const files = [
    { uri: 'config/app.yaml', name: 'app.yaml', text: 'image: old:v1\n' },
    { uri: 'config/app.json', name: 'app.json', text: '{"version":"1"}\n' },
    { uri: 'scripts/deploy.sh', name: 'deploy.sh', text: 'echo old:v1\n' },
    { uri: 'docs/readme.md', name: 'readme.md', text: '# TODO clean\nold:v1\n' },
  ];
  const instructions: Instruction[] = [
    { id: 'y', enabled: true, engine: 'structured', format: 'yaml', fileScope: { mode: 'fixed', format: 'yaml' }, kind: 'set', path: '$.image', value: 'new:v2', valueType: 'string' },
    { id: 'j', enabled: true, engine: 'structured', format: 'json', fileScope: { mode: 'fixed', format: 'json' }, kind: 'set', path: '$.version', value: '2', valueType: 'string' },
    { id: 's1', enabled: true, engine: 'text', fileScope: { mode: 'custom', include: ['sh', 'md'] }, textOp: 'replace', pattern: 'old:v1', replacement: 'new:v2', flags: 'g' },
    { id: 's2', enabled: true, engine: 'text', fileScope: { mode: 'all' }, textOp: 'deleteLine', pattern: '^\\s*#\\s*TODO' },
  ];
  const { plans } = planSession(files, instructions);
  const result = join(files, plans);
  assert.equal(result['config/app.yaml'], 'image: new:v2\n');
  assert.equal(result['config/app.json'], '{"version":"2"}\n');
  assert.equal(result['scripts/deploy.sh'], 'echo new:v2\n');
  assert.equal(result['docs/readme.md'], 'new:v2\n');
});

test('§5.4 无适用指令的文件不进结果树', () => {
  const files = [{ uri: 'a.png', name: 'a.png', text: 'binary' }];
  const instructions: Instruction[] = [
    { id: 'j', enabled: true, engine: 'structured', format: 'json', fileScope: { mode: 'fixed', format: 'json' }, kind: 'set', path: '$.a', value: '1' },
  ];
  assert.equal(planSession(files, instructions).plans.length, 0);
});

test('§5.4 同文件补丁重叠 → 冲突，不部分应用', () => {
  const files = [{ uri: 'a.txt', name: 'a.txt', text: 'abc\n' }];
  const instructions: Instruction[] = [
    { id: 't1', enabled: true, engine: 'text', fileScope: { mode: 'all' }, textOp: 'replace', pattern: 'abc', replacement: 'XYZ', flags: 'g' },
    { id: 't2', enabled: true, engine: 'text', fileScope: { mode: 'all' }, textOp: 'replace', pattern: 'b', replacement: 'Q', flags: 'g' },
  ];
  const { plans } = planSession(files, instructions);
  assert.equal(plans[0].patches.length, 0);
  assert.ok(plans[0].parseErrors?.some(e => /冲突/.test(e)));
});

test('§5.4 结构化解析失败时文本指令照常执行', () => {
  const files = [{ uri: 'bad.json', name: 'bad.json', text: '{ not json\n' }];
  const instructions: Instruction[] = [
    { id: 'j', enabled: true, engine: 'structured', format: 'json', fileScope: { mode: 'fixed', format: 'json' }, kind: 'set', path: '$.a', value: '1' },
    { id: 't', enabled: true, engine: 'text', fileScope: { mode: 'all' }, textOp: 'replace', pattern: 'not', replacement: 'NOT', flags: 'g' },
  ];
  const { plans } = planSession(files, instructions);
  assert.equal(plans[0].patches.length, 1);
  assert.ok(plans[0].parseErrors?.length);
  assert.equal(applyPatches('{ not json\n', plans[0].patches), '{ NOT json\n');
});

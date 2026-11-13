/**
 * §10.5 集成测试：在真实 VS Code Extension Host 内执行。
 * 由 test/integration/run.cjs 通过 --extensionTestsPath 加载，导出 run()。
 * 无 mocha：任一用例抛错即 runTests 返回非 0。
 */

import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { planFile, planSession } from '../../src/core/index.ts';
import type { Instruction } from '../../src/core/types.ts';

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

interface Case {
  name: string;
  fn: () => Promise<void>;
}
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>): void {
  cases.push({ name, fn });
}

function root(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'no workspace folder opened');
  return folder.uri;
}

async function readText(rel: string): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root(), rel));
  return doc.getText();
}

function extension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'replace-json-yaml-edit');
  assert.ok(ext, 'extension not loaded in Extension Host');
  return ext;
}

const TARGETS = ['config/app.json', 'config/app.yaml', 'scripts/deploy.sh', 'docs/readme.md'];

interface FindFilesCall {
  include: unknown;
  maxResults: unknown;
}

/** 拦截 workspace.findFiles，记录每次调用的 include 与上限，用于断言扫描范围。 */
async function spyFindFiles<T>(fn: (calls: FindFilesCall[]) => Promise<T>): Promise<T> {
  type AnyFn = (...args: unknown[]) => unknown;
  const ws = vscode.workspace as unknown as { findFiles: AnyFn };
  const original = ws.findFiles.bind(vscode.workspace) as AnyFn;
  const calls: FindFilesCall[] = [];
  ws.findFiles = (...args: unknown[]): unknown => {
    calls.push({ include: args[0], maxResults: args[2] });
    return original(...args);
  };
  try {
    return await fn(calls);
  } finally {
    ws.findFiles = original;
  }
}

/** §10.5 混合会话指令：YAML set + JSON set + sed custom + sed all deleteLine */
function mixedInstructions(): Instruction[] {
  return [
    { id: 'y', enabled: true, engine: 'structured', format: 'yaml', fileScope: { mode: 'fixed', format: 'yaml' }, kind: 'set', path: '$.image', value: 'new:v2', valueType: 'string' },
    { id: 'j', enabled: true, engine: 'structured', format: 'json', fileScope: { mode: 'fixed', format: 'json' }, kind: 'set', path: '$.version', value: '2', valueType: 'string' },
    { id: 's1', enabled: true, engine: 'text', fileScope: { mode: 'custom', include: ['sh', 'md'] }, textOp: 'replace', pattern: 'old:v1', replacement: 'new:v2', flags: 'g' },
    { id: 's2', enabled: true, engine: 'text', fileScope: { mode: 'all' }, textOp: 'deleteLine', pattern: '^\\s*#\\s*TODO', flags: '' },
  ];
}

test('扩展激活并注册全部命令（仅编辑器面板，无侧边栏入口）', async () => {
  const ext = extension();
  await ext.activate();
  const registered = await vscode.commands.getCommands(true);
  for (const id of [
    'structedit.openPanel',
    'structedit.useCursorPath', 'structedit.useSelectionAsPattern',
    'structedit.applyFile', 'structedit.showReport', 'structedit.selectAllMatches',
    'structedit.sequentialReview',
  ]) {
    assert.ok(registered.includes(id), `command not registered: ${id}`);
  }
  assert.ok(!registered.includes('structedit.openSidebar'), '侧边栏入口已被移除，不应注册');
});

test('Webview 资源随包分发；无指令时 openPanel 不遍历工作区', async () => {
  const ext = extension();
  for (const rel of [
    'dist/ui/panel.html', 'dist/ui/panel.css', 'dist/ui/panel.js',
    'dist/ui/codicon.css', 'dist/ui/codicon.ttf',
  ]) {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(ext.extensionUri, rel));
  }

  // 懒加载：首屏 ready 完全不扫描。这里拦截调用，确认打开面板不会 findFiles。
  await spyFindFiles(async (calls) => {
    await vscode.commands.executeCommand('structedit.openPanel');
    await delay(2000);
    assert.deepEqual(calls, [], `openPanel 在无指令时不应 findFiles，实际：${JSON.stringify(calls)}`);
  });
});

test('有启用指令时 findFiles 按 fileScope 收窄且遵守 maxFiles', async () => {
  await spyFindFiles(async (calls) => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root(), 'config/app.json'));
    const editor = await vscode.window.showTextDocument(doc);
    const line = 1; // "version": "1"
    const idx = doc.lineAt(line).text.indexOf('version');
    assert.ok(idx >= 0, 'fixture config/app.json missing version key');
    editor.selection = new vscode.Selection(line, idx, line, idx + 'version'.length);

    // useCursorPath 会 await 客户端 ready；5s 未就绪直接失败，避免用例无限挂起。
    await Promise.race([
      vscode.commands.executeCommand('structedit.useCursorPath'),
      delay(5000).then(() => { throw new Error('useCursorPath 超时：Webview 未就绪'); }),
    ]);
    await delay(2000);

    assert.ok(calls.length >= 1, '加入指令后应触发一次 findFiles');
    const last = calls[calls.length - 1];
    assert.equal(typeof last.include, 'string');
    assert.notEqual(last.include, '**/*', `include 未按 fileScope 收窄：${String(last.include)}`);
    assert.ok(String(last.include).includes('json'), `include 应包含 json：${String(last.include)}`);
    assert.equal(last.maxResults, 5000, 'maxFiles 默认值应为 5000');
  });
});

test('不注册侧边栏图标：仅 Ctrl+Alt+B 启动编辑器面板', async () => {
  const ext = extension();
  const pkgUri = vscode.Uri.joinPath(ext.extensionUri, 'package.json');
  const pkg = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(pkgUri))) as {
    contributes?: {
      viewsContainers?: unknown;
      views?: unknown;
      menus?: Record<string, unknown>;
      keybindings?: Array<{ command: string; key: string }>;
    };
  };
  assert.equal(pkg.contributes?.viewsContainers, undefined, '不应声明 activitybar 容器');
  assert.equal(pkg.contributes?.views, undefined, '不应声明侧边栏 webview views');
  assert.equal(pkg.contributes?.menus?.['view/title'], undefined, '不应有 view/title 菜单');
  const kbs = pkg.contributes?.keybindings ?? [];
  assert.equal(kbs.length, 1, `快捷键应只剩一个，实际 ${kbs.length} 个`);
  assert.equal(kbs[0].command, 'structedit.openPanel');
  assert.equal(kbs[0].key, 'ctrl+alt+b');
  await vscode.commands.executeCommand('structedit.openPanel');
  await delay(400);
});

test('§10.5 多文件 WorkspaceEdit：git diff 仅目标行，一次 Ctrl+Z 全量逐字节还原', async () => {
  const before: Record<string, string> = {};
  for (const rel of TARGETS) before[rel] = await readText(rel);

  // 按 fileScope 为每种文件挑选适用指令（与宿主扫描同逻辑）
  const byFile: Record<string, Instruction[]> = {
    'config/app.json': [mixedInstructions()[1]],
    'config/app.yaml': [mixedInstructions()[0]],
    'scripts/deploy.sh': [mixedInstructions()[2]],
    'docs/readme.md': [mixedInstructions()[2], mixedInstructions()[3]],
  };

  const docs = new Map<string, vscode.TextDocument>();
  const we = new vscode.WorkspaceEdit();
  for (const rel of TARGETS) {
    const uri = vscode.Uri.joinPath(root(), rel);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    docs.set(rel, doc);
    const plan = planFile(doc.getText(), rel, byFile[rel]);
    assert.ok(plan.patches.length > 0, `${rel}: no patches produced`);
    const edits = plan.patches.map(p =>
      new vscode.TextEdit(
        new vscode.Range(doc.positionAt(p.start), doc.positionAt(p.end)),
        p.newText,
      ),
    );
    we.set(uri, edits);
  }
  assert.ok(await vscode.workspace.applyEdit(we), 'workspace.applyEdit failed');

  // 断言逐文件内容（最小补丁：未命中内容不动）
  assert.equal(await readText('config/app.json'), before['config/app.json'].replace('"version": "1"', '"version": "2"'));
  assert.equal(await readText('config/app.yaml'), before['config/app.yaml'].replace('old:v1', 'new:v2'));
  assert.equal(await readText('scripts/deploy.sh'), before['scripts/deploy.sh'].replace('old:v1', 'new:v2'));
  assert.equal(await readText('docs/readme.md'), 'new:v2\n');

  // 逐个显式保存，确保变更落到磁盘后再做 git diff 断言
  for (const [rel, doc] of docs) {
    assert.ok(await doc.save(), `${rel}: doc.save() failed`);
  }
  for (const rel of TARGETS) {
    const disk = readFileSync(vscode.Uri.joinPath(root(), rel).fsPath, 'utf8');
    assert.equal(disk, await readText(rel), `${rel}: disk content differs from in-memory`);
  }
  const cwd = root().fsPath;
  const diff = execFileSync('git', ['diff', '--unified=0'], { cwd, encoding: 'utf8' });
  assert.equal((diff.match(/^diff --git /gm) ?? []).length, TARGETS.length, 'unexpected files in git diff');
  assert.ok(diff.includes('"version": "2"'), 'JSON target line missing from diff');
  assert.ok(!diff.includes('"name": "demo"'), 'unrelated JSON line changed');

  // 一次撤销 = 一次 Ctrl+Z（§7.5）
  await vscode.commands.executeCommand('undo');
  await delay(500);
  for (const rel of TARGETS) {
    assert.equal(await readText(rel), before[rel], `${rel} not restored by single undo`);
  }
});

test('§10.5 补例：混合会话中每种文件只被其 fileScope 命中的指令改动', async () => {
  const files = TARGETS.map(rel => ({
    uri: rel,
    name: rel.split('/').pop() ?? rel,
    text: '' ,
  }));
  // 用磁盘原文，避免依赖上一用例的撤销状态
  for (const file of files) {
    file.text = await readText(file.uri);
  }
  const { plans, skipped } = planSession(files, mixedInstructions());
  assert.equal(plans.length, TARGETS.length, 'all four files should participate');
  assert.equal(skipped.length, 0, 'no cross-format parse failures expected');

  const byUri = new Map(plans.map(p => [p.uri, p]));
  const jsonPlan = byUri.get('config/app.json');
  const yamlPlan = byUri.get('config/app.yaml');
  assert.ok(jsonPlan && yamlPlan);
  assert.equal(jsonPlan.patches.length, 1, 'JSON file must only get the JSON instruction');
  assert.equal(yamlPlan.patches.length, 1, 'YAML file must only get the YAML instruction');
});

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`PASS  ${c.name}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${c.name}: ${msg}`);
      console.error(`FAIL  ${c.name}\n${e instanceof Error ? e.stack : e}`);
    }
  }
  console.log(`\nintegration: ${cases.length - failures.length}/${cases.length} passed`);
  if (failures.length) throw new Error(`integration failures:\n- ${failures.join('\n- ')}`);
}

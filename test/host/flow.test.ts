/**
 * 「模拟整个修改流程」端到端测试（纯 Node，无需 VS Code 进程）：
 *
 *   真实宿主（src/controllers/**，经 module.registerHooks 注入 vscode 桩）
 *        ↕ Webview 消息（stubState.uiDeliver / webviewHandler）
 *   真实前端（src/ui/panel.js 跑在 jsdom 里，操作真实 DOM）
 *
 * 覆盖 5 个报告缺陷的完整用户路径：
 *   bug1 选择目录弹窗 + 默认工作区根目录 + 可选工作区外目录
 *   bug2 yml 文件在 YAML 格式下被识别、扫描并写回
 *   bug3 筛选框下面的文件列表确实渲染出数据
 *   bug4 筛选条件支持 aaa/bbbb/xs*.yml 这类路径 glob，且勾选仍以 checkbox 为准
 *   bug5 修改值后立即生效（diff 计数、预览、落盘）
 */

import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/* ── 1. 把 `import 'vscode'` 指向桩 ───────────────────────── */

const stubUrl = new URL('./vscodeStub.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: stubUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const stub = await import('./vscodeStub.ts');
const { PanelController } = await import('../../src/controllers/controller.ts');

type AnyMsg = Record<string, unknown>;

/* ── 2. fixture：一次性临时工作区（test/testdata 已 gitignore） ── */

const wsRoot = path.join(repoRoot, 'test', 'testdata', `flow-${process.pid}`);
/** 工作区之外的目录（bug1：验证可选择/扫描/改写工作区外的目录）。 */
const extRoot = path.join(repoRoot, 'test', 'testdata', `flow-ext-${process.pid}`);

function write(base: string, rel: string, content: string): void {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function read(rel: string): string {
  return fs.readFileSync(path.join(wsRoot, rel), 'utf8');
}

function setupFixtures(): void {
  fs.rmSync(wsRoot, { recursive: true, force: true });
  fs.rmSync(extRoot, { recursive: true, force: true });
  write(wsRoot, 'config/app.yaml', 'name: demo\nimage: old:v1\n');
  write(wsRoot, 'config/app.json', '{\n  "version": "1",\n  "name": "demo"\n}\n');
  write(wsRoot, 'aaa/bbbb/xs1.yml', 'image: old:v1\nenv: dev\n');
  write(wsRoot, 'aaa/bbbb/xs2.yml', 'image: old:v1\nenv: prod\n');
  write(wsRoot, 'README.md', '# demo\nold:v1\n');
  write(extRoot, 'nested/xs-ext.yml', 'image: old:v1\nenv: ext\n');
}

/* ── 3. jsdom 前端 ─────────────────────────────────────────── */

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await wait(50);
  }
}

interface Ui {
  dom: JSDOM;
  win: JSDOM['window'];
  boot: () => void;
  q: (sel: string) => Element | null;
  click: (sel: string) => Element;
  type: (sel: string, value: string) => void;
  rows: () => string[];
  lastMessages: () => AnyMsg[];
}

function createUi(html: string, onPost: (msg: AnyMsg) => void): Ui {
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://vscode-resource.example/panel.html',
  });
  const win = dom.window as unknown as {
    document: Document;
    Event: typeof Event;
    MessageEvent: typeof MessageEvent;
    eval: (code: string) => unknown;
    dispatchEvent: (e: Event) => void;
    acquireVsCodeApi?: unknown;
  };
  (win as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (m: AnyMsg) => onPost(m),
    getState: () => null,
    setState: () => {},
  });
  const panelJs = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'panel.js'), 'utf8');
  const before = stub.stubState.hostMessages.length;
  const q = (sel: string): Element | null => win.document.querySelector(sel);
  const ui: Ui = {
    dom,
    win: win as unknown as JSDOM['window'],
    boot() {
      win.eval(panelJs);
      stub.flushQueuedToHost();
    },
    q,
    click(sel) {
      const n = q(sel);
      assert.ok(n, `DOM 缺少元素：${sel}`);
      (n as HTMLElement).click();
      return n!;
    },
    type(sel, value) {
      const n = q(sel) as HTMLInputElement | null;
      assert.ok(n, `DOM 缺少输入框：${sel}`);
      n.value = value;
      n.dispatchEvent(new win.Event('input', { bubbles: true }));
    },
    rows() {
      return [...win.document.querySelectorAll('#scope-tree .tree-row.is-file')]
        .map((n) => n.getAttribute('data-path') ?? '');
    },
    lastMessages: () => stub.stubState.hostMessages.slice(before),
  };
  return ui;
}

/* ── 4. 流程 ───────────────────────────────────────────────── */

test('模拟整个修改流程：选文件 → 编辑值 → 预览 → 应用（覆盖 5 个缺陷）', async (t) => {
  setupFixtures();
  stub.resetStub({ roots: [wsRoot] });

  const ctx = {
    subscriptions: [] as Array<{ dispose(): void }>,
    extensionUri: stub.Uri.file(repoRoot),
    extensionPath: repoRoot,
    asAbsolutePath: (p: string) => path.join(repoRoot, p),
    globalState: { get: () => undefined, update: async () => {} },
    workspaceState: { get: () => undefined, update: async () => {} },
    storagePath: path.join(wsRoot, '.storage'),
    globalStoragePath: path.join(wsRoot, '.gstorage'),
    logPath: path.join(wsRoot, '.log'),
    extensionMode: 1,
  };

  const controller = new PanelController(ctx as never);
  await controller.commandOpenPanel();

  assert.equal(stub.stubState.panelCount, 1, '应创建一个 WebviewPanel');

  const html = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'panel.html'), 'utf8')
    .replace(/\{\{[A-Z_]+\}\}/g, '');
  // 先建 DOM 并接好消息通道，再执行 panel.js（其末尾会立刻 post ready），
  // 否则 init 会在 uiDeliver 就绪前送达而丢失。
  const ui = createUi(html, (m) => stub.uiToHost(m));
  stub.stubState.uiDeliver = (m) => {
    const w = ui.win as unknown as { MessageEvent: typeof MessageEvent; dispatchEvent: (e: Event) => void; };
    w.dispatchEvent(new w.MessageEvent('message', { data: m }));
  };
  ui.boot();

  await until(
    () => stub.stubState.hostMessages.some((m) => m.type === 'init'),
    '宿主下发 init',
  );

  /** 0.2.0：点击「全选匹配」并等待宿主回发 tree（按钮切换为「取消全选」即生效）。
   * 若当前视图已全选（按钮是 deselectAll）则跳过。 */
  async function selectAllVisible() {
    const btn = ui.q('.pk-result [data-action="batch"][data-op="selectAll"]') as HTMLElement | null;
    if (!btn) return;
    btn.click();
    await until(
      () => !!ui.q('.pk-result [data-action="batch"][data-op="deselectAll"]'),
      '全选匹配生效（按钮切换为取消全选）',
    );
    await wait(250);
  }
  function selectedCount(): string {
    return (ui.q('.pk-result .hit-count')?.textContent ?? '').match(/已选\s*(\d+)/)?.[1] ?? '';
  }


  /* ── bug 1a：默认根目录 = VS Code 打开的工作区根目录 ───── */

  await t.test('bug1 首开异步扫描 + 默认 JSON 隐藏无关文件与空目录', async () => {
    assert.equal(ui.q('[data-action="scan-files"]'), null, '不应再有「扫描文件」按钮');
    assert.equal(ui.q('.ov-scan-text'), null, '概览不应再有「就绪 N/M」数量对比');

    // 0.2.1：首开不点任何按钮，宿主异步后台扫描项目根目录并刷新树
    await until(
      () => stub.stubState.hostMessages.some(
        (m) => m.type === 'state' && (m.payload as AnyMsg)?.phase === 'results',
      ),
      '首开异步自动扫描完成',
    );
    const first = stub.stubState.findFilesCalls[0];
    assert.ok(first, '首开应自动调用 findFiles');
    assert.equal(first.base, null, '默认应扫描工作区根目录（非 RelativePattern）');
    // 后台异步：init 消息早于 results，页面先渲染再刷新树；且只自动扫一次
    const msgs = stub.stubState.hostMessages;
    const initIdx = msgs.findIndex((m) => m.type === 'init');
    const resultsIdx = msgs.findIndex((m) => m.type === 'state' && (m.payload as AnyMsg)?.phase === 'results');
    assert.ok(initIdx >= 0 && resultsIdx > initIdx, 'init 应先下发、results 后异步到达');
    assert.ok(!ui.q('#bottombar [data-action="apply"]'), '首开第①步底栏应只有引导');

    // 0.2.1：默认目标格式 JSON → 树里只显示 .json，其它后缀与空目录直接隐藏（不再灰显）
    const rows = ui.rows();
    assert.deepEqual(rows, ['config/app.json'], `默认 JSON 应只显示 config/app.json，实际：${rows.join(', ')}`);
    assert.equal(
      ui.win.document.querySelectorAll('#scope-tree .tree-row.is-locked').length, 0,
      '无关文件不应再以灰显行出现',
    );
    assert.equal(
      [...ui.win.document.querySelectorAll('#scope-tree .tree-row.is-dir')]
        .filter((n) => /aaa|bbbb/.test(n.getAttribute('data-path') || '')).length, 0,
      '不含可见文件的空目录不应显示',
    );

    // 切到 YAML 目标格式，供后续用例继续（后续都是结构化 YAML 指令）
    ui.click('[data-action="target-format"][data-format="yaml"]');
    await until(
      () => ui.rows().length === 3 && ui.rows().every((p) => /\.ya?ml$/i.test(p)),
      `切到 YAML 后应显示 3 个 yml/yaml 文件，实际：${ui.rows().join(', ')}`,
    );
  });

  /* ── 0.2.0：默认全不选、全选/取消全选、清空全部 ───────────── */
  await t.test('默认全不选：全选匹配 / 取消全选 / 清空全部', async () => {
    assert.equal(selectedCount(), '0', '刚打开树默认全部不选中');
    const checked = ui.win.document.querySelectorAll('#scope-tree .tree-row.is-file .tri[aria-checked="true"]');
    assert.equal(checked.length, 0, '树里不应有任何已勾选行');
    assert.ok(ui.q('.pk-result [data-action="batch"][data-op="selectAll"]'), '应有「全选匹配」按钮');
    assert.ok(ui.q('.pk-result [data-action="batch"][data-op="clearAll"]'), '应有「清空全部」按钮');

    await selectAllVisible();
    const after = Number(selectedCount());
    assert.equal(after, 3, `YAML 模式下全选 3 个 yml/yaml，实际 ${selectedCount()}`);
    assert.equal(
      ui.win.document.querySelectorAll('#scope-tree .tree-row.is-file .tri[aria-checked="true"]').length,
      after, '树里勾选行数应与已选数一致',
    );

    // 再点「取消全选」→ 回到全不选
    (ui.q('.pk-result [data-action="batch"][data-op="deselectAll"]') as HTMLElement).click();
    await until(
      () => !!ui.q('.pk-result [data-action="batch"][data-op="selectAll"]'),
      '取消全选生效',
    );
    await wait(250);
    assert.equal(selectedCount(), '0', '取消全选后回到全部不选中');
  });

  /* 0.1.8：选择器单一动线 —— 结果与向导徽标同源，确认条不重复数字 */
  await t.test('picker 结构精简且计数同源', async () => {
    const result = (ui.q('.pk-result .hit-count')?.textContent ?? '').match(/已选\s*(\d+)/);
    const badge = (ui.q('.wiz-step[aria-current="step"] .wb-n')?.textContent ?? '').trim();
    assert.ok(result, '结果条应显示已选数');
    assert.equal(result[1], badge, '结果条与向导徽标的已选数必须一致');
    assert.match(ui.q('.pk-confirm-info')?.textContent ?? '', /只有勾选的文件会进入修改列表/, '确认条说明只有选中才进修改列表');
    assert.doesNotMatch(ui.q('.pk-confirm-info')?.textContent ?? '', /已选\s*\d/, '确认条不重复已选数字');
    assert.equal(ui.q('[data-action="scan-files"]'), null, '不应有扫描文件按钮');
    assert.ok(ui.q('#filter-input'), '应有唯一主过滤框');
    assert.equal(ui.q('.pk-confirm [data-action="wizard-step"]'), null, '确认条不应重复下一步按钮');
    assert.equal(ui.q('.pk-more')?.hasAttribute('hidden'), true, '更多面板默认折叠');
    // 0.1.9：第①步底栏只有上一步/下一步引导，无预览/应用/回退
    assert.equal(ui.q('#bottombar [data-action="preview-all"]'), null, '前两步不应显示预览全部 Diff');
    assert.equal(ui.q('#bottombar [data-action="apply"]'), null, '前两步不应显示应用');
    assert.equal(ui.q('#bottombar [data-action="undo-last"]'), null, '前两步不应显示一键回退');
    assert.ok(ui.q('#bottombar .bb-nav [data-action="wizard-step"][data-step="2"]'), '第①步底栏应有下一步引导');
  });

  /* ── bug 3：筛选框下面要能显示出数据 ────────────────────── */

  await t.test('bug3 筛选框下方文件列表渲染出数据', async () => {
    const tree = ui.q('#scope-tree');
    assert.ok(tree, '文件范围树容器存在');
    const fileRows = ui.rows();
    assert.ok(fileRows.length >= 3, `YAML 模式下应列出 3 个文件，实际 ${fileRows.length}`);
    const dirRows = ui.q('#scope-tree .tree-row.is-dir');
    assert.ok(dirRows, '应渲染目录行');
    // 空态 / 骨架屏都不算「显示数据」
    assert.ok(
      !ui.q('#scope-tree .state-skeleton'),
      '文件列表区域不应还是骨架屏',
    );
    const hitText = ui.q('.hit-count')?.textContent ?? '';
    assert.match(hitText, /匹配\s*3\s*\/\s*5/, `YAML 匹配 3 / 总数 5，实际「${hitText}」`);
  });

  /* ── bug 1b：选择目录弹窗（可选工作区外目录） ───────────── */

  await t.test('bug1 点「选择目录」弹窗，默认工作区根目录，可选工作区外目录并恢复', async () => {
    const pickBtn = ui.q('[data-action="pick-directory"]');
    assert.ok(pickBtn, '第 ① 步应有「选择目录…」按钮');

    // 弹窗默认定位到 VS Code 打开的根目录
    stub.stubState.openDialogResult = [extRoot];
    ui.click('[data-action="pick-directory"]');
    await until(() => stub.stubState.openDialogCalls.length >= 1, 'showOpenDialog 被调用');

    const opts = stub.stubState.openDialogCalls[0];
    assert.equal(opts.canSelectFolders, true, '弹窗应可选择文件夹');
    assert.equal(opts.canSelectMany, false, '单选目录');
    assert.equal(opts.defaultPath, wsRoot, '弹窗默认目录应为 VS Code 打开的根目录');

    await until(
      () => stub.stubState.findFilesCalls.some((c) => c.base === extRoot),
      '按所选目录作为根重新 findFiles',
    );
    // 必须等到**新根目录的文件**出现（旧树行此刻仍在 DOM 中，不能只判 rows.length > 0）
    await until(
      () => ui.rows().includes('nested/xs-ext.yml'),
      `所选目录下文件渲染，实际：${ui.rows().join(', ')}`,
    );

    const rows = ui.rows();
    assert.ok(rows.includes('nested/xs-ext.yml'), `工作区外目录应以其为根列出文件，实际：${rows.join(', ')}`);
    assert.ok(!rows.includes('config/app.yaml'), '根目录之外的文件不应出现');

    // 根目录徽标 + 恢复按钮
    assert.ok(
      ui.q('[data-action="reset-scope-root"]'),
      '选定目录后应显示「恢复工作区根目录」入口',
    );
    assert.match(
      ui.q('.scope-root-badge')?.textContent ?? '',
      /xs-ext|flow-ext/,
      '根目录徽标应显示所选目录',
    );

    ui.click('[data-action="reset-scope-root"]');
    await until(
      () => ui.rows().includes('config/app.yaml'),
      '恢复工作区根目录后重新列出根目录文件',
    );
    assert.ok(
      ui.q('[data-action="pick-directory"]'),
      '恢复后仍可再次选择目录',
    );
  });

  /* ── bug 4：路径 glob 筛选；勾选仍以 checkbox 为准 ──────── */

  await t.test('bug4 筛选支持 aaa/bbbb/xs*.yml 路径 glob，筛选只是范围、勾选为准', async () => {
    ui.type('#filter-input', 'aaa/bbbb/xs*.yml');
    await until(
      () => ui.rows().length === 2 && ui.rows().every((p) => p.includes('bbb')),
      `路径 glob 筛选后应只剩 2 个 yml，实际：${ui.rows().join(', ')}`,
    );

    // 0.2.0：默认全不选，筛选只影响显示、不改变勾选集：已选恒为 0。
    const selected = (ui.q('.hit-count')?.textContent ?? '').match(/已选\s*(\d+)/);
    assert.ok(selected, `统计栏应显示已选数量，实际「${ui.q('.hit-count')?.textContent}」`);
    assert.equal(selected[1], '0', `筛选不改变勾选，已选应仍为 0，实际 ${selected[1]}`);

    // 文件名（不带路径）glob 也要认：前端/宿主匹配必须一致
    ui.type('#filter-input', 'xs*.yml');
    await until(
      () => ui.rows().length === 2,
      `文件名 glob 筛选后应剩 2 个文件，实际：${ui.rows().join(', ')}`,
    );

    // 排除条件
    ui.type('#filter-input', 'aaa/bbbb/xs*.yml !xs2.yml');
    await until(
      () => ui.rows().length === 1 && ui.rows()[0].endsWith('xs1.yml'),
      `排除条件应生效，实际：${ui.rows().join(', ')}`,
    );

    ui.type('#filter-input', '');
    await until(() => ui.rows().length === 3, '清空筛选恢复 3 个 yml/yaml 文件');
    // 0.2.0：结果条「匹配 N」与「全选匹配 N」必须同源（同源同渲染，杜绝旧帧分裂）
    const matchN = (ui.q('.pk-result .hit-count')?.textContent ?? '').match(/匹配\s*(\d+)/)?.[1];
    const allN = (ui.q('.pk-result [data-action="batch"][data-op="selectAll"]')?.textContent ?? '').match(/(\d+)/)?.[1];
    assert.ok(matchN && allN, `应同时显示匹配数与全选按钮数，实际 match=${matchN} all=${allN}`);
    // 后锁定「不可选」的文件不计入全选按钮数（默认 JSON 下 5 个文件仅 1 个可选）
    assert.ok(Number(allN) <= Number(matchN), '全选按钮的可选数不应超过匹配数');
    assert.equal(allN, '3', `YAML 模式下 3 个 yml/yaml 可选，实际 ${allN}`);
    // 0.1.8：过滤后结果条与向导徽标仍同源
    const r1 = (ui.q('.pk-result .hit-count')?.textContent ?? '').match(/已选\s*(\d+)/);
    const b1 = (ui.q('.wiz-step[aria-current="step"] .wb-n')?.textContent ?? '').trim();
    assert.equal(r1?.[1], b1, '过滤后结果条与向导徽标已选数仍须一致');

    // 0.2.1：YAML 模式下 json/md 直接从树中隐藏（不再灰显），只剩 3 个 yml/yaml
    const rows4 = ui.rows();
    assert.equal(rows4.length, 3, `应只剩 3 个 yml/yaml，实际：${rows4.join(', ')}`);
    assert.equal(rows4.filter((p) => /\.json$|\.md$/i.test(p)).length, 0, 'json/md 不应出现在树中');
    assert.equal(
      ui.win.document.querySelectorAll('#scope-tree .tree-row.is-locked').length, 0,
      '不应再有灰显行（无关文件已隐藏）',
    );
    assert.equal(ui.q('.panel.policy .policy-lock'), null, '不应再有「扩展名策略（只读）」面板');
  });

  /* ── 0.1.9：底栏按步骤分支 + 无重复引导 ───────────────────── */
  await t.test('底栏分步：前两步引导、第③步操作、无重复引导', async () => {
    // 第②步：只有上一步/下一步
    ui.click('[data-action="wizard-step"][data-step="2"]');
    assert.equal(ui.q('#bottombar [data-action="preview-all"]'), null, '第②步不应显示预览');
    assert.equal(ui.q('#bottombar [data-action="apply"]'), null, '第②步不应显示应用');
    assert.ok(ui.q('#bottombar .bb-nav [data-action="wizard-step"][data-step="1"]'), '第②步应有上一步');
    assert.ok(ui.q('#bottombar .bb-nav [data-action="wizard-step"][data-step="3"]'), '第②步应有下一步');
    // 页面上不应再有重复的前/后一步按钮（向导条、ins-footer、pk-confirm）
    assert.equal(ui.q('#wizard .wiz-actions'), null, '向导条不应再放上一步按钮');
    assert.equal(ui.q('#ins-footer [data-action="wizard-next"]'), null, '指令区不应重复下一步');
    assert.equal(ui.q('.pk-confirm [data-action="wizard-step"]'), null, '确认条不应重复下一步');

    // 第③步：只显示三个操作按钮，不再显示引导
    ui.click('[data-action="wizard-step"][data-step="3"]');
    assert.ok(ui.q('#bottombar [data-action="preview-all"]'), '第③步应显示预览全部 Diff');
    assert.ok(ui.q('#bottombar [data-action="apply"]'), '第③步应显示应用');
    assert.ok(ui.q('#bottombar [data-action="undo-last"]'), '第③步应显示一键回退');
    assert.equal(ui.q('#bottombar .bb-nav'), null, '第③步不应再显示上一步/下一步引导');
    // 回到第①步，供后续用例继续使用
    ui.click('[data-action="wizard-step"][data-step="1"]');
  });

  /* ── bug 2：YAML 格式下 yml 文件被识别 ──────────────────── */

  await t.test('bug2 选 YAML 格式后 .yml 文件进入候选并可匹配筛选', async () => {
    // 0.2.1：此时已是 YAML 模式，json/md 隐藏、yml 可见
    assert.ok(ui.q('[data-action="target-format"][data-format="yaml"]')?.getAttribute('aria-pressed') === 'true',
      '当前应处于 YAML 目标格式');
    const ymlRows = ui.rows();
    assert.equal(ymlRows.length, 3, `应显示 3 个 yml/yaml，实际：${ymlRows.join(', ')}`);
    assert.equal(ymlRows.filter((p) => /\.json$|\.md$/i.test(p)).length, 0, 'json/md 应隐藏');
    // 0.2.0：换筛选条件逐步多次添加，每次选择逻辑一致（累积不清空）
    // 先只筛出一个子集，全选一次；再放宽条件，新出现的文件默认不选，再全选追加。
    ui.type('#filter-input', 'app.yaml');
    await until(() => ui.rows().length === 1, '先筛出单个 app.yaml');
    assert.equal(selectedCount(), '0', '新筛选结果默认全不选');
    await selectAllVisible(); // 第一次：加入 1 个
    const firstSel = Number(selectedCount());
    assert.equal(firstSel, 1, `首次全选应选中 1 个，实际 ${selectedCount()}`);
    ui.type('#filter-input', '');
    await until(() => ui.rows().length === 3, '放宽条件恢复 3 个 yml/yaml');
    assert.equal(selectedCount(), String(firstSel), '换筛选条件不应清空已选（累积保留）');
    // 新出现的 yml 文件此刻仍未勾选
    const unchecked = ui.win.document.querySelectorAll('#scope-tree .tree-row.is-file:not(.is-locked) .tri[aria-checked="false"]');
    assert.ok(unchecked.length > 0, '放宽条件后新出现的文件应默认不选中');
    await selectAllVisible(); // 第二次：同一套逻辑，追加新出现的文件
    const secondSel = Number(selectedCount());
    assert.ok(secondSel > firstSel, `第二次全选应追加新文件，${firstSel} → ${secondSel}`);
    assert.equal(secondSel, 3, `两次累积应得到 3 个可选文件，实际 ${secondSel}`);

    ui.click('[data-action="wizard-step"][data-step="2"]');
    ui.click('[data-action="add-ins"]');
    assert.ok(ui.q('[data-ins-row]'), '应新增一条指令行');

    // 指令行上的目标格式切到 YAML（fixed 扩展名应含 yml）
    ui.click('[data-action="ins-format"][data-format="yaml"]');
    const meta = ui.q('[data-ins-row] .ins-meta')?.textContent ?? '';
    assert.match(meta, /\.ya?ml/, `YAML 指令范围应显示 yaml/yml，实际「${meta}」`);
    assert.match(meta, /yml/, `YAML 指令范围必须包含 yml，实际「${meta}」`);

    ui.type('[data-ins-field="path"]', '$.image');
    ui.type('[data-ins-field="value"]', 'new:v2');
    await wait(900); // UI 防抖 300ms + 宿主防抖 200ms

    await until(
      () => /变更\s*3/.test(ui.q('#ov-stats')?.textContent ?? ''),
      `3 个 yml/yaml 文件应各产生 1 处变更，概览：${ui.q('#ov-stats')?.textContent}`,
    );

    // 筛选快捷片 *.yaml 也应能匹配 .yml（同义扩展名，bug2）
    ui.click('[data-action="wizard-step"][data-step="1"]');
    const chips = [...ui.win.document.querySelectorAll('[data-action="chip"]')];
    const chip = chips.find((n) => n.getAttribute('data-value') === '*.yaml');
    assert.ok(chip, '筛选快捷片应提供 *.yaml');
    assert.notEqual(chip?.getAttribute('aria-disabled'), 'true', '目标格式为 YAML 时 *.yaml 片应可用');
    (chip as HTMLElement).click();
    await until(
      () => ui.rows().length === 3 && ui.rows().every((p) => /\.ya?ml$/.test(p)),
      `yaml 筛选片应命中 3 个 yaml/yml 文件，实际：${ui.rows().join(', ')}`,
    );
    ui.type('#filter-input', '');
    await until(() => ui.rows().length === 3, '恢复 3 个 yml/yaml');
  });

  /* ── 0.2.2：切换目标格式 / Sed 时，可见文件一律按「可选」渲染，无灰显 ── */
  await t.test('0.2.2 切 JSON/YAML/Sed 时可选文件样式一致（无置灰）', async () => {
    // 回到第 ① 步并清空筛选
    ui.click('[data-action="wizard-step"][data-step="1"]');
    ui.click('[data-action="clear-filter"]');
    await until(() => ui.rows().length >= 3, 'YAML 模式列出 3 个 yml');

    function assertNoGray(label: string) {
      const rows = [...ui.win.document.querySelectorAll('#scope-tree .tree-row.is-file')];
      assert.ok(rows.length > 0, `${label} 应有可见文件行`);
      for (const r of rows) {
        assert.ok(!r.classList.contains('is-noncandidate'),
          `${label} 不应有 is-noncandidate 灰显：${r.getAttribute('data-path')}`);
        assert.ok(!r.classList.contains('is-locked'),
          `${label} 可见文件不应是 locked 灰显：${r.getAttribute('data-path')}`);
        const tri = r.querySelector('.tri');
        assert.notEqual(tri?.getAttribute('aria-disabled'), 'true',
          `${label} 勾选框应可选：${r.getAttribute('data-path')}`);
      }
    }
    assertNoGray('YAML');

    // 切到 JSON：只剩 .json，也应正常可选（不置灰）
    ui.click('[data-action="target-format"][data-format="json"]');
    await until(() => ui.rows().length === 1, 'JSON 模式只显示 1 个 json');
    assertNoGray('JSON');

    // 切到 Sed：全部后缀都可选，且都不灰显
    ui.click('[data-action="target-format"][data-format="sed"]');
    await until(() => ui.rows().length >= 5, 'Sed 模式应显示全部 5 个文件');
    assertNoGray('Sed');

    // 恢复 YAML，供后续用例继续
    ui.click('[data-action="target-format"][data-format="yaml"]');
    await until(() => ui.rows().length === 3 && ui.rows().every((p) => /\.ya?ml$/i.test(p)), '恢复 YAML 模式');
  });

  /* ── bug 5：修改值后立即生效 ────────────────────────────── */

  await t.test('bug5 修改值后 diff 计数更新、预览可见、应用落盘', async () => {
    ui.click('[data-action="wizard-step"][data-step="2"]');
    // 输入新值后**立即**进入第 ③ 步（不等待防抖），模拟真实快速操作
    ui.type('[data-ins-field="value"]', 'new:v3');
    ui.click('[data-action="wizard-step"][data-step="3"]');
    await wait(900);

    await until(
      () => /变更\s*3/.test(ui.q('#ov-stats')?.textContent ?? ''),
      `改值后变更计数应为 3，概览：${ui.q('#ov-stats')?.textContent}`,
    );

    // 第 ③ 步结果区要渲染出变更文件（0.2.1：只读树状目录，无勾选框）
    assert.ok(!ui.q('#sec-results')?.classList.contains('wizard-hidden'), '第 ③ 步应显示结果区');
    const resultTree = ui.q('#group-changes');
    assert.ok(resultTree, '应有变更文件树容器');
    assert.equal(resultTree?.getAttribute('role'), 'tree', '结果树应使用 tree role 与主树统一');
    const fileRows = ui.win.document.querySelectorAll('#group-changes .tree-row.is-file');
    assert.equal(fileRows.length, 3, `结果树应列出 3 个变更文件，实际 ${fileRows.length}`);
    assert.equal(
      ui.win.document.querySelectorAll('#group-changes .tri').length, 0,
      '结果树不应有任何勾选框（只读）',
    );
    // 0.2.5：改值进第③步后，宿主应主动推送新 diff（无需手点「预览全部 Diff」），
    // 右侧 Diff 区在未手动预览前就应显示新值，而不是上一轮的旧内容。
    await until(
      () => /new:v3/.test(ui.q('#results-body .diff-scroll')?.textContent ?? ''),
      '进入第③步后右侧 Diff 应已自动刷新为新值（宿主主动推送）',
    );
    const toggle = ui.q('#group-changes [data-action="result-toggle-dir"]') as HTMLElement | null;
    assert.ok(toggle, '结果树目录应可展开/折叠');
    const dirRows = ui.win.document.querySelectorAll('#group-changes .tree-row.is-dir').length;
    assert.ok(dirRows > 0, '结果树应渲染目录层级');
    // 折叠后文件行减少、再展开恢复
    toggle!.click();
    const collapsed = ui.win.document.querySelectorAll('#group-changes .tree-row.is-file').length;
    assert.ok(collapsed < 3, `折叠目录后文件行应减少，实际 ${collapsed}`);
    (ui.q('#group-changes [data-action="result-toggle-dir"]') as HTMLElement).click();
    await until(
      () => ui.win.document.querySelectorAll('#group-changes .tree-row.is-file').length === 3,
      '再次展开应恢复 3 个文件行',
    );

    // 预览 diff：显示的必须是新值
    ui.click('[data-action="preview-all"]');
    await until(() => !!ui.q('.diff-line'), 'diff 预览渲染');
    const diffText = ui.q('#results-body')?.textContent ?? '';
    assert.match(diffText, /new:v3/, 'diff 预览应包含新值 new:v3');
    assert.doesNotMatch(diffText.slice(0, 4000), /new:v2/, 'diff 预览不应残留旧值');

    // 0.2.2：双击结果树文件行 → 右侧 Diff 视图即时切换到该文件
    const treeFiles = [...ui.win.document.querySelectorAll('#group-changes .tree-row.is-file')];
    assert.ok(treeFiles.length >= 2, '结果树应有多个变更文件可切换');
    const second = treeFiles[1] as HTMLElement;
    const secondPath = second.getAttribute('data-rpath') || '';
    const secondUri = second.getAttribute('data-diff-uri') || '';
    assert.ok(secondUri, '结果树文件行应带 data-diff-uri 用于切换 diff');
    second.dispatchEvent(new ui.win.MouseEvent('dblclick', { bubbles: true }));
    const title = ui.q('#results-body .diff-title')?.textContent ?? '';
    assert.ok(title.includes(secondPath.split('/').pop() || secondPath),
      `双击后右侧 Diff 标题应指向 ${secondPath}，实际「${title}」`);

    // 应用
    const applyBtn = ui.q('[data-action="apply"]') as HTMLElement | null;
    assert.ok(applyBtn, '应有应用按钮');
    assert.notEqual(applyBtn?.getAttribute('aria-disabled'), 'true', '应用按钮不应被禁用');
    applyBtn!.click();
    // 0.1.4：点「应用」直接保存，不再弹逐条明细确认框（文件多时无法核对）
    assert.equal(
      ui.q('#confirm-modal')?.hasAttribute('hidden'),
      true,
      '点应用不应弹出确认对话框',
    );
    await until(
      () => stub.stubState.applyEditCalls > 0,
      'applyChanges 提交 WorkspaceEdit',
    );
    await until(
      () => stub.stubState.hostMessages.some((m) => m.type === 'report'),
      '宿主下发执行报告',
    );

    // 磁盘落盘（bug5 最终判据）+ bug2 的 yml 写回
    assert.equal(read('aaa/bbbb/xs1.yml'), 'image: new:v3\nenv: dev\n', 'xs1.yml 应写入新值');
    assert.equal(read('aaa/bbbb/xs2.yml'), 'image: new:v3\nenv: prod\n', 'xs2.yml 应写入新值');
    assert.equal(read('config/app.yaml'), 'name: demo\nimage: new:v3\n', 'app.yaml 应写入新值');
    assert.equal(
      read('config/app.json'),
      '{\n  "version": "1",\n  "name": "demo"\n}\n',
      'JSON 指令未配置，app.json 不应被改动',
    );
    assert.equal(read('README.md'), '# demo\nold:v1\n', 'README.md 不应被改动');
  });

  /* ── 附加：报告 / 一次撤销语义由集成测试覆盖，这里只验证宿主状态机 ── */

  await t.test('应用后宿主进入 report 阶段并给出统计', async () => {
    const report = stub.stubState.hostMessages.find((m) => m.type === 'report');
    assert.ok(report, '应收到 report 消息');
    const payload = report!.payload as AnyMsg;
    assert.equal(payload.changedFiles, 3, '变更文件数应为 3');
    assert.equal(payload.changes, 3, '变更处数应为 3');
    assert.match(stub.stubState.infoMessages.join(' '), /已修改 3 个文件/, '应弹出完成提示');
  });

  /* ── 组合：工作区外目录里选文件 → 改值 → 预览 → 应用落盘 ── */

  await t.test('bug1+bug5 对工作区外目录里的 yml 改值并应用（真实落盘）', async () => {
    stub.stubState.openDialogResult = [extRoot];
    ui.click('[data-action="pick-directory"]');
    await until(
      () => ui.rows().includes('nested/xs-ext.yml'),
      `切到工作区外目录后列出其文件，实际：${ui.rows().join(', ')}`,
    );
    // 0.2.0：新目录文件默认不选，点全选加入修改列表
    await selectAllVisible();
    assert.equal(selectedCount(), '1', '外目录唯一文件应被选中');

    // 改值：第 ② 步输入新值后直接进第 ③ 步（防抖窗口内，考验 flushPending）
    ui.click('[data-action="wizard-step"][data-step="2"]');
    ui.type('[data-ins-field="value"]', 'new:v9');
    ui.click('[data-action="wizard-step"][data-step="3"]');
    await until(
      () => /变更\s*1/.test(ui.q('#ov-stats')?.textContent ?? ''),
      `外目录下唯一文件应产生 1 处变更，概览：${ui.q('#ov-stats')?.textContent}`,
    );

    // 预览必须显示新值（宿主侧 flushRecompute 保证不拿旧补丁）；
    // 旧预览还留在 DOM 里，必须等到**本轮** diff 渲染出来。
    ui.click('[data-action="preview-all"]');
    await until(
      () => /new:v9/.test(ui.q('#results-body')?.textContent ?? ''),
      `diff 预览应更新为新值 new:v9，实际：${(ui.q('#results-body')?.textContent ?? '').slice(0, 300)}`,
    );
    const diffText = ui.q('#results-body')?.textContent ?? '';
    assert.match(diffText, /new:v9/, 'diff 预览应包含新值 new:v9');
    assert.match(diffText, /xs-ext\.yml/, 'diff 预览应指向 xs-ext.yml');

    const applyBefore = stub.stubState.applyEditCalls;
    const reportBefore = stub.stubState.hostMessages.filter((m) => m.type === 'report').length;
    (ui.q('[data-action="apply"]') as HTMLElement).click();
    await until(
      () => stub.stubState.applyEditCalls > applyBefore,
      '外目录文件的 WorkspaceEdit 已提交',
    );
    await until(
      () => stub.stubState.hostMessages.filter((m) => m.type === 'report').length > reportBefore,
      '外目录应用产生新的执行报告',
    );

    // 工作区外的真实文件必须被写回
    const extAbs = path.join(extRoot, 'nested', 'xs-ext.yml');
    assert.equal(
      fs.readFileSync(extAbs, 'utf8'),
      'image: new:v9\nenv: ext\n',
      '工作区外的 xs-ext.yml 应写入新值',
    );
    // 工作区内的文件本轮不应再被改动（范围已切到外目录）
    assert.equal(read('aaa/bbbb/xs1.yml'), 'image: new:v3\nenv: dev\n', '工作区文件保持上一轮结果');
  });

  /* ── 0.1.4：应用不再弹确认，删除类批量同样直接保存 ───────── */

  await t.test('删除类批量变更（>20 处）点「应用」直接保存，不弹确认框', async () => {
    // 造 30 个 yml，让删除类变更远超旧守卫的 20 处阈值（旧逻辑此处必弹明细确认框）
    for (let i = 0; i < 30; i += 1) {
      write(wsRoot, `bulk/b${String(i).padStart(2, '0')}.yml`, 'image: old:v1\nenv: dev\n');
    }
    assert.ok(
      ui.q('[data-action="reset-scope-root"]'),
      '上一用例后应处于自选扫描根状态',
    );
    ui.click('[data-action="reset-scope-root"]');
    await until(
      () => ui.rows().some((p) => p.startsWith('bulk/')),
      `恢复工作区根目录后应列出新建的 bulk 文件，实际：${ui.rows().join(', ')}`,
    );
    // 0.2.0：把可见文件全部加入修改列表（含新建的 30 个 bulk）
    await selectAllVisible();

    // 新增第二条指令：结构化删除 $.env（YAML）
    ui.click('[data-action="wizard-step"][data-step="2"]');
    ui.click('[data-action="add-ins"]');
    const lastInsRow = (): HTMLElement => {
      const rs = [...ui.win.document.querySelectorAll('[data-ins-row]')];
      assert.ok(rs.length >= 2, `应有两条指令行，实际 ${rs.length}`);
      return rs[rs.length - 1] as HTMLElement;
    };
    const fmtBtn = lastInsRow().querySelector('[data-action="ins-format"][data-format="yaml"]') as HTMLElement | null;
    if (fmtBtn) fmtBtn.click(); // 新指令默认跟随目标格式，这里显式钉死 YAML
    let row = lastInsRow();
    const pathInput = row.querySelector('[data-ins-field="path"]') as HTMLInputElement;
    assert.ok(pathInput, '应有路径输入框');
    pathInput.value = '$.env';
    pathInput.dispatchEvent(new ui.win.Event('input', { bubbles: true }));
    row = lastInsRow(); // kind 变更会重渲染行，必须重新取
    const opSel = row.querySelector('select[data-ins-field="kind"]') as HTMLSelectElement;
    assert.ok(opSel, '应有操作类型下拉');
    opSel.value = 'delete';
    opSel.dispatchEvent(new ui.win.Event('change', { bubbles: true }));

    // 切到第 ③ 步：set + delete 合计应 ≥20 处（超过旧守卫阈值）
    ui.click('[data-action="wizard-step"][data-step="3"]');
    await until(
      () => /变更\d{2,}/.test(ui.q('#ov-stats')?.textContent ?? ''),
      `删除类变更应 ≥20 处，概览：${ui.q('#ov-stats')?.textContent}`,
    );

    const applyBefore = stub.stubState.applyEditCalls;
    const reportBefore = stub.stubState.hostMessages.filter((m) => m.type === 'report').length;
    (ui.q('[data-action="apply"]') as HTMLElement).click();

    // 核心断言：不弹任何确认框，直接进入应用
    assert.equal(
      ui.q('#confirm-modal')?.hasAttribute('hidden'),
      true,
      '删除类批量变更也不应弹确认对话框',
    );
    await until(
      () => stub.stubState.applyEditCalls > applyBefore,
      '删除类批量 WorkspaceEdit 已提交',
    );
    await until(
      () => stub.stubState.hostMessages.filter((m) => m.type === 'report').length > reportBefore,
      '删除类批量应用产生执行报告',
    );
    assert.equal(
      ui.q('#confirm-modal')?.hasAttribute('hidden'),
      true,
      '应用完成后确认框仍不应出现',
    );

    // 落盘核验：env 被删、image 被改写
    const bulk0 = read('bulk/b00.yml');
    assert.match(bulk0, /image: new:v9/, `bulk 文件应写入新值，实际「${bulk0}」`);
    assert.doesNotMatch(bulk0, /env:/, `bulk 文件的 env 行应被删除，实际「${bulk0}」`);
    assert.equal(read('bulk/b29.yml'), 'image: new:v9\n', '第 30 个 bulk 文件同样写入');
    const xs1 = read('aaa/bbbb/xs1.yml');
    assert.match(xs1, /image: new:v9/, `xs1 应同时完成 set，实际「${xs1}」`);
    assert.doesNotMatch(xs1, /env:/, `xs1 的 env 行应被删除，实际「${xs1}」`);
  });

  /* ── 0.1.5：应用即全部保存 + 一键回退整体还原 ─────────────── */
  await t.test('应用即全部保存，点「一键回退」整体还原并保存', async () => {
    const saveBefore = stub.stubState.byteWriteCalls;
    assert.ok(saveBefore > 0, '应用后应已字节写入落盘（应用即全部保存）');
    const undoBtn = ui.q('[data-action="undo-last"]') as HTMLElement | null;
    assert.ok(undoBtn, '底栏应有一键回退按钮');
    assert.notEqual(undoBtn!.getAttribute('aria-disabled'), 'true', '上次应用后回退按钮应可用');

    const applyBefore = stub.stubState.applyEditCalls;
    undoBtn!.click();
    await until(
      () => stub.stubState.applyEditCalls > applyBefore,
      '回退提交 WorkspaceEdit',
    );
    await until(
      () => stub.stubState.hostMessages.some(
        (m) => m.type === 'undoState' && !(m.payload as AnyMsg).available,
      ),
      '回退后下发 undoState(available=false)',
    );
    assert.ok(stub.stubState.byteWriteCalls > saveBefore, '回退后同样立即字节写入落盘');

    // 最后一次应用的原文应被整体还原：被删的 env 行回来、image 回到上一轮值
    const xs1 = read('aaa/bbbb/xs1.yml');
    assert.match(xs1, /image: new:v3/, `回退应还原 set 前的值，实际「${xs1}」`);
    assert.match(xs1, /env: dev/, `回退应还原被删除的 env 行，实际「${xs1}」`);
    const bulk0 = read('bulk/b00.yml');
    assert.equal(bulk0, 'image: old:v1\nenv: dev\n', 'bulk 文件应还原为应用前原文');
  });

  /* ── 多级筛选：条件行 / AND-OR / 目录层级 / 只看已选 / Shift 范围 ── */
  await t.test('多级筛选与选择逻辑优化', async () => {
    // 0.2.5：字节写入让前序回退/应用完成更快，留下在途 postTree；先等其处理完再操作，
    // 避免刚加的筛选条件行被迟到的 scope 重渲染覆盖（测试稳定性，非产品逻辑）。
    await wait(350);
    ui.click('[data-action="wizard-step"][data-step="1"]');
    ui.click('[data-action="clear-filter"]');
    await until(() => ui.rows().length >= 30, '清除全部筛选后应列出全部 yml 文件');

    // 条件行 1：xs1（子串）→ 只留 1 个文件
    ui.click('[data-action="filter-add"]');
    assert.ok(ui.q('.filter-cond-row'), '应新增一条筛选条件行');
    ui.type('.filter-cond-row .cond-value', 'xs1');
    await until(
      () => ui.rows().length === 1 && /xs1\.yml/.test(ui.rows()[0]),
      `单条 xs1 条件应只留 xs1.yml，实际：${ui.rows().join(', ')}`,
    );
    assert.ok(ui.q('.cond-count'), '条件行应显示实时命中数');

    // 条件行 2：app.yaml；AND 下两个条件互斥 → 0 行
    ui.click('[data-action="filter-add"]');
    let condRows = [...ui.win.document.querySelectorAll('.filter-cond-row')];
    assert.equal(condRows.length, 2, '应有两条条件行');
    const val2 = condRows[1].querySelector('[data-filter-field="value"]') as HTMLInputElement;
    val2.value = 'app.yaml';
    val2.dispatchEvent(new ui.win.Event('input', { bubbles: true }));
    await until(() => ui.rows().length === 0, `AND 下互斥条件应为 0 行，实际：${ui.rows().join(', ')}`);

    // 切 OR → 两个文件都可见
    ui.click('[data-action="filter-mode"][data-mode="or"]');
    await until(
      () => ui.rows().length === 2 && ui.rows().some((p) => /xs1\.yml/.test(p)) && ui.rows().some((p) => /app\.yaml/.test(p)),
      `OR 下应同时看到两个文件，实际：${ui.rows().join(', ')}`,
    );

    // 排除条件：排除 app.yaml → 只剩 xs1.yml
    ui.click('[data-action="filter-add"]');
    condRows = [...ui.win.document.querySelectorAll('.filter-cond-row')];
    const op3 = condRows[2].querySelector('[data-filter-field="op"]') as HTMLSelectElement;
    op3.value = 'exclude';
    op3.dispatchEvent(new ui.win.Event('change', { bubbles: true }));
    condRows = [...ui.win.document.querySelectorAll('.filter-cond-row')];
    const val3 = condRows[2].querySelector('[data-filter-field="value"]') as HTMLInputElement;
    val3.value = 'app.yaml';
    val3.dispatchEvent(new ui.win.Event('input', { bubbles: true }));
    await until(
      () => ui.rows().length === 1 && /xs1\.yml/.test(ui.rows()[0]),
      `排除条件应移除 app.yaml，实际：${ui.rows().join(', ')}`,
    );

    // 目录层级聚焦：点树中目录的聚焦按钮，出现面包屑并收窄范围
    const focusBtn = ui.q('#scope-tree [data-action="focus-dir"]') as HTMLElement | null;
    assert.ok(focusBtn, '树目录行应有「逐级聚焦」按钮');
    const focusDir = (focusBtn as HTMLElement).getAttribute('data-path') || '';
    (focusBtn as HTMLElement).click();
    await until(
      () => ui.rows().every((p) => p.indexOf(focusDir + '/') === 0),
      `聚焦后应只显示 ${focusDir} 下的文件，实际：${ui.rows().join(', ')}`,
    );
    assert.ok(ui.q('.crumb.is-active'), '应出现层级面包屑');
    assert.ok(ui.q('[data-action="filter-crumb-clear"]'), '应可清除层级');
    ui.click('[data-action="filter-crumb-clear"]');

    // 只看已选：行数等于勾选行数
    const onlySel = ui.q('[data-action="filter-only-selected"]') as HTMLInputElement | null;
    assert.ok(onlySel, '应有「只看已选」开关');
    (onlySel as HTMLInputElement).checked = true;
    (onlySel as HTMLInputElement).dispatchEvent(new ui.win.Event('change', { bubbles: true }));
    await until(
      () => {
        const rows = ui.rows().length;
        const checked = ui.win.document.querySelectorAll('#scope-tree .tree-row.is-file .tri[aria-checked="true"]').length;
        return rows === checked;
      },
      '「只看已选」应只留下已勾选文件',
    );
    (onlySel as HTMLInputElement).checked = false;
    (onlySel as HTMLInputElement).dispatchEvent(new ui.win.Event('change', { bubbles: true }));

    // Shift 范围勾选：先点一行设锚点，再 Shift 点第三行，宿主应收到多条 select
    ui.click('[data-action="clear-filter"]');
    await until(() => ui.rows().length >= 30, '清除筛选后恢复全量 yml 列表');
    const tris = [...ui.win.document.querySelectorAll('#scope-tree .tree-row.is-file .tri')];
    assert.ok(tris.length >= 3, '应有多行可供范围选择');
    (tris[0] as HTMLElement).click();
    const before = stub.stubState.uiMessages.filter((m) => m.type === 'select').length;
    (tris[2] as HTMLElement).dispatchEvent(new ui.win.MouseEvent('click', { bubbles: true, shiftKey: true }));
    await until(
      () => stub.stubState.uiMessages.filter((m) => m.type === 'select').length >= before + 3,
      'Shift 范围勾选应批量下发 select',
    );
  });


});


/* ── 0.2.4：空 error-strip 常驻会露出「页面中上方玫红细线」 ── */
test('0.2.4 无错误时 error-strip[hidden] 不占位、有错误时仍可见', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'panel.css'), 'utf8');
  const html = `<!DOCTYPE html><html><head><style>${css}</style></head><body>
    <div class="error-strip" id="err-hidden" hidden></div>
    <div class="error-strip" id="err-shown"></div>
  </body></html>`;
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const w = dom.window;
  const hiddenEl = w.document.getElementById('err-hidden');
  const shownEl = w.document.getElementById('err-shown');
  assert.ok(hiddenEl, '应含 #err-hidden 节点');
  assert.ok(shownEl, '应含 #err-shown 节点');
  const hidden = w.getComputedStyle(hiddenEl).display;
  const shown = w.getComputedStyle(shownEl).display;
  assert.equal(hidden, 'none', '带 hidden 的空错误条必须 display:none，否则常驻露出玫红 border-bottom');
  assert.equal(shown, 'flex', '真正有错误时错误条仍应可见（提示功能不回退）');
  w.close();
});

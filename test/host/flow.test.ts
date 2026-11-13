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

  /* ── bug 1a：默认根目录 = VS Code 打开的工作区根目录 ───── */

  await t.test('bug1 默认在工作区根目录扫描，并显示文件列表', async () => {
    assert.ok(
      ui.q('[data-action="scan-files"]'),
      '第 ① 步应有「扫描文件」按钮',
    );
    ui.click('[data-action="scan-files"]');
    await until(
      () => stub.stubState.hostMessages.some(
        (m) => m.type === 'state' && (m.payload as AnyMsg)?.phase === 'results',
      ),
      '首次扫描完成',
    );

    const first = stub.stubState.findFilesCalls[0];
    assert.ok(first, '点「扫描文件」后应调用 findFiles');
    assert.equal(first.base, null, '默认应扫描工作区根目录（非 RelativePattern）');
    assert.equal(
      stub.stubState.findFilesCalls.filter((c) => c.base !== null).length,
      0,
      '未选择目录时不应使用外部根目录',
    );

    const rows = ui.rows();
    assert.ok(rows.includes('config/app.json'), `应列出 config/app.json，实际：${rows.join(', ')}`);
    assert.ok(rows.includes('aaa/bbbb/xs1.yml'), `应列出 aaa/bbbb/xs1.yml，实际：${rows.join(', ')}`);
    assert.ok(rows.includes('README.md'), `应列出 README.md，实际：${rows.join(', ')}`);
  });

  /* ── bug 3：筛选框下面要能显示出数据 ────────────────────── */

  await t.test('bug3 筛选框下方文件列表渲染出数据', async () => {
    const tree = ui.q('#scope-tree');
    assert.ok(tree, '文件范围树容器存在');
    const fileRows = ui.rows();
    assert.ok(fileRows.length >= 5, `文件行应 ≥5，实际 ${fileRows.length}`);
    const dirRows = ui.q('#scope-tree .tree-row.is-dir');
    assert.ok(dirRows, '应渲染目录行');
    // 空态 / 骨架屏都不算「显示数据」
    assert.ok(
      !ui.q('#scope-tree .state-skeleton'),
      '文件列表区域不应还是骨架屏',
    );
    const hitText = ui.q('.hit-count')?.textContent ?? '';
    assert.match(hitText, /命中\s*5/, `命中统计应为 5，实际「${hitText}」`);
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
      () => ui.rows().includes('config/app.json'),
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

    // 勾选状态不受筛选影响：仍选中全部 5 个文件
    const selected = (ui.q('.hit-count')?.textContent ?? '').match(/已选\s*(\d+)/);
    assert.ok(selected, `命中栏应显示已选数量，实际「${ui.q('.hit-count')?.textContent}」`);
    assert.equal(selected[1], '5', `筛选不改变勾选，已选应仍为 5，实际 ${selected[1]}`);

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
    await until(() => ui.rows().length === 5, '清空筛选恢复全部文件');
  });

  /* ── bug 2：YAML 格式下 yml 文件被识别 ──────────────────── */

  await t.test('bug2 选 YAML 格式后 .yml 文件进入候选并可匹配筛选', async () => {
    // 第 ① 步先把「目标格式（新建指令默认值）」切到 YAML
    ui.click('[data-action="target-format"][data-format="yaml"]');
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
    await until(() => ui.rows().length === 5, '恢复全部文件');
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

    // 第 ③ 步结果区要渲染出变更文件
    assert.ok(!ui.q('#sec-results')?.classList.contains('wizard-hidden'), '第 ③ 步应显示结果区');
    const changesGroup = ui.q('#group-changes')?.textContent ?? '';
    assert.match(changesGroup, /3/, `变更文件分组应列出 3 个文件，实际「${changesGroup.slice(0, 200)}」`);

    // 预览 diff：显示的必须是新值
    ui.click('[data-action="preview-all"]');
    await until(() => !!ui.q('.diff-line'), 'diff 预览渲染');
    const diffText = ui.q('#results-body')?.textContent ?? '';
    assert.match(diffText, /new:v3/, 'diff 预览应包含新值 new:v3');
    assert.doesNotMatch(diffText.slice(0, 4000), /new:v2/, 'diff 预览不应残留旧值');

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
});

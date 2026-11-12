import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

const DISPLAY_NAME = 'Batch Replace for JSON & YAML';

export function activate(context: vscode.ExtensionContext): void {
  const handlers: Record<string, (ctx: vscode.ExtensionContext) => void> = {
    'structedit.openPanel': openPanel,
    'structedit.useCursorPath': () => notYet('按光标路径填入'),
    'structedit.useSelectionAsPattern': () => notYet('选区转义为文本 pattern'),
    'structedit.applyFile': () => notYet('直接应用表达式集文件'),
    'structedit.showReport': () => notYet('查看上次执行报告'),
    'structedit.selectAllMatches': () => notYet('全选当前筛选命中'),
    'structedit.sequentialReview': () => notYet('依次选择 / 逐个审阅'),
  };

  for (const [id, handler] of Object.entries(handlers)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => handler(context)),
    );
  }
}

export function deactivate(): void {}

function notYet(feature: string): void {
  vscode.window.showInformationMessage(
    `${DISPLAY_NAME}：${feature} 将在 M2 控制器阶段接入。`,
  );
}

function openPanel(context: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel(
    'batchReplace.panel',
    DISPLAY_NAME,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = renderHtml();
  context.subscriptions.push(panel);
}

function renderHtml(): string {
  // 只用官方 --vscode-* 主题变量，无硬编码颜色；零外部网络请求（§8.0 / §8.7）
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${DISPLAY_NAME}</title>
<style nonce="${nonce}">
  body {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    padding: 16px;
  }
  h1 { font-size: 1.2em; }
  p { opacity: 0.85; }
</style>
</head>
<body>
<h1>${DISPLAY_NAME}</h1>
<p>批量编辑面板脚手架已就绪。指令区、文件范围区与 diff 预览将在 M2 / M3 阶段接入。</p>
</body>
</html>`;
}

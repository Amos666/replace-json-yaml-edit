/** WebviewPanel 创建与 HTML 装配（§8.7 / protocol.ts 资源契约）。 */

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { DISPLAY_NAME } from './types.ts';

/** 面板选项：一次 Ctrl+Z 全撤依赖 applyEdit；retainContextWhenHidden 保住扫描中间态。 */
export function createPanel(): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel(
    'batchReplace.panel',
    DISPLAY_NAME,
    { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true },
  );
}

/**
 * 读取 <extensionUri>/dist/ui/panel.html，替换 6 个占位符。
 * - NONCE 每次加载重新生成（crypto.randomBytes(16).toString('base64')）。
 * - 资源全部走 webview.asWebviewUri，CSP 源为 webview.cspSource（§8.7 铁律 3）。
 * - CSP 模板本身内联在 panel.html，此处仅注入 cspSource / nonce。
 */
export async function buildHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): Promise<string> {
  const fileUri = vscode.Uri.joinPath(extensionUri, 'dist/ui/panel.html');
  const bytes = await vscode.workspace.fs.readFile(fileUri);
  const template = new TextDecoder('utf-8').decode(bytes);

  const nonce = randomBytes(16).toString('base64');
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist/ui/panel.css'));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist/ui/panel.js'));
  const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist/ui/codicon.css'));
  const cspSource = webview.cspSource;

  return template
    .replace(/\{\{TITLE\}\}/g, DISPLAY_NAME)
    .replace(/\{\{NONCE\}\}/g, nonce)
    .replace(/\{\{CSP_SOURCE\}\}/g, cspSource)
    .replace(/\{\{CSS_URI\}\}/g, cssUri.toString())
    .replace(/\{\{JS_URI\}\}/g, jsUri.toString())
    .replace(/\{\{CODICON_CSS_URI\}\}/g, codiconCssUri.toString());
}

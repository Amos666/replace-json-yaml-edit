/** VS Code 扩展入口：注册附录 B 的命令，宿主逻辑全部委托 PanelController。
 * 仅提供编辑器 Tab 面板，由 Ctrl+Alt+B 启动（不注册侧边栏视图）。 */

import * as vscode from 'vscode';
import { PanelController } from './controllers/controller.ts';

export function activate(context: vscode.ExtensionContext): void {
  const controller = new PanelController(context);

  // 所有命令统一 try/catch：错误以 {type:'error'} 回发 Webview，不静默吞掉（§9）。
  const safe = (fn: () => void | Promise<void>): (() => Promise<void>) => async () => {
    try {
      await fn();
    } catch (e) {
      controller.postError(e);
    }
  };

  const commands: Array<[string, () => void | Promise<void>]> = [
    ['structedit.openPanel', () => controller.commandOpenPanel()],
    ['structedit.useCursorPath', () => controller.commandUseCursorPath()],
    ['structedit.useSelectionAsPattern', () => controller.commandUseSelectionAsPattern()],
    ['structedit.applyFile', () => controller.commandApplyFile()],
    ['structedit.showReport', () => controller.commandShowReport()],
    ['structedit.selectAllMatches', () => controller.commandSelectAllMatches()],
    ['structedit.sequentialReview', () => controller.commandSequentialReview()],
    ['structedit.undoLast', () => controller.commandUndoLast()],
  ];

  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, safe(handler)));
  }
}

export function deactivate(): void {}

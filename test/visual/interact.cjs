/**
 * 交互验收套件：打开面板后长驻，供外部 VNC 脚本点击「扫描文件」、勾选树行、
 * 双击文件行预览源码。状态写入 $BATCH_REPLACE_VISUAL_DIR/interact-state.json。
 */

const fs = require('node:fs');
const path = require('node:path');

async function run() {
  const vscode = require('vscode');
  const dir = process.env.BATCH_REPLACE_VISUAL_DIR;
  if (!dir) throw new Error('BATCH_REPLACE_VISUAL_DIR not set');
  const stateFile = path.join(dir, 'interact-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ phase: 'start' }));

  await vscode.commands.executeCommand('structedit.openPanel');
  await new Promise(r => setTimeout(r, 2500));
  fs.writeFileSync(stateFile, JSON.stringify({ phase: 'panel-open' }));

  // 长驻：外部通过 VNC 点击扫描 / 勾选 / 双击，期间保持 VS Code 打开。
  await new Promise(r => setTimeout(r, 60000));
  fs.writeFileSync(stateFile, JSON.stringify({ phase: 'done' }));
}

module.exports = { run };

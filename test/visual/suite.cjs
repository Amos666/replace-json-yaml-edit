/**
 * 视觉核验套件：在 Extension Host 内打开面板、切换四主题。
 * 与外部截图脚本双向握手：写 state.json 后等待外部写 ack.json 才继续，
 * 避免外部截图耗时导致状态被跳过。
 * 通过 @vscode/test-electron 的 --extensionTestsPath 加载（该通道已验证可加载扩展）。
 */

const fs = require('node:fs');
const path = require('node:path');

const THEMES = [
  'Default Dark Modern',
  'Default Light Modern',
  'Default High Contrast',
  'Default High Contrast Light',
];

const delay = ms => new Promise(r => setTimeout(r, ms));

/** 等外部写 ack.json（截图完成），收到即删除；最多等 25s */
async function waitAck(dir) {
  const ack = path.join(dir, 'ack.json');
  for (let i = 0; i < 250; i += 1) {
    if (fs.existsSync(ack)) {
      fs.unlinkSync(ack);
      return;
    }
    await delay(100);
  }
  throw new Error('screenshot ack timeout');
}

async function run() {
  const vscode = require('vscode');
  const dir = process.env.BATCH_REPLACE_VISUAL_DIR;
  if (!dir) throw new Error('BATCH_REPLACE_VISUAL_DIR not set');
  const stateFile = path.join(dir, 'state.json');
  const write = state => fs.writeFileSync(stateFile, JSON.stringify(state));
  const step = async state => {
    write(state);
    await delay(1200);
    await waitAck(dir);
  };

  await step({ phase: 'start' });

  await vscode.commands.executeCommand('structedit.openPanel');
  await delay(2500);
  await step({ phase: 'panel-open' });

  const config = vscode.workspace.getConfiguration();
  for (const theme of THEMES) {
    await config.update('workbench.colorTheme', theme, vscode.ConfigurationTarget.Global);
    await delay(2500);
    const actual = vscode.workspace.getConfiguration().get('workbench.colorTheme');
    await step({ phase: 'theme', requested: theme, actual });
  }

  await step({ phase: 'done' });
}

module.exports = { run };

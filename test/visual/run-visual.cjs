/**
 * 视觉核验启动器：复用 @vscode/test-electron 的 runTests 通道
 * （该通道已验证能加载开发扩展），由外部脚本以 DISPLAY=:99 启动，
 * 并用 BATCH_REPLACE_VISUAL_DIR 做状态握手。suite 会自行保持 VS Code 打开直至截图完成。
 */

const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

const ROOT = path.resolve(__dirname, '../..');

runTests({
  // 下载缓存固定到项目 .vscode-test，不受启动时 cwd 影响
  cachePath: path.join(ROOT, '.vscode-test'),
  extensionDevelopmentPath: ROOT,
  extensionTestsPath: path.join(__dirname, 'suite.cjs'),
  launchArgs: [process.env.BATCH_REPLACE_VISUAL_WS, '--disable-gpu'],
  extensionTestsEnv: {
    BATCH_REPLACE_VISUAL_DIR: process.env.BATCH_REPLACE_VISUAL_DIR,
  },
})
  .then(code => process.exit(code))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });

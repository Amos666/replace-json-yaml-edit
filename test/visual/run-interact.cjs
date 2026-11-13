/** 交互验收启动器：工作区指向 test/testdata，长驻供 VNC 点击。 */

const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

const ROOT = path.resolve(__dirname, '../..');

runTests({
  cachePath: path.join(ROOT, '.vscode-test'),
  extensionDevelopmentPath: ROOT,
  extensionTestsPath: path.join(__dirname, 'interact.cjs'),
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

/**
 * Node 侧启动器：创建临时 git 工作区与 fixture，调用 @vscode/test-electron
 * 下载并启动 VS Code Extension Development Host 跑 test/integration/out/suite.cjs。
 *
 * Linux 且无 DISPLAY 时自动用 xvfb-run -a 重新执行自己（headless）。
 * 用法：npm run test:integration
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { runTests } = require('@vscode/test-electron');

const ROOT = path.resolve(__dirname, '../..');

const FIXTURES = {
  'config/app.json': '{\n  "version": "1",\n  "name": "demo"\n}\n',
  'config/app.yaml': 'image: old:v1\nport: 8080\n',
  'scripts/deploy.sh': 'echo old:v1\n# TODO clean\n',
  'docs/readme.md': '# TODO clean\nold:v1\n',
};

function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-replace-it-'));
  for (const [rel, content] of Object.entries(FIXTURES)) {
    const file = path.join(ws, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  const git = args => execFileSync('git', args, { cwd: ws, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['-c', 'user.name=Integration', '-c', 'user.email=it@example.com', 'commit', '-q', '-m', 'fixture']);
  return ws;
}

async function main() {
  const suite = path.join(ROOT, 'test/integration/out/suite.cjs');
  if (!fs.existsSync(suite)) {
    throw new Error('missing test/integration/out/suite.cjs — run test:integration:build first');
  }

  const ws = makeWorkspace();
  console.log(`integration workspace: ${ws}`);
  let exitCode = 0;
  try {
    exitCode = await runTests({
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: suite,
      launchArgs: [ws, '--disable-gpu'],
      extensionTestsEnv: { BATCH_REPLACE_IT_WORKSPACE: ws },
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

// headless Linux：交给 xvfb-run 提供虚拟显示，子进程会带上 DISPLAY 不再递归
if (process.platform === 'linux' && !process.env.DISPLAY) {
  const r = spawnSync('xvfb-run', ['-a', process.execPath, __filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(r.status ?? 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

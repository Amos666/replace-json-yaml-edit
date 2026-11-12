import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

// Webview 静态资源（HTML/CSS/JS/Codicon 字体）随 .vsix 分发，见 src/shared/protocol.ts
async function copyUiAssets() {
  if (!existsSync('src/ui')) return;
  await mkdir('dist/ui', { recursive: true });
  await cp('src/ui', 'dist/ui', { recursive: true });
}

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  // jsonc-parser 的 UMD 入口含无法静态打包的 require('./impl/format')，优先用 ESM 入口
  mainFields: ['module', 'main'],
  target: 'node18',
  sourcemap: true,
  // 提取第三方许可注释到 dist/extension.js.LEGAL.txt（§3.1 License 合规）
  legalComments: 'linked',
  logLevel: 'info',
});

if (watch) {
  await copyUiAssets();
  await ctx.watch();
  console.log('esbuild: watching for changes...');
} else {
  await ctx.rebuild();
  await copyUiAssets();
  await ctx.dispose();
}

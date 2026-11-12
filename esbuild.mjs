import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  // 提取第三方许可注释到 dist/extension.js.LEGAL.txt（§3.1 License 合规）
  legalComments: 'linked',
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
  console.log('esbuild: watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}

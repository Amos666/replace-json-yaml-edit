import * as esbuild from 'esbuild';

// Extension Host 用 require() 加载 extensionTestsPath，因此打包为 CJS。
// core 是 TS 且 noEmit，这里一并内联；vscode 由宿主注入，必须 external。
await esbuild.build({
  entryPoints: ['test/integration/suite.ts'],
  outfile: 'test/integration/out/suite.cjs',
  bundle: true,
  platform: 'node',
  // jsonc-parser 的 UMD 入口含无法静态打包的 require('./impl/format')，优先用 ESM 入口
  mainFields: ['module', 'main'],
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  logLevel: 'info',
});

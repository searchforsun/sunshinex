import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkgRoot = path.dirname(fileURLToPath(import.meta.url));

// 壳主进程打包：自有源（main.ts/daemon.ts/lib/*）全内联，单文件 out/main.cjs（package.json main 指向）。
// external 仅 'electron'——运行时注入面（Electron 主进程内 require('electron') 由宿主提供），
// 打进 bundle 反而拿到 npm 包装器（导出二进制路径而非 app API），主进程必坏。
// daemon 不在此列也不进 bundle：startDaemon 走运行时动态 import（url.pathToFileURL 变量化表达式），
// esbuild 无法静态解析，天然保外置——运行时按 resolveDaemonPaths 两态路径加载主仓 dist 产物。
await build({
  entryPoints: [path.join(pkgRoot, 'src/main.ts')],
  outdir: path.join(pkgRoot, 'out'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify: false,
  external: ['electron'],
  logLevel: 'info',
});

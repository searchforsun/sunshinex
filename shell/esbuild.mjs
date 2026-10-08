import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkgRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pkgRoot, '..');

// 旗标分模式（H3-T2）：`--app` 只跑 daemon 树打包段（electron-builder 资源装配复用）；
// 缺省全跑（壳主进程 + daemon 树）——日常一条 `build` 出齐壳侧全部产物。
const appOnly = process.argv.includes('--app');

// 壳主进程打包：自有源（main.ts/daemon.ts/lib/*）全内联，单文件 out/main.cjs（package.json main 指向）。
// external 仅 'electron'——运行时注入面（Electron 主进程内 require('electron') 由宿主提供），
// 打进 bundle 反而拿到 npm 包装器（导出二进制路径而非 app API），主进程必坏。
// daemon 不在此列也不进 bundle：startDaemon 走运行时动态 import（url.pathToFileURL 变量化表达式），
// esbuild 无法静态解析，天然保外置——运行时按 resolveDaemonPaths 两态路径加载主仓 dist 产物。
async function buildShellMain() {
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
}

// daemon 树打包束（H3-T2）：以主仓 dist 编译产物为入口（不碰 src）——
// daemon.js + runtime.js 两入口各出一件自含 CJS 束（build/app-dist/{daemon,runtime}.cjs），
// 打包态经 electron-builder 落 resourcesPath/app-dist（paths.ts 打包臂同构指向）。
// external 仅 'node-pty'——原生模块（.node 二进制）不可内联进 JS 束，束内保留 require('node-pty'),
// 运行时从 packaged node_modules 解析；其余依赖（ws/MCP SDK/markdown 系）皆纯 JS,全内联单文件化。
// 入口用对象形定名：目录形公共祖先是 dist/,会多摊出 serve/ 层级而非平铺 {daemon,runtime}.cjs。
async function buildAppDist() {
  await build({
    entryPoints: {
      daemon: path.join(repoRoot, 'dist', 'serve', 'daemon.js'),
      runtime: path.join(repoRoot, 'dist', 'runtime.js'),
    },
    outdir: path.join(pkgRoot, 'build', 'app-dist'),
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    minify: false,
    external: ['node-pty'],
    logLevel: 'info',
  });
}

if (appOnly) {
  await buildAppDist();
} else {
  await buildShellMain();
  await buildAppDist();
}

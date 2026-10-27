// computer-use server 单文件束（2026-10-27）：sdk 内联、产物 server/index.js 零外部依赖——
// tgz/exe 装机形态无需子包 node_modules 即可 spawn（系统 node + 系统 powershell 即够）。
// 与 tsc 形态同产物路径（manifest args ["server/index.js"] 不变）；发版链经 scripts/release.mjs
// 前置本脚本（产物 gitignore 不入库,装机时点现构建）。路径按本文件位置解析——对调用方 cwd
// 免疫（release.mjs run() 不透传 cwd,实测踩坑）。运行：node build.mjs
import * as esbuild from 'esbuild';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.join(PKG, 'server', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(PKG, 'server', 'index.js'),
  sourcemap: false,
  logLevel: 'info',
});

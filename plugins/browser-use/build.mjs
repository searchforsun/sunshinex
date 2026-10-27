// browser-use server 单文件束（2026-10-27）：@playwright/mcp 全依赖图内联（含 playwright-core）、
// 产物 server/index.js 零外部依赖——装机形态免补装（系统 node + 系统 Chrome 即用，--browser chrome 走
// channel 机制定位本机浏览器）。与 computer-use/build.mjs 同模式：路径按本文件解析（对调用方 cwd
// 免疫，release.mjs run() 不透传 cwd）；产物 gitignore 不入库，发版链 release.mjs 前置现构建。
// 运行：node build.mjs
import * as esbuild from 'esbuild';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.dirname(fileURLToPath(import.meta.url));

// playwright-core 包根资产拷贝（browsers.json 注册表）：束内代码以 __dirname 相对遍历找「包根」
// （server/.. = browser-use 根），browsers.json 必须在该落位点（bin/ 等仅 trace/诊断用,不随束）。
// 定位走 workspace 根 .pnpm store glob（构建时仅在开发机执行;pnpm 隔离布局 createRequire 解析不到跨包依赖）
import { globSync } from 'node:fs';
const resolvePwRoot = () => {
  const hits = globSync(path.join(PKG, '..', '..', 'node_modules', '.pnpm', 'playwright-core@*', 'node_modules', 'playwright-core', 'browsers.json'));
  if (hits.length === 0) throw new Error('playwright-core/browsers.json 未找到——先在仓库根跑 pnpm install');
  return path.dirname(hits[0]);
};

/** BiDi 旁路置空：playwright-core 对 chromium-bidi 的 require 仅 WebDriver BiDi 用——Chrome channel
 *  走 CDP 不触达；pnpm 隔离布局下裸名解析不到，置空桩（触达即空对象软失败,不炸束） */
const stubOptionalDeps = {
  name: 'stub-optional-deps',
  setup(build) {
    build.onResolve({ filter: /^chromium-bidi\// }, () => ({ path: 'chromium-bidi-stub', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
  },
};

await esbuild.build({
  entryPoints: [path.join(PKG, 'node_modules', '@playwright', 'mcp', 'cli.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(PKG, 'server', 'index.js'),
  sourcemap: false,
  plugins: [stubOptionalDeps],
  logLevel: 'info',
});

const pwRoot = resolvePwRoot();
const { copyFileSync } = await import('node:fs');
copyFileSync(path.join(pwRoot, 'browsers.json'), path.join(PKG, 'browsers.json'));

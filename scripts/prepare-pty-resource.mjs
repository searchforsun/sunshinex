#!/usr/bin/env node
/**
 * H3-T3 node-pty 打包资源装配：pnpm symlink 实目录 → shell/build/node-pty。
 *
 * 为什么需要本脚本：electron-builder.yml 无法求值 require.resolve——extraResources 的
 * node-pty 源目录只能静态列。pnpm 布局下 node_modules/node-pty 是指向
 * .pnpm/node-pty@x/node_modules/node-pty 的 junction，yml 直列符号链目录的跟随行为不可控。
 * 裁定：dist script 前置本脚本，dirname(fs.realpathSync(require.resolve('node-pty/package.json')))
 * 解符号链拿实目录，按运行时面白名单复制到 shell/build/node-pty（electron-builder extraResources
 * 静列 from: ./build/node-pty → resources/node_modules/node-pty）。
 * node-pty 1.1.0 实目录含 prebuilds/<plat>-<arch>/ 原生二进制（win32 另有 conpty/winpty 全家），
 * lib/prebuilds/package.json 三件保 utils.loadNativeModule 的相对目录探测原样成立。
 * 幂等：先整删旧装配再全量拷（避免陈旧文件残留）。
 * H3-T4 收口修正（原整包口径）：只留 lib/prebuilds/package.json 三面——src/typings/deps/
 * third_party（构建期面）与 *.test.*、*.ts（上游测试/类型）不入装配；一并修 vitest
 * 缺省发现面扫入 build/node-pty 上游测试的门禁红 + 瘦身入包资源。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// mjs 无 require——createRequire 以本脚本位置为锚解析（node-pty 是主仓依赖，仓根可命中）
const nodeRequire = createRequire(import.meta.url);

// 实目录解析：require.resolve 命中 junction → realpathSync 落到 .pnpm 实体层
const ptyRealDir = path.dirname(fs.realpathSync(nodeRequire.resolve('node-pty/package.json')));
const destDir = path.join(repoRoot, 'shell', 'build', 'node-pty');

fs.rmSync(destDir, { recursive: true, force: true });
// 运行时白名单：package.json + lib/ + prebuilds/ 树；两树内再剔 *.test.* 与 *.ts。
// 其余顶层（src/typings/deps/third_party/scripts/.bin/README 等）全不入——构建期与测试面。
const relFromPty = (src) => path.relative(ptyRealDir, src).split(path.sep).join('/');
fs.cpSync(ptyRealDir, destDir, {
  recursive: true,
  filter: (src) => {
    const rel = relFromPty(src);
    if (rel === '' || rel === 'package.json') return true;
    const top = rel.split('/')[0];
    if (top !== 'lib' && top !== 'prebuilds') return false;
    return !rel.includes('.test.') && !rel.endsWith('.ts');
  },
});

// 装配完整性探针：当前平台 prebuild 的 pty.node 必须在场——缺即红（宁可打包期红不静默坏包）
const nativeProbe = path.join(destDir, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node');
if (!fs.existsSync(nativeProbe)) {
  console.error(
    `[prepare-pty] ${path.relative(repoRoot, nativeProbe)} 不在场——node-pty 装配不完整（实目录 ${path.relative(repoRoot, ptyRealDir)}），exit 1`,
  );
  process.exit(1);
}
console.log(`[prepare-pty] ${path.relative(repoRoot, ptyRealDir)} -> ${path.relative(repoRoot, destDir)}`);

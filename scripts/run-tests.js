#!/usr/bin/env node
/**
 * 全量测试启动器：把测试进程的运行时数据目录（SUNSHINEX_DATA_DIR）、全局技能根（SUNSHINEX_USER_SKILLS_DIR）与全局约定文件（SUNSHINEX_GLOBAL_SUNSHINE）钉到仓内 .data-test，
 * 跑完自清——测试对用户全局区（~/.sunshinex/projects）与各测试工作区零写入。
 * 隔离粒度由 `--require` 预载的 scripts/test-env.cjs 按「当前测试文件」派生私有子目录（见该文件注释：
 * 全批共用一个数据目录会让写侧的超限淘汰与读侧的枚举互相踩，用户本机 session.test 的 /init 崩溃即此形态）。
 * 纯 node 跨平台（Windows 经 node.exe 直跑，无 shell 语法依赖）；递归收集 dist 下 *.test.js 后交 node --test。
 */
const { spawnSync } = require('child_process');
// G14.104 测试基线语言钉 en（产品缺省 zh）：断言面以 en 书写，语言专项由 i18n.test 覆盖
process.env.SUNSHINEX_LANGUAGE = 'en';
const fs = require('fs');
const path = require('path');

function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const repoRoot = path.join(__dirname, '..');
const dataDir = path.join(repoRoot, '.data-test');
fs.rmSync(dataDir, { recursive: true, force: true });
const files = collect(path.join(repoRoot, 'dist'));
if (files.length === 0) {
  console.error('run-tests: dist 下未发现 *.test.js（先跑 tsc 构建）');
  process.exit(1);
}
// 并发度旋钮(2026-10-21 发版链负载抖动教训):ink 渲染类测试在满核并发+机热时计时抖动
// (KeyHints/skill-filter/sandbox.abort 三轮各中一不同文件,孤测全绿)——发版链等稳定性敏感
// 场景设 SUNSHINEX_TEST_CONCURRENCY=2 降并发换稳定;缺省不变(满核,日常反馈速度优先)
const conc = process.env.SUNSHINEX_TEST_CONCURRENCY;
// --test-force-exit(2026-10-31 技术债轮):真 daemon 类测试(gui-state/tree 等)收口后偶发残留
// 文件监听句柄(Windows fs.watch 释放迟滞),子进程不退出→整批跑被拖死/判超时——断言全过后强制退场;
// 句柄泄漏的根修(daemon teardown 面另查)不阻塞门禁
const FORCE_EXIT = ['--test-force-exit'];
// pty.test 串行收尾(2026-10-31 技术债轮):win32 下 node-pty 1.1.0 的 conpty 出口检测有并发缺陷——
// runner 子进程管态下与其他文件的 daemon pty(如 daemon.test ⑩⑪)同时 spawn/kill,pty 文件的测试
// 一个都起不来且子进程永不退(runner 永等,--test-force-exit 不触发:run 未达完成态)→整批卡死;
// 独占跑恒绿。故从并发批剥离、主批完后串行独占收尾(根修=升级 node-pty 1.2.0-beta,另议)
const isPty = (f) => f.replace(/\\/g, '/').endsWith('serve/pty.test.js');
const ptyFiles = files.filter(isPty);
const restFiles = files.filter((f) => !isPty(f));
const baseArgs = ['--require', path.join(__dirname, 'test-env.cjs'), ...FORCE_EXIT, '--test'];
const batchArgs = (list) => (conc !== undefined && conc !== '' ? [...baseArgs, `--test-concurrency=${conc}`, ...list] : [...baseArgs, ...list]);
const testEnv = { ...process.env, SUNSHINEX_DATA_DIR: dataDir, SUNSHINEX_USER_SKILLS_DIR: path.join(dataDir, 'user-skills'), SUNSHINEX_GLOBAL_SUNSHINE: path.join(dataDir, 'global-SUNSHINE.md') };
const r = spawnSync(process.execPath, batchArgs(restFiles), { stdio: 'inherit', env: testEnv });
let status = r.status ?? 1;
if (ptyFiles.length > 0) {
  // pty 串行收尾走直接执行(node:test standalone,非 runner 子进程管态):并发批的挂死只在
  // runner 子进程形态出现,直接执行从无此象;退出码同语义(失败非零)
  const rp = spawnSync(process.execPath, ['--require', path.join(__dirname, 'test-env.cjs'), ...ptyFiles], { stdio: 'inherit', env: testEnv });
  if (status === 0) status = rp.status ?? 1;
}
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(status);

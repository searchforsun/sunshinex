#!/usr/bin/env node
/**
 * 全量测试启动器：把测试进程的运行时数据目录（SUNSHINEX_DATA_DIR）钉到仓内 .data-test，
 * 跑完自清——测试对用户全局区（~/.sunshinex/projects）与各测试工作区零写入。
 * 纯 node 跨平台（Windows 经 node.exe 直跑，无 shell 语法依赖）；递归收集 dist 下 *.test.js 后交 node --test。
 */
const { spawnSync } = require('child_process');
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
const r = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: { ...process.env, SUNSHINEX_DATA_DIR: dataDir },
});
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(r.status ?? 1);

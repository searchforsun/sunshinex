#!/usr/bin/env node
// P2-CLI 部署冒烟：CLI 执行面 × DeepSeek（外部 API 依赖不进流水线门禁，手动执行）——
//   node --env-file-if-exists=.env scripts/probe-cli-smoke.js
// 断言：1) selfcheck 退出码 0 且含 graph 行；2) run 命令 fixtures 修正环 done 且 tokensUsed>0；
//       3) pipeline 命令 --yes 全链路 resume: done。每项真实冒烟前重置物料，保证可重复执行。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'demo');
const WRONG_TEST = `const assert = require('node:assert');\nconst { add } = require('./math');\nassert.equal(add(1, 2), 4);\n`;

function resetFixture() {
  fs.writeFileSync(path.join(FIXTURE, 'math.test.js'), WRONG_TEST);
  fs.rmSync(path.join(FIXTURE, '.data'), { recursive: true, force: true });
}

function sh(args) {
  return execFileSync('node', args, { encoding: 'utf8', cwd: ROOT, env: process.env, timeout: 600_000, stdio: ['ignore', 'pipe', 'inherit'] });
}

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}: ${String(e.message).split('\n')[0]}`); }
}

check('selfcheck：退出码 0 且含 graph 行', () => {
  const out = sh(['dist/cli/index.js', 'selfcheck']);
  if (!out.includes('graph')) throw new Error('selfcheck 缺 graph 行');
});

check('run：fixtures 修正环 done（真实模型）', () => {
  resetFixture();
  const out = sh(['--env-file-if-exists=.env', 'dist/cli/index.js', 'run', 'tests/fixtures/demo',
    '--template', 'test-loop', '--goal', '修正 math.test.js 断言使其通过（验收标准：c1=断言 add(1,2)===3）']);
  if (!/"status": "done"/.test(out)) throw new Error(`run 未 done：${out.slice(-300)}`);
  if (/"tokensUsed": 0/.test(out)) throw new Error('tokensUsed=0，未走真实模型');
});

check('pipeline：--yes 全链路 resume done（真实模型）', () => {
  resetFixture();
  const out = sh(['--env-file-if-exists=.env', 'dist/cli/index.js', 'pipeline', 'tests/fixtures/demo', '--yes',
    '--goal', '实现 add 函数并保证测试正确（验收标准：c1=math.test.js 断言 add(1,2)===3）']);
  if (!/resume: done/.test(out)) throw new Error(`pipeline 未 resume done：${out.slice(-300)}`);
});

resetFixture();
if (failed > 0) { console.error(`CLI-SMOKE-FAIL：${failed} 项未过`); process.exit(1); }
console.log('CLI smoke OK：selfcheck / run / pipeline 三命令部署可用。');

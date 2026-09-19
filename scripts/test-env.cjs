/**
 * 测试环境隔离预载（由 run-tests.js 以 `--require` 注入每个测试子进程）。
 *
 * 按「当前测试文件」派生私有数据目录，取代「全批共用一个 .data-test」。
 * 为什么必须在单点强制、而不是让各测试文件自己重定向：数据目录是可变共享资源——
 * A 文件写满学习技能触发超限淘汰（删目录），B 文件同时在枚举同一目录，即读到已消失的条目
 * （check-then-act 窗口 → ENOENT）。此前该纪律靠「每个测试文件记得钉数据目录」维持，
 * 但跑真实 run 的 14 个文件集体漏钉、合计落盘 75 条越过上限 50，令淘汰在整批期间持续发生，
 * 把偶发竞态放大成确定性崩溃（用户本机 session.test 的 /init 用例即此形态：
 * 枚举到 .data-test/skills/写个文件-2 后读取时目录已被删）。
 * 按文件隔离后，同批各测试文件互不可见，越限淘汰不再跨文件发生。
 *
 * 仍显式自钉数据目录的测试文件不受影响：它们在用例内覆盖本预载的值。
 */
const fs = require('fs');
const path = require('path');

const target = process.argv[1] || '';
if (!target.endsWith('.test.js')) return; // 仅测试文件子进程生效（--test 调度进程本身跳过）

const repoRoot = path.join(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist');
const rel = path
  .relative(distRoot, path.resolve(target))
  .replace(/\.test\.js$/, '')
  .replace(/[\\/]/g, '-');
const dir = path.join(repoRoot, '.data-test', rel);
fs.mkdirSync(dir, { recursive: true });
process.env.SUNSHINEX_DATA_DIR = dir;
process.env.SUNSHINEX_USER_SKILLS_DIR = path.join(dir, 'user-skills');
process.env.SUNSHINEX_GLOBAL_SUNSHINE = path.join(dir, 'global-SUNSHINE.md');

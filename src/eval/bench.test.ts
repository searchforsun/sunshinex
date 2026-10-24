import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BENCH_TASKS, BENCH_CONSTANTS } from './tasks';
import { aggregate } from './report';
import { ScriptedAdapter } from '../model/adapter';
import { buildDeps } from '../runtime';
import { resolveTemplate } from '../cli/commands/run-loop';

/** O3 基准集门禁（零 token 确定性面）：①verify 双态对照×5——fixtures 生成后未做必红、黄金解做对必绿
 *  （换回「恒过」或「恒红」的判据实现即红,L 类判别力锚）；②ScriptedAdapter 驱动 T1 全链 wiring
 *  （goal 解析→引擎→write 落盘→脚本验盘）；③报告聚合钉。真实模型测量走 scripts/eval-run.mjs 手动门。 */

/** 黄金解（每任务最小正确落盘——双态对照的「做对」半边；内容与 fixtures 常量同源不重抄） */
const GOLDEN: Record<string, (dir: string) => void> = {
  'T1-create': (dir) => fs.writeFileSync(path.join(dir, 'greeting.txt'), 'Hello benchmark'),
  'T2-refactor': (dir) => {
    // 抽取 format.js + 三文件改 require（行为面与原三份逐字等价:同函数体同调用形态）
    fs.writeFileSync(path.join(dir, 'format.js'), `${BENCH_CONSTANTS.T2_FILES['prices.js']!.split('\n')[0]}\n\nmodule.exports = { formatPrice };\n`);
    for (const name of ['prices.js', 'invoice.js', 'receipt.js']) {
      const body = BENCH_CONSTANTS.T2_FILES[name]!.replace('function formatPrice(cents) { return "$" + (cents / 100).toFixed(2); }\n\n', '');
      fs.writeFileSync(path.join(dir, name), `const { formatPrice } = require('./format');\n\n${body}`);
    }
  },
  'T3-test-loop': (dir) => {
    fs.writeFileSync(
      path.join(dir, 'impl.js'),
      'function slugify(s) {\n  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/ /g, "-");\n}\nmodule.exports = { slugify };\n',
    );
  },
  'T4-aggregate': (dir) => fs.writeFileSync(path.join(dir, 'report.txt'), `${BENCH_CONSTANTS.T4_EXPECTED}\n`),
  'T5-edit-precision': (dir) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
    cfg.timeout = 5000;
    cfg.retries = 5;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  },
  'T6-long-loop': (dir) => {
    fs.mkdirSync(path.join(dir, 'data'));
    for (let i = 1; i <= 12; i += 1) {
      const name = `f${String(i).padStart(2, '0')}`;
      fs.writeFileSync(path.join(dir, 'data', `${name}.txt`), name);
    }
    fs.writeFileSync(path.join(dir, 'manifest.txt'), `${Array.from({ length: 12 }, (_, i) => `f${String(i + 1).padStart(2, '0')}.txt`).join('\n')}\n`);
  },
};

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-bench-'));
}

test('O3 verify 双态对照×5：未做必红、黄金解必绿（判别力锚）', () => {
  for (const task of BENCH_TASKS) {
    const solve = GOLDEN[task.id];
    assert.ok(solve, `任务 ${task.id} 缺黄金解`);
    const untouched = tmp();
    task.fixtures(untouched);
    assert.ok(task.verify(untouched) !== null, `${task.id}: 未做时 verify 必红`);
    fs.rmSync(untouched, { recursive: true, force: true });
    const solved = tmp();
    task.fixtures(solved);
    solve(solved);
    assert.equal(task.verify(solved), null, `${task.id}: 黄金解后 verify 必绿`);
    fs.rmSync(solved, { recursive: true, force: true });
  }
});

test('O3 wiring：ScriptedAdapter 驱动 T1 全链（goal→引擎→write 落盘→验盘）', async () => {
  const task = BENCH_TASKS[0]!;
  const dir = tmp();
  try {
    const deps = buildDeps(dir, {});
    (deps as { model: unknown }).model = new ScriptedAdapter([
      `{"tool":"write","input":{"path":"greeting.txt","content":"Hello benchmark"},"done":false}`,
      '{"done":true,"reply":"greeting.txt 已创建"}',
    ]);
    const tpl = resolveTemplate(deps, 'test-loop', {
      ruleCheckers: { c1: async () => fs.readFileSync(path.join(dir, 'greeting.txt'), 'utf8') === 'Hello benchmark' },
    });
    const r = await tpl.engine.run(task.goal);
    assert.equal(r.status, 'done');
    assert.equal(task.verify(dir), null, '引擎链产出通过权威验盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('O3 报告聚合：完成率/干预合计/成本合计', () => {
  const r = aggregate([
    { id: 'a', pass: true, iterations: 2, tokensUsed: 100, durationMs: 10, approvals: 3, asks: 1 },
    { id: 'b', pass: false, problem: 'x', iterations: 5, tokensUsed: 50, durationMs: 30, approvals: 0, asks: 2 },
  ]);
  assert.deepEqual(
    { ...r, tasks: undefined },
    { total: 2, passed: 1, passRate: 0.5, tokensUsed: 150, approvals: 3, asks: 3, durationMs: 40, tasks: undefined },
  );
});

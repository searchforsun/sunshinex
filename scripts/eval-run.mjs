#!/usr/bin/env node
/**
 * O3 长任务基准集 runner（手动门——花真金 token，不进 pnpm test 门禁；GOAL「双口径」的基准集侧）：
 *   node scripts/eval-run.mjs [--model <id>] [--timeout <秒,缺省600>] [--only <id>]
 *
 * 逐任务：临时目录 → fixtures 生成 → spawn `run <dir> --goal=<goal>`（真实模型）→ 收结果 JSON
 * （status/iterations/tokensUsed/approvals/asks）→ **脚本侧权威验盘**（task.verify,不信任模型自报
 * criteria）→ 报告（stdout 人类可读 + eval-results/<时间戳>.json 落档,gitignore 不入库）。
 * 任务库与验盘逻辑单源 src/eval/tasks.ts（消费其编译产物 dist/eval/tasks.js,零复制）。
 * 干预计数口径（双计数）：approvals=guard ask 决策数（权限面）、asks=ask_question 调用数（问询面）
 * ——headless 恒 dontAsk、ask_question 非 TTY dismiss,计的是「干预需求」非真实打断。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'index.js');

function argOf(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const TIMEOUT_MS = Number(argOf('--timeout', '600')) * 1000;
const MODEL_FLAG = process.argv.includes('--model') ? [`--model=${argOf('--model')}`] : [];
const ONLY = argOf('--only');

const { BENCH_TASKS } = await import(pathToFileURL(path.join(ROOT, 'dist', 'eval', 'tasks.js')));
const { aggregate } = await import(pathToFileURL(path.join(ROOT, 'dist', 'eval', 'report.js')));

/** 从 stdout 尾部切出 run 命令的结果 JSON——锚定 `{\n  "status"`（run-loop 结果块首键;criteria 数组
 *  内层嵌套对象也产 `{\n` 片段,按最后一个 `{` 切会落进碎片） */
function parseResult(out) {
  let idx = out.lastIndexOf('{\n  "status"');
  if (idx < 0) idx = out.lastIndexOf('{\n');
  if (idx < 0) return null;
  try {
    return JSON.parse(out.slice(idx));
  } catch {
    return null;
  }
}

const tasks = ONLY ? BENCH_TASKS.filter((t) => t.id === ONLY) : BENCH_TASKS;
const results = [];
for (const task of tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eval-${task.id}-`));
  task.fixtures(dir);
  process.stdout.write(`[eval] ${task.id} ${task.title} … `);
  const started = Date.now();
  const r = spawnSync(process.execPath, [CLI, 'run', dir, `--goal=${task.goal}`, ...MODEL_FLAG], {
    cwd: ROOT,
    timeout: TIMEOUT_MS,
    encoding: 'utf8',
    windowsHide: true,
  });
  const durationMs = Date.now() - started;
  const result = parseResult((r.stdout ?? '') + (r.stderr ?? ''));
  const problem = task.verify(dir);
  const pass = r.status === 0 && result?.status === 'done' && problem === null;
  const row = {
    id: task.id,
    pass,
    problem: problem ?? undefined,
    status: result?.status ?? `spawn-exit=${r.status}${r.signal ? `(${r.signal})` : ''}`,
    iterations: result?.iterations,
    tokensUsed: result?.tokensUsed,
    durationMs,
    approvals: result?.approvals ?? 0,
    asks: result?.asks ?? 0,
    toolUsage: result?.toolUsage ?? { calls: 0, byOutcome: {} },
  };
  results.push(row);
  const tu = row.toolUsage;
  const errBucket = Object.entries(tu.byOutcome).filter(([k]) => k !== 'ok').map(([k, v]) => `${k}=${v}`).join(',') || 'none';
  console.log(`${pass ? 'PASS' : 'FAIL'} (${(durationMs / 1000).toFixed(1)}s, ${row.tokensUsed ?? '?'} tokens, 干预 a=${row.approvals}/q=${row.asks}, 工具 ${tu.calls} 次[错: ${errBucket}])`);
  if (!pass) console.error(`  ↳ ${row.status}${row.problem ? ` | ${row.problem}` : ''}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

const report = aggregate(results);
console.log(`\n[eval] 完成率 ${report.passed}/${report.total} (${Math.round(report.passRate * 100)}%) · tokens ${report.tokensUsed} · 干预 approvals=${report.approvals} asks=${report.asks} · 工具 ${report.toolUsage.calls} 次 · 总时长 ${(report.durationMs / 1000).toFixed(1)}s`);
const outDir = path.join(ROOT, 'eval-results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outFile = path.join(outDir, `eval-${stamp}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
console.log(`[eval] 报告落档 ${path.relative(ROOT, outFile)}`);
if (report.passed < report.total) process.exit(1);

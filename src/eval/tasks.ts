import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * O3 长任务基准集：固定任务库（GOAL.md「双口径」之基准集侧的机器可判半边）。
 * 任务三件套：goal（内嵌「验收标准：id=描述」段，喂 run 命令）/ fixtures(dir)（确定性初始态生成）/
 * verify(dir)（脚本侧**权威**验盘——完成判定不信任模型自报 criteria，只信 fs/进程真值）。
 * 全部任务自包含临时目录、答案确定性、零外部依赖（node 内置面）；「需人工判定」的另一半走观察台账（GOAL 口径），不在此。
 * 消费面：scripts/eval-run.mjs（真实模型手动门）+ bench.test.ts（ScriptedAdapter wiring 门禁,verify 双态对照）。
 */

export interface BenchTask {
  readonly id: string;
  readonly title: string;
  /** 喂给 `run` 命令的 goal（内嵌验收标准段——模型判据面;真值判定在 verify） */
  readonly goal: string;
  /** 确定性初始态生成（幂等：同参数重复调用产出逐字节一致内容） */
  fixtures(dir: string): void;
  /** 权威验盘：null=通过;非 null=失败问题描述（逐字、确定性） */
  verify(dir: string): string | null;
}

function readFile(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** T2 共用：三文件重复函数的原文（黄金解=抽到 format.js 并改 require,行为面不变） */
const T2_FORMAT_FN = 'function formatPrice(cents) { return "$" + (cents / 100).toFixed(2); }';
const T2_FILES: Record<string, string> = {
  'prices.js': `${T2_FORMAT_FN}

function priceList(items) {
  return items.map((n) => n + ': ' + formatPrice(100));
}
module.exports = { priceList };
`,
  'invoice.js': `${T2_FORMAT_FN}

function invoiceLine(label, cents) {
  return label + ': ' + formatPrice(cents);
}
module.exports = { invoiceLine };
`,
  'receipt.js': `${T2_FORMAT_FN}

function receiptTotal(centsList) {
  return 'TOTAL ' + formatPrice(centsList.reduce((a, b) => a + b, 0));
}
module.exports = { receiptTotal };
`,
  'check.js': `const { priceList } = require('./prices');
const { invoiceLine } = require('./invoice');
const { receiptTotal } = require('./receipt');
console.log(priceList(['a', 'b']).join(' | '));
console.log(invoiceLine('widget', 250));
console.log(receiptTotal([100, 200, 300]));
`,
};
const T2_EXPECTED_OUT = 'a: $1.00 | b: $1.00\nwidget: $2.50\nTOTAL $6.00';

/** T4 共用：JSONL 事件流（确定性取值:errors=2 warns=3 total=2834） */
const T4_LINES = [
  { level: 'info', ms: 100 },
  { level: 'warn', ms: 200 },
  { level: 'error', ms: 34 },
  { level: 'info', ms: 400 },
  { level: 'warn', ms: 500 },
  { level: 'info', ms: 0 },
  { level: 'error', ms: 1200 },
  { level: 'warn', ms: 334 },
  { level: 'info', ms: 66 },
  { level: 'info', ms: 0 },
];
const T4_EXPECTED = 'errors=2\nwarns=3\ntotal_ms=2834';

/** T5 共用：六键配置与目标值（timeout/retries 改值,其余四键逐字保留） */
const T5_ORIGINAL = { name: 'bench-app', version: 3, timeout: 800, retries: 2, tags: ['a', 'b'], nested: { debug: false } };
const T5_ORIGINAL_TEXT = JSON.stringify(T5_ORIGINAL, null, 2) + '\n';

export const BENCH_TASKS: readonly BenchTask[] = [
  {
    id: 'T1-create',
    title: '单文件创建（write 精确内容）',
    goal: '在当前目录创建文件 greeting.txt，内容恰好为 Hello benchmark（验收标准：c1=greeting.txt 存在且内容为 Hello benchmark）',
    fixtures: () => {},
    verify: (dir) => {
      const p = path.join(dir, 'greeting.txt');
      if (!fs.existsSync(p)) return 'greeting.txt 不存在';
      return readFile(p).replace(/\r/g, '').trim() === 'Hello benchmark' ? null : `内容不符：${JSON.stringify(readFile(p))}`;
    },
  },
  {
    id: 'T2-refactor',
    title: '跨文件重构（重复函数抽公共模块）',
    goal: "prices.js、invoice.js、receipt.js 三个文件各自重复定义了 formatPrice 函数：把该函数抽取到新建文件 format.js（module.exports 导出 formatPrice），三个文件改为 require('./format') 并删除各自的重复定义；各文件对外行为保持不变——check.js 是行为核对脚本（验收标准：r1=format.js 存在且导出 formatPrice；r2=三个业务文件不再包含 function formatPrice 定义；r3=运行 node check.js 输出与重构前逐字一致）",
    fixtures: (dir) => {
      for (const [name, body] of Object.entries(T2_FILES)) fs.writeFileSync(path.join(dir, name), body);
    },
    verify: (dir) => {
      const formatJs = path.join(dir, 'format.js');
      if (!fs.existsSync(formatJs)) return 'format.js 不存在';
      for (const name of ['prices.js', 'invoice.js', 'receipt.js']) {
        if (readFile(path.join(dir, name)).includes('function formatPrice')) return `${name} 仍含重复定义`;
      }
      const r = spawnSync(process.execPath, ['check.js'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
      if (r.status !== 0) return `check.js 运行失败：${(r.stderr ?? '').slice(0, 300)}`;
      // 尾换行容忍:模型侧 console.log 恒带 \n,行为等价判定 trimEnd 对齐
      return r.stdout.replace(/\r/g, '').trimEnd() === T2_EXPECTED_OUT ? null : `行为漂移：${JSON.stringify(r.stdout)}`;
    },
  },
  {
    id: 'T3-test-loop',
    title: '测试闭环（修复实现使测试通过）',
    goal: 'impl.test.js 中有测试失败：修复 impl.js 让全部测试通过；不得修改 impl.test.js（验收标准：t1=node --test impl.test.js 全部通过；t2=impl.test.js 内容未被改动）',
    fixtures: (dir) => {
      fs.writeFileSync(
        path.join(dir, 'impl.js'),
        'function slugify(s) {\n  return s.toLowerCase().replace(/ /g, "-");\n}\nmodule.exports = { slugify };\n',
      );
      fs.writeFileSync(
        path.join(dir, 'impl.test.js'),
        'const assert = require("node:assert");\nconst { test } = require("node:test");\nconst { slugify } = require("./impl");\n\ntest("basic", () => assert.equal(slugify("hello world"), "hello-world"));\ntest("punctuation", () => assert.equal(slugify("Hello, World!"), "hello-world"));\ntest("collapse", () => assert.equal(slugify("a   b"), "a---b"));\n',
      );
    },
    verify: (dir) => {
      const expectedTest = 'const assert = require("node:assert");\nconst { test } = require("node:test");\nconst { slugify } = require("./impl");\n\ntest("basic", () => assert.equal(slugify("hello world"), "hello-world"));\ntest("punctuation", () => assert.equal(slugify("Hello, World!"), "hello-world"));\ntest("collapse", () => assert.equal(slugify("a   b"), "a---b"));\n';
      if (readFile(path.join(dir, 'impl.test.js')) !== expectedTest) return 'impl.test.js 被改动（违规）';
      // 嵌套 --test 陷阱（实锤探针）：外层 node:test 门禁下 NODE_TEST_CONTEXT=child-v8 会泄给子进程,
      // 子 runner 走上报形态**恒 exit 0**（失败测试被吞）——剥离测试运行器环境变量,子进程按独立完整
      // test runner 语义跑（失败必非零,「未做必红」锚才成立）
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_TEST_CONTEXT|TEST_WORKER_ID|TEST_REPORTER)/.test(k)));
      const r = spawnSync(process.execPath, ['--test', 'impl.test.js'], { cwd: dir, encoding: 'utf8', timeout: 60_000, env });
      return r.status === 0 ? null : `测试仍未全过：${(r.stdout ?? '').slice(-300)}`;
    },
  },
  {
    id: 'T4-aggregate',
    title: '日志聚合（JSONL 统计写报告）',
    goal: '统计 events.jsonl：error 级别条数、warn 级别条数、全部条目 ms 字段合计；把结果写入 report.txt，恰好三行、每行格式 key=value：errors=<n>、warns=<n>、total_ms=<m>（验收标准：s1=report.txt 存在且三行数值与文件事实一致）',
    fixtures: (dir) => {
      fs.writeFileSync(path.join(dir, 'events.jsonl'), T4_LINES.map((l) => JSON.stringify(l)).join('\n') + '\n');
    },
    verify: (dir) => {
      const p = path.join(dir, 'report.txt');
      if (!fs.existsSync(p)) return 'report.txt 不存在';
      return readFile(p).replace(/\r/g, '').trim() === T4_EXPECTED ? null : `report 内容不符：${JSON.stringify(readFile(p))}`;
    },
  },
  {
    id: 'T5-edit-precision',
    title: '编辑精度（按规格改键余键原样）',
    goal: '编辑 config.json：把 timeout 改为 5000、retries 改为 5；其余键（name/version/tags/nested）与其值逐字原样保留，键总数不变（验收标准：e1=timeout 为 5000 且 retries 为 5；e2=name/version/tags/nested 四键原样保留且键总数仍为 6）',
    fixtures: (dir) => {
      fs.writeFileSync(path.join(dir, 'config.json'), T5_ORIGINAL_TEXT);
    },
    verify: (dir) => {
      let cfg: Record<string, unknown>;
      try {
        cfg = JSON.parse(readFile(path.join(dir, 'config.json'))) as Record<string, unknown>;
      } catch {
        return 'config.json 不是合法 JSON';
      }
      if (cfg.timeout !== 5000 || cfg.retries !== 5) return `目标键不符：timeout=${JSON.stringify(cfg.timeout)} retries=${JSON.stringify(cfg.retries)}`;
      const expect: Record<string, unknown> = { ...T5_ORIGINAL };
      delete (expect as Record<string, unknown>).timeout;
      delete (expect as Record<string, unknown>).retries;
      for (const [k, v] of Object.entries(expect)) {
        if (JSON.stringify(cfg[k]) !== JSON.stringify(v)) return `保留键 ${k} 漂移：${JSON.stringify(cfg[k])}（原 ${JSON.stringify(v)}）`;
      }
      return Object.keys(cfg).length === 6 ? null : `键总数漂移：${Object.keys(cfg).length}（应 6）`;
    },
  },
];

/** 测试/工具面共享常量（黄金解与期望值导出——bench.test 双态对照与 wiring 断言不重抄字面量） */
export const BENCH_CONSTANTS = {
  T2_FILES,
  T2_EXPECTED_OUT,
  T4_EXPECTED,
  T5_ORIGINAL_TEXT,
} as const;

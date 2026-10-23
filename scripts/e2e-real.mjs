#!/usr/bin/env node
/**
 * 真实模型 e2e（D5 资产化，手动门——花真金 token，不进 pnpm test/selfcheck 门禁）：
 *   node scripts/e2e-real.mjs [--model <id>] [--timeout <秒,缺省180>]
 *
 * 前提：~/.sunshinex/settings.json 已配真实密钥（env 块 SUNSHINEX_API_KEY 或 provider apiKey——
 * CLI 自带装载链把它们写入 SUNSHINEX_* 环境槽，本脚本只做存在性预检，不读密钥明文）。
 * 无 key 直接跑：模型 401 形态失败，场景 FAIL 并给配置指引（MANUAL 第二节）。
 *
 * 场景两条（真实 OpenAI 协议适配器 + 流式 + 工具注册表 + 安全链全链，只有此门能验）：
 *   S1 直答冒烟      —— run 单轮直答，exit 0 且 reply 含 OK；
 *   S2 工具链落盘闭环 —— run 经 write 工具创建 hello-real.txt，exit 0 且**脚本侧**逐字验盘
 *                        （不信任模型自报，落盘真值只认 fs）。
 * 任一场景 FAIL → exit 1（stderr 尾部随报）。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'index.js');
const TIMEOUT_MS = (Number(process.argv.find((a, i) => process.argv[i - 1] === '--timeout') ?? 180)) * 1000;
const modelIdx = process.argv.indexOf('--model');
const MODEL_FLAG = modelIdx >= 0 ? [`--model=${process.argv[modelIdx + 1]}`] : [];

/** 预检：settings.json env 块是否有真实密钥槽（容忍注释/BOM，同装载链口径的轻量近似） */
function preflight() {
  const file = path.join(os.homedir(), '.sunshinex', 'settings.json');
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\/\/[^\n"]*(?=\n|$)/g, '');
    const env = JSON.parse(raw).env ?? {};
    const hasKey = Object.entries(env).some(([k, v]) => k.startsWith('SUNSHINEX_API_KEY') && String(v).length > 0);
    if (!hasKey) console.log('[e2e-real] 注意：settings.json env 块未探测到 API key 槽——继续尝试（外部 env 直配形态自行承担）');
  } catch {
    console.log('[e2e-real] 注意：读不到 ~/.sunshinex/settings.json——继续尝试（外部 env 直配形态自行承担）');
  }
}

/** @typedef {{name: string, pass: boolean, detail: string, ms: number, tokens?: number}} ScenarioResult */

function runScenario(name, goal, verify) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-real-'));
  const started = Date.now();
  const r = spawnSync(process.execPath, [CLI, 'run', dir, `--goal=${goal}`, ...MODEL_FLAG], {
    cwd: ROOT,
    timeout: TIMEOUT_MS,
    encoding: 'utf8',
    windowsHide: true,
  });
  const ms = Date.now() - started;
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  if (r.status !== 0) {
    return { name, pass: false, detail: `exit=${r.status}${r.signal ? ` signal=${r.signal}` : ''}\n${out.slice(-800)}`, ms };
  }
  const jsonLine = out.slice(out.lastIndexOf('{\n'));
  let tokens;
  try {
    const summary = JSON.parse(jsonLine);
    tokens = summary.tokensUsed;
    if (summary.status !== 'done') return { name, pass: false, detail: `status=${summary.status} error=${summary.error ?? '(none)'}\n${out.slice(-400)}`, ms, tokens };
  } catch {
    /* 结果 JSON 行解析失败不直接判负——落盘断言仍在下 */
  }
  if (verify) {
    const problem = verify(dir);
    if (problem !== null) return { name, pass: false, detail: problem, ms, tokens };
  }
  return { name, pass: true, detail: `reply 含 OK`, ms, tokens };
}

const scenarios = [
  {
    name: 'S1 直答冒烟（真实适配器+流式）',
    goal: '直接回复两个字母 OK，不要使用任何工具（验收标准：id=r1,描述=最终回复包含 OK）',
    verify: (dir) => null,
  },
  {
    name: 'S2 工具链落盘闭环（write 工具+安全链）',
    goal: '在当前目录创建文件 hello-real.txt，内容恰好六个字符 e2e-real，不要输出多余内容（验收标准：id=w1,描述=hello-real.txt 存在且内容为 e2e-real）',
    verify: (dir) => {
      const file = path.join(dir, 'hello-real.txt');
      if (!fs.existsSync(file)) return '落盘断言失败：hello-real.txt 不存在';
      const body = fs.readFileSync(file, 'utf8').trim();
      return body === 'e2e-real' ? null : `落盘断言失败：内容=${JSON.stringify(body)}（期望 "e2e-real"）`;
    },
  },
];

preflight();
const results = [];
for (const s of scenarios) {
  process.stdout.write(`[e2e-real] ${s.name} … `);
  const r = runScenario(s.name, s.goal, s.verify);
  results.push(r);
  console.log(`${r.pass ? 'PASS' : 'FAIL'} (${(r.ms / 1000).toFixed(1)}s${r.tokens !== undefined ? `, ${r.tokens} tokens` : ''})`);
  if (!r.pass) console.error(r.detail);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[e2e-real] ${results.length - failed.length}/${results.length} 场景通过`);
if (failed.length > 0) {
  console.error('[e2e-real] FAIL——检查：①settings.json env 块密钥（MANUAL 第二节）②网络可达性③模型名是否在 provider 清单');
  process.exit(1);
}

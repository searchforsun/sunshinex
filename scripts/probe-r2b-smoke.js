#!/usr/bin/env node
// P1-1 C2 真实模型冒烟（R2b，spec §5）：外部 API 依赖不进流水线门禁，手动执行——
//   node --env-file-if-exists=.env scripts/probe-r2b-smoke.js
// 场景：budget {total:135, reserve:45}；shouldCompact 触发线 = total-reserve = 90（window.ts 代码实证），摘要/重读预算各 22。
// big.txt = 'Pin code: 7391' + 900 个 x + ' END OF FILE'（≈975 字符，obs 不截断、显式结尾，读入后 est≈520 仍越触发线 90）；
// f.txt 指向 big.txt（64 字符，[重读] ≈21 ≤ 22 预算）。无论模型先读哪个文件，大文件读入后装配 est 必然越过 90 触发压缩；
// total=135 在大观测后必然进入 fail-bounded 区（mem 尾注回灌 ≈146 tok，spec §6 配置异常语义、有界退出）——
// 严格 C1≤total 结论由 900/150 档 E2E 探针承载，本针承载 C2 口径：任务结论正确 + 摘要幂等不重复注入。
// 断言：done；reply 含 7391；compactCalls ≥ 1 且入账 records ≥ 1；单轮 prompt 摘要块 ≤ 1（幂等不回归）；
// est 曲线按 fail-bounded 包络（max < 800）做健全性断言，不作 C1 断言。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Reactor } = require('../dist/harness/reactor');
const { ProcessSandbox } = require('../dist/harness/security/sandbox');
const { SecurityGuard } = require('../dist/harness/security/guard');
const { PolicyEngine } = require('../dist/harness/security/policy');
const { SafetyChain } = require('../dist/harness/security/chain');
const { DryRun } = require('../dist/harness/security/dryrun');
const { ToolRegistry } = require('../dist/harness/tools');
const { builtinTools } = require('../dist/harness/tools/builtin');
const { ContextManager } = require('../dist/harness/context');
const { FileStore } = require('../dist/storage/adapter');
const { OpenAIAdapter } = require('../dist/model/adapter');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-r2b-'));
  const secret = '7391';
  fs.writeFileSync(path.join(tmp, 'big.txt'), 'Pin code: 7391' + 'x'.repeat(2986)); // 答案在文件头：读入后 mem 记录 ≈128 tok + hist ≈503 tok，驱动 est 越过触发线 90
  fs.writeFileSync(path.join(tmp, 'f.txt'), 'The code is stored in big.txt. Reply with just the code number.'); // 指引文件：[重读] ≈21 ≤ 22 预算

  const assembleEstTrace = [];
  const estAtThinkPerRound = [];
  const prompts = [];
  let lastEst = 0;

  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  const rawAssemble = context.assemble.bind(context);
  context.assemble = (goal, history) => {
    const items = rawAssemble(goal, history);
    lastEst = context.window.estimate(items).used;
    assembleEstTrace.push(lastEst);
    return items;
  };
  let compactCalls = 0;
  const rawCompact = context.window.compact.bind(context.window);
  context.window.compact = async (items, opts) => {
    compactCalls++;
    return rawCompact(items, opts);
  };

  const modelResponses = [];
  const model = new OpenAIAdapter({});
  const rawComplete = model.complete.bind(model);
  model.complete = async (p) => {
    estAtThinkPerRound.push(lastEst);
    prompts.push(p);
    const out = await rawComplete(p);
    modelResponses.push(typeof out === 'string' ? out : JSON.stringify(out));
    return out;
  };

  const reactor = new Reactor({ registry, safety, context, model });
  const r = await reactor.run(
    { goal: '读 f.txt 和 big.txt 找出口令；知道答案后立即输出 {"done":true,"reply":"口令数字"} 终止' },
    { maxSteps: 8, budget: { total: 135, reserve: 45 } },
  );

  const reply = typeof r.reply === 'string' ? r.reply : '';
  const summaryBlocksPerRound = prompts.map((p) => (p.match(/\[压缩摘要/g) || []).length);
  const compactions = context.memory.index().filter((l) => l.startsWith('compaction: 摘要')).length;
  const hit = reply.includes(secret);
  const maxEst = Math.max(...estAtThinkPerRound);
  const ok = r.done === true
    && hit
    && compactCalls >= 1
    && compactions >= 1
    && maxEst < 800
    && summaryBlocksPerRound.every((c) => c <= 1);
  console.log(JSON.stringify({
    done: r.done,
    reply,
    hit,
    estAtThinkPerRound,
    assembleEstTrace,
    maxEst,
    summaryBlocksPerRound,
    compactCalls,
    compactions,
    ok,
  }, null, 2));
  console.log('=== 诊断 ===');
  modelResponses.forEach((m, i) => console.log(`--resp${i + 1}-- ${String(m).slice(0, 240).replace(/\n/g, ' ')}`));
  for (const s of r.steps ?? []) {
    console.log(`--step${s.step}-- action=${s.action ?? '(none)'} obs=${String(s.observation ?? '').slice(0, 100).replace(/\n/g, ' ')}`);
  }
  console.log('answerInLastPrompt:', prompts.length > 0 && prompts[prompts.length - 1].includes('Pin code: 7391'));
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('R2B-FAIL', e && e.message);
  process.exit(1);
});

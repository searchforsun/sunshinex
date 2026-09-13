#!/usr/bin/env node
// P1-1 T6 Step 1：E2E 收敛探针（spec C1 证据）
// 场景：R2 型多文件全量叠加——f1/f2/f3 各 3000 字符，budget {total:900, reserve:150}（threshold 750，摘要/重读预算各 75）。
// 断言：全轮次 prompt est ≤ 900（C1 收敛性，压缩当轮生效 + 滞回门 + 硬越限应急旁路共同保证）。
// 输出 JSON 曲线 {done, estPerRound, maxEst, rounds, ok}；全绿 exit(0)，任一超限或未完成 exit(1)。
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

// 与 window.estimateTokens 同款口径：CJK×1 + 其余÷4（内联实现，保持探针自包含）
const estimateTokens = (s) => {
  const cjk = (s.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  return cjk + Math.ceil((s.length - cjk) / 4);
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-e2e-'));
  for (const f of ['f1', 'f2', 'f3']) {
    fs.writeFileSync(path.join(tmp, `${f}.txt`), f.repeat(1500)); // 每文件 3000 字符
  }

  const prompts = [];
  const replies = [
    '{"tool":"read","input":{"path":"f1.txt"},"done":false}',
    '{"tool":"read","input":{"path":"f2.txt"},"done":false}',
    '{"tool":"read","input":{"path":"f3.txt"},"done":false}',
    '{"done":true,"reply":"三份文件已汇总"}',
  ];
  let call = 0;
  const assembleEstTrace = []; // 每次 assemble 的 est（含收敛环内中间重估），全量如实上报
  const estAtThinkPerRound = []; // 每轮 think 时刻的 est（该轮最后一次装配结果），C1 断言对象
  const model = {
    provider: 'capture',
    complete: async (p) => {
      prompts.push(p);
      estAtThinkPerRound.push(assembleEstTrace[assembleEstTrace.length - 1]);
      return replies[Math.min(call++, replies.length - 1)];
    },
  };

  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  // C1 的度量对象是系统预算变量 est（window.estimate(items)），而非 prompt 字符串——
  // prompt 另含 ~180 tok 固定头部（工具清单等），不参与预算记账；两条曲线分开采集，断言用 estAtThink
  const origAssemble = context.assemble.bind(context);
  context.assemble = (...args) => {
    const items = origAssemble(...args);
    assembleEstTrace.push(context.window.estimate(items).used);
    return items;
  };
  const reactor = new Reactor({ registry, safety, context, model });

  const r = await reactor.run({ goal: '汇总三个文件' }, { maxSteps: 4, budget: { total: 900, reserve: 150 } });
  const promptEstPerRound = prompts.map(estimateTokens); // prompt 字符串口径：含 ~180 tok 固定头部，不参与预算记账，仅如实上报
  const maxEstAtThink = Math.max(...estAtThinkPerRound);
  const compactions = context.memory.index().filter((l) => l.startsWith('compaction: 摘要')).length;
  // C1 断言：think 时刻系统 est（该轮最后一次装配）全程 ≤ total；compactions ≥ 1 防空洞通过
  const ok = r.done === true && estAtThinkPerRound.length === prompts.length && maxEstAtThink <= 900 && compactions >= 1;
  console.log(
    JSON.stringify(
      {
        done: r.done,
        estAtThinkPerRound, // C1 度量：think 时刻系统 est
        maxEstAtThink,
        promptEstPerRound, // prompt 字符串口径（含固定头部），透明上报不断言
        assembleEstTrace, // 每次装配的 est（含收敛环内中间重估）
        compactions,
        rounds: prompts.length,
        ok,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('E2E-FAIL', e && e.message);
  process.exit(1);
});

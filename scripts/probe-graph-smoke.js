#!/usr/bin/env node
// P3-T5 真实模型冒烟：全链路流水线模板 × DeepSeek（外部 API 依赖不进流水线门禁，手动执行）——
//   node --env-file-if-exists=.env scripts/probe-graph-smoke.js
// 场景：tmp 工作区 math.js 实现正确 + 首版错误测试（assert add(1,2)===4）；
// 流水线：planner → developer → test-verify（内嵌 testLoop，规则通道）→ reviewer → 交付 gate paused → resume(approve) → done。
// 断言：run paused 且 pendingGates=[delivery-gate]；resume 后 done、failedNodes 空、tokensUsed>0（真实计量）、
//       内嵌 loop 验收产物透传全过、Graph 总账 = Σ节点 tokens。
const fs = require('fs');
const os = require('os');
const path = require('path');
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
const { softwarePipelineTemplate } = require('../dist/graph/templates');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-graph-smoke-'));
  fs.writeFileSync(path.join(tmp, 'math.js'), `function add(a, b) { return a + b; }\nmodule.exports = { add };\n`);
  fs.writeFileSync(
    path.join(tmp, 'math.test.js'),
    `const assert = require('node:assert');\nconst { add } = require('./math');\nassert.equal(add(1, 2), 4);\n`,
  );

  const safety = new SafetyChain(
    new SecurityGuard(new PolicyEngine(), 'dontAsk'),
    new ProcessSandbox(),
    new DryRun(),
    tmp,
  );
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const deps = {
    safety,
    registry,
    context: new ContextManager(tmp, new FileStore(tmp)),
    model: new OpenAIAdapter({ timeoutMs: 120_000 }),
  };

  const tpl = softwarePipelineTemplate(deps, {
    goal: '实现 add 函数并保证测试正确（验收标准：c1=math.test.js 断言 add(1,2)===3）',
    ruleCheckers: {
      c1: async () => fs.readFileSync(path.join(tmp, 'math.test.js'), 'utf8').includes('assert.equal(add(1, 2), 3)'),
    },
    maxSteps: 8,
  });

  // 节点级异常透传堆栈（诊断增强：引擎 catch 仅保留 message，丢栈不利定位）
  for (const n of tpl.nodes) {
    const orig = n.run.bind(n);
    n.run = async (...a) => {
      try {
        return await orig(...a);
      } catch (e) {
        console.error(`[node ${n.id}] 异常堆栈：`, e && e.stack);
        throw e;
      }
    };
  }

  console.log('[1] run：五节点链推进至交付 gate…');
  const r1 = await tpl.engine.run('实现 add 函数并保证测试正确');
  console.log('run   :', r1.status, `tokens=${r1.tokensUsed}`, `pendingGates=[${r1.pendingGates}]`, r1.reply ?? '');
  for (const [id, o] of Object.entries(r1.results)) {
    console.log(`  - ${id} (${o.status}, tokens=${o.tokens}): ${(o.reply ?? '').slice(0, 60).replace(/\n/g, ' ')}`);
  }
  if (r1.status !== 'paused' || r1.pendingGates.length !== 1 || r1.pendingGates[0] !== 'delivery-gate') {
    console.log('非预期暂停点：', JSON.stringify({ status: r1.status, pendingGates: r1.pendingGates }, null, 2));
    process.exit(1);
  }

  console.log('[2] resume：批准交付 gate…');
  const r2 = await tpl.engine.resume({ 'delivery-gate': true });
  console.log('resume:', r2.status, `tokens=${r2.tokensUsed}`, `failedNodes=[${r2.failedNodes}]`);

  const loopOut = r2.results['test-verify'];
  const criteriaOk = Array.isArray(loopOut.criteria) && loopOut.criteria.length > 0 && loopOut.criteria.every((c) => c.passed);
  const nodeTokens = Object.values(r2.results).reduce((s, o) => s + o.tokens, 0);

  if (r2.status !== 'done' || r2.failedNodes.length > 0 || !(r2.tokensUsed > 0) || !criteriaOk || r2.tokensUsed !== nodeTokens) {
    console.log('冒烟断言未满足：', JSON.stringify({ status: r2.status, failedNodes: r2.failedNodes, tokensUsed: r2.tokensUsed, criteriaOk }, null, 2));
    process.exit(1);
  }
  console.log('P3 graph smoke OK：全链路 × DeepSeek done，预算账目一致（', r2.tokensUsed, 'tokens），gate resume 闭环。');
})().catch((e) => {
  console.error('smoke error:', e);
  process.exit(1);
});

#!/usr/bin/env node
// P2-T6 真实模型冒烟：测试闭环模板 × OpenAI 协议兼容模型（外部 API 依赖不进流水线门禁，手动执行）——
//   node --env-file-if-exists=.env scripts/probe-loop-smoke.js
// 场景：tmp 工作区 math.js 实现正确 + 首版错误测试（assert add(1,2)===4）；
// 模板修正环：agent 修复测试 → check 规则校验（断言修正后内容）→ done。
// 断言：status done、criteria 全过、tokensUsed > 0（OpenAI usage 回传真实计量贯通）。
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
const { testLoopTemplate } = require('../dist/loop/templates');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-loop-smoke-'));
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
    model: new OpenAIAdapter({}),
  };

  const tpl = testLoopTemplate(deps, {
    termination: { maxIterations: 6, maxTokens: 60_000, timeoutMs: 300_000 },
    ruleCheckers: {
      c1: async () =>
        /assert\.equal\(add\(1,\s*2\),\s*3\)/.test(
          fs.readFileSync(path.join(tmp, 'math.test.js'), 'utf8'),
        ),
    },
  });

  const r = await tpl.engine.run(
    '工作区中 math.js 的 add 实现正确，但 math.test.js 的断言有误。请阅读文件并修正 math.test.js 使测试通过（验收标准：c1=math.test.js 断言 add(1,2)===3）',
  );

  const criteria = r.criteria ?? [];
  const ok =
    r.status === 'done' && criteria.length > 0 && criteria.every((c) => c.passed) && r.tokensUsed > 0;
  console.log(
    JSON.stringify(
      { status: r.status, iterations: r.iterations, tokensUsed: r.tokensUsed, criteria, reply: r.reply, error: r.error, ok },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('LOOP-SMOKE-FAIL', e && e.message);
  process.exit(1);
});

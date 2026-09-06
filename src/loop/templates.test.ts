import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoopDeps } from './engine';
import { codeRefactorTemplate, testLoopTemplate, codeReviewTemplate } from './templates';
import { SafetyChain } from '../harness/security/chain';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { ProcessSandbox } from '../harness/security/sandbox';
import { DryRun } from '../harness/security/dryrun';
import { ToolRegistry } from '../harness/tools';
import { builtinTools } from '../harness/tools/builtin';
import { ContextManager } from '../harness/context';
import { FileStore } from '../storage/adapter';
import { ScriptedAdapter } from '../model/adapter';

/** 五件套装配：dontAsk 模式（E2E 需要写文件；deny 底线仍生效） */
function makeDeps(root: string, model: ScriptedAdapter): LoopDeps {
  const safety = new SafetyChain(
    new SecurityGuard(new PolicyEngine(), 'dontAsk'),
    new ProcessSandbox(),
    new DryRun(),
    root,
  );
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  return { safety, registry, context: new ContextManager(root, new FileStore(root)), model };
}

test('T5-1 代码重构模板：agent 更新引用 → check 规则校验旧引用清零 → done', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-t5-refactor-'));
  fs.writeFileSync(path.join(root, 'a.ts'), `export const greet = () => 'hi';\n`);
  fs.writeFileSync(
    path.join(root, 'b.ts'),
    `import { greetOld } from './a';\nexport const use = () => greetOld();\n`,
  );
  const model = new ScriptedAdapter([
    `{"tool":"write","input":{"path":"b.ts","content":"import { greet } from './a';\\nexport const use = () => greet();\\n"},"done":false}`,
    `{"done":true,"reply":"引用已同步为 greet"}`,
  ]);
  const tpl = codeRefactorTemplate(makeDeps(root, model), {
    termination: { maxIterations: 8 },
    ruleCheckers: {
      c1: async () => !fs.readFileSync(path.join(root, 'b.ts'), 'utf8').includes('greetOld'),
    },
  });
  const r = await tpl.engine.run(
    '重构 b.ts：改用 a.ts 的 greet 导出（验收标准：c1=旧引用 greetOld 清零）',
  );
  assert.equal(r.status, 'done');
  assert.ok(Array.isArray(r.criteria) && r.criteria.every((c) => c.passed));
  assert.ok(!fs.readFileSync(path.join(root, 'b.ts'), 'utf8').includes('greetOld'));
});

test('T5-2 测试闭环模板：首版测试错误 → check 未过 → router 修正环 → 复检绿 → done', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-t5-testloop-'));
  fs.writeFileSync(path.join(root, 'math.js'), `function add(a, b) { return a + b; }\nmodule.exports = { add };\n`);
  const model = new ScriptedAdapter([
    // 第一轮 agent：写入仍错误的测试（v1）
    `{"tool":"write","input":{"path":"math.test.js","content":"const assert = require('node:assert');\\nconst { add } = require('./math');\\nassert.equal(add(1, 2), 4);\\n"},"done":false}`,
    `{"done":true,"reply":"测试已生成"}`,
    // 第二轮 agent：修正断言（v2）
    `{"tool":"write","input":{"path":"math.test.js","content":"const assert = require('node:assert');\\nconst { add } = require('./math');\\nassert.equal(add(1, 2), 3);\\n"},"done":false}`,
    `{"done":true,"reply":"断言已修正为 3"}`,
  ]);
  const tpl = testLoopTemplate(makeDeps(root, model), {
    termination: { maxIterations: 10 },
    ruleCheckers: {
      c1: async () => {
        const s = fs.readFileSync(path.join(root, 'math.test.js'), 'utf8');
        return s.includes('assert.equal(add(1, 2), 3)') && !s.includes('4)');
      },
    },
  });
  const r = await tpl.engine.run(
    '为 math.js 的 add 生成测试（验收标准：c1=断言 add(1,2)===3 且无错误断言）',
  );
  assert.equal(r.status, 'done');
  const s = fs.readFileSync(path.join(root, 'math.test.js'), 'utf8');
  assert.ok(s.includes('assert.equal(add(1, 2), 3)'));
  assert.ok(!s.includes('4)'));
});

test('T5-3 代码审查模板：审查产出 → gate 结论断言 → fixer 修复 → check 复检清零 → done', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-t5-review-'));
  fs.writeFileSync(path.join(root, 'risky.js'), `eval('1 + 1');\nmodule.exports = 2;\n`);
  const model = new ScriptedAdapter([
    // 审查轮：读文件并产出结论
    `{"tool":"read","input":{"path":"risky.js"},"done":false}`,
    `{"done":true,"reply":"发现 1 处 eval 高危（risky.js:1）"}`,
    // 修复轮：移除 eval
    `{"tool":"write","input":{"path":"risky.js","content":"module.exports = 2;\\n"},"done":false}`,
    `{"done":true,"reply":"已修复：移除 eval 调用"}`,
  ]);
  const tpl = codeReviewTemplate(makeDeps(root, model), {
    termination: { maxIterations: 12 },
    ruleCheckers: {
      c1: async () => !fs.readFileSync(path.join(root, 'risky.js'), 'utf8').includes('eval'),
    },
  });
  const r = await tpl.engine.run(
    '审查 risky.js 并消除高危（验收标准：c1=文件中不再包含 eval 调用）',
  );
  assert.equal(r.status, 'done');
  assert.ok(!fs.readFileSync(path.join(root, 'risky.js'), 'utf8').includes('eval'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { confirmApprovals, runPipelineAssembly } from './run-pipeline';
import { softwarePipelineTemplate } from '../../graph/templates';
import { buildDeps } from './run-loop';
import { ScriptedAdapter } from '../../model/adapter';

test('confirmApprovals：y 批准 / n 拒绝 / 多 gate 逐个询问', async () => {
  const answers = ['y', 'n'];
  const fake = { question: async () => answers.shift() ?? 'n' };
  const r = await confirmApprovals(['delivery-gate', 'release-gate'], fake);
  assert.deepEqual(r, { 'delivery-gate': true, 'release-gate': false });
});

test('confirmApprovals：Yes/YES 大小写不敏感', async () => {
  const fake = { question: async () => 'YES' };
  const r = await confirmApprovals(['g'], fake);
  assert.deepEqual(r, { g: true });
});

test('pipeline：ScriptedAdapter 离线端到端——五节点链 paused 于 delivery-gate，resume 后 done', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-pipeline-'));
  fs.writeFileSync(path.join(tmp, 'math.js'), 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n');
  fs.writeFileSync(path.join(tmp, 'math.test.js'), 'const assert = require("node:assert");\nconst { add } = require("./math");\nassert.equal(add(1, 2), 4);\n');
  const deps = buildDeps(tmp, {});
  (deps as { model: unknown }).model = new ScriptedAdapter([
    '{"done":true,"reply":"规划：修正测试断言为 3"}',
    '{"tool":"write","input":{"path":"math.test.js","content":"const assert = require(\\"node:assert\\");\\nconst { add } = require(\\"./math\\");\\nassert.equal(add(1, 2), 3);\\n"},"done":false}',
    '{"done":true,"reply":"开发完成：断言已修正"}',
    '{"done":true,"reply":"测试验证完成：断言符合 c1"}',
    '{"done":true,"reply":"审查通过，无阻塞问题"}',
  ]);
  const tpl = runPipelineAssembly(deps, {
    goal: '实现 add 函数并保证测试正确（验收标准：c1=math.test.js 断言 add(1,2)===3）',
    ruleCheckers: {
      c1: async () => fs.readFileSync(path.join(tmp, 'math.test.js'), 'utf8').includes('assert.equal(add(1, 2), 3)'),
    },
  });
  const r1 = await tpl.engine.run('实现 add 函数并保证测试正确');
  assert.equal(r1.status, 'paused');
  assert.deepEqual(r1.pendingGates, ['delivery-gate']);
  const r2 = await tpl.engine.resume({ 'delivery-gate': true });
  assert.equal(r2.status, 'done');
  assert.deepEqual(r2.failedNodes, []);
});

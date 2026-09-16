import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildDeps, buildModel } from '../../runtime';
import { resolveTemplate, runLoop } from './run-loop';
import { ScriptedAdapter } from '../../model/adapter';

test('buildDeps：装配四件套且内置工具已注册', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-'));
  const deps = buildDeps(tmp, {});
  assert.ok(deps.safety && deps.registry && deps.context && deps.model);
  assert.equal(deps.registry.list().length >= 5, true, '内置五工具已注册');
});

test('resolveTemplate：test-loop 模板可实例化且节点含 check', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-'));
  const deps = buildDeps(tmp, {});
  const tpl = resolveTemplate(deps, 'test-loop');
  assert.equal(tpl.name, 'test-loop');
  assert.ok(tpl.nodes.some((n) => n.id.includes('check')));
});

test('resolveTemplate：未知模板名报错不静默', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-'));
  assert.throws(() => resolveTemplate(buildDeps(tmp, {}), 'no-such'));
});

test('run-loop：ScriptedAdapter 驱动 test-loop 修正环 done（离线端到端）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-'));
  fs.writeFileSync(path.join(tmp, 'math.js'), 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n');
  fs.writeFileSync(path.join(tmp, 'math.test.js'), 'const assert = require("node:assert");\nconst { add } = require("./math");\nassert.equal(add(1, 2), 4);\n');
  const deps = buildDeps(tmp, {});
  (deps as { model: unknown }).model = new ScriptedAdapter([
    '{"tool":"write","input":{"path":"math.test.js","content":"const assert = require(\\"node:assert\\");\\nconst { add } = require(\\"./math\\");\\nassert.equal(add(1, 2), 3);\\n"},"done":false}',
    '{"done":true,"reply":"断言已修正为 3"}',
  ]);
  const tpl = resolveTemplate(deps, 'test-loop', {
    ruleCheckers: { c1: async () => fs.readFileSync(path.join(tmp, 'math.test.js'), 'utf8').includes('assert.equal(add(1, 2), 3)') },
  });
  const r = await tpl.engine.run('修正测试断言（验收标准：c1=断言 add(1,2)===3）');
  assert.equal(r.status, 'done');
  assert.equal(r.tokensUsed, 0);
});

test('buildModel：缺省 openai 且带展示标签，--model=stub 走占位适配器', () => {
  assert.equal(buildModel({ model: 'stub' }).provider, 'stub');
  assert.equal(buildModel({ model: 'scripted' }).provider, 'scripted');
  const oa = buildModel({});
  assert.equal(oa.provider, 'openai');
  assert.ok(oa.label && oa.label.startsWith('openai · '), 'banner 应显示真实模型标签');
});
test('run-loop：用法提示不再含 --template（模板为内部装配机制，用户面零暴露）', async () => {
  await assert.rejects(
    () => runLoop({ command: 'run', positional: [], flags: {} }),
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, /sunshinex run <dir>/);
      assert.ok(!msg.includes('--template'), '用法提示不得暴露模板参数');
      return true;
    },
  );
});

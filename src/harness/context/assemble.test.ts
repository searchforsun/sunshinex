import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager } from './index';
import { FileStore } from '../../storage/adapter';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm-'));
  const cm = new ContextManager(root, new FileStore(root));
  return { root, cm };
}

test('assemble 串起 loader + memory + goal + history', () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), '# 项目规范\n禁用 any 类型\n');
  cm.memory.record('project', '记住偏好 TDD');

  const items = cm.assemble('完成任务', [{ kind: 'history', content: '步骤1 执行完毕' }]);
  const text = items.map((i) => i.content).join('\n');
  assert.ok(text.includes('禁用 any 类型'), '应含 SUNSHINE.md 分层指令');
  assert.ok(text.includes('记住偏好 TDD'), '应含记忆索引');
  assert.ok(text.includes('完成任务'), '应含 goal');
  assert.ok(text.includes('步骤1 执行完毕'), '应含 history');
});

test('assemble 命中 relPath 时注入路径规则，否则跳过', () => {
  const { root, cm } = setup();
  fs.mkdirSync(path.join(root, '.sunshine', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sunshine', 'rules', 'src-only.md'), 'paths: src/\n本规则仅 src 生效\n');

  const hit = cm.assemble('x', [], 'src/a.ts');
  const miss = cm.assemble('x', [], 'lib/a.ts');
  assert.ok(hit.some((i) => i.content.includes('本规则仅 src 生效')));
  assert.ok(!miss.some((i) => i.content.includes('本规则仅 src 生效')));
});

test('assemble 记忆注入走分层配额 tail：超量旧记忆由压缩摘要代表而非全量叠加', () => {
  const { cm } = setup();
  for (let i = 1; i <= 30; i++) cm.memory.record('project', `W${i}: ${'x'.repeat(80)}`);
  const items = cm.assemble('完成任务');
  const mem = items.find((i) => i.kind === 'memory');
  assert.ok(mem, '应有记忆条目');
  assert.ok(mem.content.includes('W30'), '最新记忆保留');
  assert.ok(!mem.content.includes('W1:'), '配额外最旧记忆不再注入');
  assert.ok(!mem.content.includes('W15:'), '配额窗口外记忆不再注入');
});

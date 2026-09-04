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

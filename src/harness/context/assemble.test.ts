import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager } from './index';
import { FileStore } from '../../storage/adapter';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm-'));
  // 快照冻结（Task8/G）：先写盘后构造——构造即冻结基线（真实会话=SUNSHINE.md 先于会话存在）
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), '# 项目规范：禁用 any 类型\n');
  const cm = new ContextManager(root, new FileStore(root));
  return { root, cm };
}

test('assemble 段序（fork 模型）：SUNSHINE.md → history → 技能块置尾；无 goal 位、无记忆段', () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), '# 项目规范：禁用 any 类型\n');
  cm.setSkillBlock('技能正文：示范');
  const items1 = cm.assemble([{ kind: 'history', content: '1: task -> 步骤一' }]);
  assert.ok(items1[0].content.includes('禁用 any 类型'), 'SUNSHINE.md 居首');
  assert.equal(items1[items1.length - 1].kind, 'system', '技能块必须置尾');
  assert.ok(items1[items1.length - 1].content.includes('技能正文'));
  assert.ok(!items1.some((i) => i.kind === 'memory'), '记忆段已退出装配面');
  // goal 槽已取消：装配产物仅为 loader/rules 行级指令、history 与技能块，不再有 goal 注入位
  assert.ok(items1.some((i) => i.kind === 'history' && i.content === '1: task -> 步骤一'), 'history 条目按传入原样进入');
  // 技能消失帧：其余段逐字节稳定（§11 尾部差异公理）
  const items2 = cm.assemble([
    { kind: 'history', content: '1: task -> 步骤一' },
    { kind: 'history', content: '2: reply -> 完成' },
  ]);
  const text1 = items1.slice(0, -1).map((i) => i.content).join('\n');
  const text2 = items2.map((i) => i.content).join('\n');
  assert.ok(text2.startsWith(text1), '技能消失后其余段必须前缀稳定');
});

test('会话链 API：追加定号、水位裁剪、跳号保留、resetSession 清空', () => {
  const { cm } = setup();
  cm.appendChain([{ action: 'task', observation: '当前指令：A' }]);
  cm.appendChain([{ action: 'reply', observation: 'A 完成' }, { action: 'task', observation: '当前指令：B' }]);
  assert.deepEqual(cm.chainView().map((s) => s.step), [1, 2, 3]);
  cm.trimChainFront(2);
  assert.deepEqual(cm.chainView().map((s) => s.step), [3]);
  cm.appendChain([{ action: 'reply', observation: 'B 完成' }]);
  assert.deepEqual(cm.chainView().map((s) => s.step), [3, 4]);
  cm.resetSession();
  assert.equal(cm.chainView().length, 0);
  cm.appendChain([{ action: 'task', observation: '新会话' }]);
  assert.deepEqual(cm.chainView().map((s) => s.step), [1]);
});

test('relPath 规则段仍按路径加载', () => {
  const { root, cm } = setup();
  fs.mkdirSync(path.join(root, '.sunshine', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sunshine', 'rules', 'src.rules.md'), 'paths: src/\n- 规则X\n');
  const items = cm.assemble([{ kind: 'history', content: 'h' }], 'src/a.ts');
  assert.ok(items.some((i) => i.content.includes('规则X')));
});

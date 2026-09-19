import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager } from './index';
import { FileStore } from '../../storage/adapter';
// 测试卫生：本文件装配断言按段序/清单精确标定，数据目录与全局技能根钉文件私有目录——共享数据目录被并发测试写入学习技能时，技能清单进装配产物会破坏基线
process.env.SUNSHINEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm-data-'));
process.env.SUNSHINEX_USER_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm-uskills-'));

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

test('path-scoped 规则机制已清退：.sunshine/rules 就位也不注入（防回归钉子）', () => {
  const { root, cm } = setup();
  fs.mkdirSync(path.join(root, '.sunshine', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sunshine', 'rules', 'src.rules.md'), 'paths: src/\n- 规则X\n');
  const items = cm.assemble([{ kind: 'history', content: 'h' }]);
  assert.ok(!items.some((i) => i.content.includes('规则X')), '规则机制已清退，任何路径都不注入');
});

test('技能清单冻结段注入：快照尾（history 前）、相邻帧前缀稳定', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm-'));
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), '# 项目规范\n');
  fs.mkdirSync(path.join(root, '.sunshinex', 'skills', 'greet'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sunshinex', 'skills', 'greet', 'skill.md'), '---\nname: Greet\ndescription: 问候用户\nversion: 1.0.0\n---\n正文');
  const cm = new ContextManager(root, new FileStore(root));
  const items = cm.assemble([{ kind: 'history', content: '1: task -> A' }]);
  const idx = items.findIndex((i) => i.content.includes('- Greet: 问候用户'));
  assert.ok(idx >= 0, '清单行存在于装配产物');
  assert.equal(items[idx].kind, 'system');
  const histIdx = items.findIndex((i) => i.kind === 'history');
  assert.ok(idx < histIdx, '清单在 history 之前（冻结段，不随对话位移）');
  const items2 = cm.assemble([{ kind: 'history', content: '1: task -> A' }, { kind: 'history', content: '2: reply -> 完成' }]);
  const t1 = items.map((i) => i.content).join('\n');
  const t2 = items2.map((i) => i.content).join('\n');
  assert.ok(t2.startsWith(t1), '相邻帧公共前缀逐字节稳定（含清单段）');
  fs.rmSync(root, { recursive: true, force: true });
});

test('技能清单：空清单零开销注入、/new 刷新点重读', () => {
  const { root, cm } = setup();
  const lead = 'Available skills';
  assert.ok(!cm.assemble([]).some((i) => i.content.includes(lead)), '无技能零注入');
  fs.mkdirSync(path.join(root, '.sunshinex', 'skills', 'late'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sunshinex', 'skills', 'late', 'skill.md'), '---\nname: Late\ndescription: 迟到技能\nversion: 1.0.0\n---\n正文');
  assert.ok(!cm.assemble([]).some((i) => i.content.includes(lead)), '快照冻结：构造后改盘不位移前缀');
  cm.resetSession(); // /new = 刷新点：快照重读
  assert.ok(cm.assemble([]).some((i) => i.content.includes('- Late: 迟到技能')), '/new 后新快照含新技能');
  fs.rmSync(root, { recursive: true, force: true });
});

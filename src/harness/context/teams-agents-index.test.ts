import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContextManager } from './index';

// 测试卫生（assemble.test.ts 同款）：数据目录与用户配置根（HOME）钉文件私有目录——
// 本机真实 ~/.sunshinex/teams 与 agents 目录的注册条目会污染零注入/恒在断言（teams 清单空态断言尤其敏感）
process.env.SUNSHINEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ta-data-'));
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ta-home-'));

/** 预置盘面（一 team 一 agent）；root 单独出料——确定性钉子要「同一 root 两个独立实例」 */
function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-teams-'));
  const teamsDir = path.join(root, '.sunshinex', 'teams', 'fullstack-delivery');
  fs.mkdirSync(teamsDir, { recursive: true });
  fs.writeFileSync(path.join(teamsDir, 'team.md'), '---\nname: 全栈交付小队\ndescription: 一站式交付\nmembers: planner developer\n---\n章程');
  const agentDir = path.join(root, '.sunshinex', 'agents', 'devx');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'agent.md'), '---\nname: DevX\ndescription: 编码实现\n---\n写代码的框定');
  return root;
}

function fixtureCtx(): ContextManager {
  return new ContextManager(fixtureRoot(), {} as never);
}

test('快照注入 agents/teams 清单段（确定性、system kind）', () => {
  const ctx = fixtureCtx();
  const parts = ctx.snapshotPartsView();
  assert.ok(parts.agents.length === 1 && parts.teams.length === 1);
  assert.ok(parts.agents[0]!.content.includes('- DevX (id: devx): 编码实现'));
  assert.ok(parts.teams[0]!.content.includes('- 全栈交付小队 (id: fullstack-delivery)'));
  assert.ok(parts.teams[0]!.content.includes('#team-id')); // lead 行声明软引用（plan §1105：用户以 "#team-id" 引用团队）
  assert.ok(ctx.snapshotExport().items.every((it) => it.kind === 'system' || it.kind === 'instruction'));
});

test('快照确定性：同盘两次 rebuild 逐字节同输出（禁时变字段回归钉）', () => {
  // 同一 root 两个独立 ContextManager（快照重建同构）：清单段含内置 agents 段，导出 items + sig 全量比对——
  // 任一段混入时间戳/随机序/盘绝对路径即失配（快照前缀逐字节稳定是压缩与恢复面的前提）
  const root = fixtureRoot();
  const ctx1 = new ContextManager(root, {} as never);
  const ctx2 = new ContextManager(root, {} as never);
  assert.equal(JSON.stringify(ctx1.snapshotExport()), JSON.stringify(ctx2.snapshotExport()));
});

test('空目录：teams 零注入（无 teams 段）；agents 段恒在（内置四角色）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-empty-'));
  const ctx = new ContextManager(root, {} as never);
  const parts = ctx.snapshotPartsView();
  assert.equal(parts.teams.length, 0);
  // 内置四角色恒在 → agents 清单段恒在（恒在语义对齐记忆引导）：清单段恒为一条，四角色 id 行齐备
  assert.equal(parts.agents.length, 1);
  for (const id of ['planner', 'developer', 'tester', 'reviewer']) {
    assert.ok(parts.agents[0]!.content.includes(`(id: ${id})`), `内置 ${id} 行在 agents 清单段`);
  }
});

test('漂移：会中改盘 → detect 产 [teams] added 行；基线随比对前进', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-drift-'));
  const ctx = new ContextManager(root, {} as never);
  assert.deepEqual(ctx.checkConstantsDrift(), []);
  const dir = path.join(root, '.sunshinex', 'teams', 'extra');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team.md'), '---\nname: Extra\ndescription: 后加\nmembers: planner\n---\nbody');
  const notices = ctx.checkConstantsDrift();
  assert.ok(notices.some((n) => n.startsWith('[teams] added:')));
  assert.deepEqual(ctx.checkConstantsDrift(), []); // 基线前进：同一变更只告知一次
});

test('会中注册 agent → detect 产 [agents] added 行（描述截 128 随行）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-drift-agents-'));
  const ctx = new ContextManager(root, {} as never);
  assert.deepEqual(ctx.checkConstantsDrift(), []);
  const dir = path.join(root, '.sunshinex', 'agents', 'late');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.md'), '---\nname: Late\ndescription: 迟到的智能体\n---\n框定');
  const notices = ctx.checkConstantsDrift();
  assert.match(notices.find((n) => n.startsWith('[agents] added:'))!, /^\[agents\] added: late \(迟到的智能体\) — load the agent card with the agent tool$/);
  assert.deepEqual(ctx.checkConstantsDrift(), []); // 基线前进：同一变更只告知一次
});

test('旧档案容错：ctx-snap 行无 agents/teams sig 字段与段条目 → restore 成功且基线缺省空串', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-legacy-'));
  const ctx = new ContextManager(root, {} as never);
  const ok = ctx.restoreSnapshot({
    items: [{ part: 'instructions', kind: 'instruction', content: 'legacy SUNSHINE line' }],
    sig: { skills: '', memory: '', sunshinex: null, globalSunshine: null },
  });
  assert.equal(ok, true);
  // 旧档案无 agents/teams 基线字段 → 回种缺省 ''（零迁移容忍），exportSig 如实透出
  assert.equal(ctx.snapshotExport().sig.agents, '');
  assert.equal(ctx.snapshotExport().sig.teams, '');
  // 旧档案无 agents/teams 段条目 → 分段空数组兜底，展平面仍含其余段
  assert.deepEqual(ctx.snapshotPartsView().agents, []);
  assert.deepEqual(ctx.snapshotPartsView().teams, []);
  assert.ok(ctx.snapshotView().some((i) => i.content === 'legacy SUNSHINE line'));
});

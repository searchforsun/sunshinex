import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ok } from '../../result';
import { makeAgentTool, makeTeamTool } from './builtin';

test('team 工具三态 + 观察原文不截断', async () => {
  const tool = makeTeamTool({
    resolve: (id: string) => (id === 'solo' ? ok({ id: 'solo', name: '单人队', description: 'd', version: '0.1.0', members: ['planner'], enabled: true, source: 'user' as const, sourceDir: '/x', missing: [] }) : { ok: false, error: { code: 'TEAM_NOT_FOUND', message: 'nope' } } as never),
  }, { get: (id: string) => (id === 'planner' ? { id: 'planner', name: 'Planner', description: 'breakdown', framing: 'f' } : undefined) });
  const r = await tool.executor({ id: 'solo' });
  assert.ok(String(r.stdout).startsWith('[team] solo — 单人队'));
  // 偏差①：章程卡骨架字节固定（teams.ts §3.3），缺省 lead=members[0] 恒星标（teams.test.ts 同款钉死）——
  // brief 原文断言 '- planner — Planner: breakdown' 缺星必挂；断言意图（成员经 agents.get 现算出名/描述）不变，随骨架补星
  assert.ok(String(r.stdout).includes('- *planner — Planner: breakdown'));
  // 章程正文读 sourceDir/team.md 缺档回落行（'/x' 无档，fallback 路径即本用例实测；自评清单钉）
  assert.ok(String(r.stdout).includes('(charter body unavailable)'));
  await assert.rejects(() => tool.executor({ id: 'nope' }), /TEAM_NOT_FOUND/);
});

test('agent 工具：在册出卡、不在册 NOT_IN_CATALOG', async () => {
  const tool = makeAgentTool({ get: (id: string) => (id === 'devx' ? { id: 'devx', name: 'DevX', description: 'd', framing: '写代码' } : undefined) });
  const r = await tool.executor({ id: 'devx' });
  assert.ok(String(r.stdout).includes('role:\n写代码'));
  await assert.rejects(() => tool.executor({ id: 'nope' }), /NOT_IN_CATALOG/);
});

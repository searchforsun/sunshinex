// 环境事实行（2026-11-23 路线一）单测：ensureEnvWorkdirFact 四态矩阵 + 局部压缩折后重建。
// 背景：workDir 稳定段行静态化（前缀缓存零重写），当前工作目录权威改由链尾 env 行承载——
// 翻转（reactor 轮边界巡检）/压缩折叠后重建/回退对齐（restoreSession 后调用）三面同口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager, ensureEnvWorkdirFact } from './context';
import { FileStore } from '../storage/adapter';
import { envWorkdirLine } from './prompts/shared';

function makeCtx(tmp: string): ContextManager {
  return new ContextManager(tmp, new FileStore(path.join(tmp, '.data')));
}

test('ensureEnvWorkdirFact 四态矩阵：主区零冗余/进树追加/幂等/回主区 supersedes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-envfact-unit-'));
  try {
    const cm = makeCtx(tmp);
    // ①主区且链上从无 env 行 → no-op（静态 workDir 行已表主根，零冗余）
    ensureEnvWorkdirFact(cm, tmp, null);
    assert.equal(cm.chainView().some((s) => s.action === 'env'), false, '主区零冗余');
    // ②进树 → 尾追树内行
    const tree = path.join(tmp, 'wt');
    ensureEnvWorkdirFact(cm, tmp, tree);
    let envs = cm.chainView().filter((s) => s.action === 'env');
    assert.equal(envs.length, 1, '进树恰一行 env 行');
    assert.equal(envs[0]!.observation, envWorkdirLine(tree, tmp), '文案=envWorkdirLine 单点');
    // ③幂等：重复调用零追加
    ensureEnvWorkdirFact(cm, tmp, tree);
    assert.equal(cm.chainView().filter((s) => s.action === 'env').length, 1, '匹配即 no-op');
    // ④回主区 → 尾追主区行（supersedes 旧行；旧行留链史按时间序被废黜）
    ensureEnvWorkdirFact(cm, tmp, null);
    envs = cm.chainView().filter((s) => s.action === 'env');
    assert.equal(envs.length, 2, '失配尾追不删旧行');
    assert.equal(envs[1]!.observation, envWorkdirLine(null, tmp), '主区行=envWorkdirLine(null, main)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('局部压缩折叠 env 行后 ensure 重建当前事实（系统提示折后恒在场；全量压缩同口）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-envfact-compact-'));
  try {
    const cm = makeCtx(tmp);
    const tree = path.join(tmp, 'wt');
    cm.appendChain([{ action: 'task', observation: 'goal' }]);
    ensureEnvWorkdirFact(cm, tmp, tree);
    assert.equal(cm.chainView().filter((s) => s.action === 'env').length, 1);
    // 模拟局部压缩：水位折掉前 2 条（task+env 都入压缩块代表区）
    cm.trimChainFront(2);
    assert.equal(cm.chainView().some((s) => s.action === 'env'), false, '折叠后 env 行已不在活视图');
    // 折后重建：当前事实尾追恒在场（reactor 轮边界巡检同口）
    ensureEnvWorkdirFact(cm, tmp, tree);
    const envs = cm.chainView().filter((s) => s.action === 'env');
    assert.equal(envs.length, 1, '折后重建恰一行当前事实');
    assert.equal(envs[0]!.observation, envWorkdirLine(tree, tmp));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

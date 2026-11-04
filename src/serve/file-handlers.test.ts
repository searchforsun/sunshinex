import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { walkTreeBounded, handlePlans } from './file-handlers';
import { resolveDataDir } from '../config/data-dir';

/** walkTreeBounded 截断分支直测（L 类「显式未覆盖」档清偿：双上限经参注入——生产恒传
 *  INDEX_MAX_DIRS/INDEX_MAX_ENTRIES 缺省常量，20k/50k 量级单测不可达，截断分支此前恒不可达）。
 *  fixture 纯 fs 零 git 依赖：非仓库 → gitIgnored 空集（优雅降级面同被覆盖）；忽略判定面
 *  （check-ignore/忽略目录不入下波）由 daemon.test ⑫c 经真 daemon 端到端覆盖，不在此重复。 */

function tmpTree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'walk-tree-'));
}

test('walkTreeBounded:条目上限触顶 truncated=true（换回「上限不可达」旧形态即红）', () => {
  const root = tmpTree();
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x', 'utf8');
  const built = walkTreeBounded(root, 100, 3);
  assert.equal(built.truncated, true);
  assert.equal(built.entries.length, 3);
  assert.equal(built.gitIgnored.size, 0); // 非仓库：忽略集优雅空集
});

test('walkTreeBounded:目录上限触顶 truncated=true;未触顶路径 truncated=false', () => {
  const root = tmpTree();
  for (let i = 0; i < 5; i += 1) fs.mkdirSync(path.join(root, `d${i}`));
  const capped = walkTreeBounded(root, 3, 100);
  assert.equal(capped.truncated, true);
  const roomy = walkTreeBounded(root, 100, 100);
  assert.equal(roomy.truncated, false);
  assert.equal(roomy.entries.length, 5); // 5 目录全索引,目录段先于文件段(纯目录树无文件段)
});

/** handlePlans 计划清单直测（2026-11-04 计划页签数据面）：mtime 降序、首行计划名剥 H1、
 *  非 plan.md 不入列、空档=未命名回退、无数据目录=空清单不报错。fake io 面仅 root 消费
 *  （handlePlans 对 session 只读 .root），sessionFor 直回根对象。 */
test('handlePlans:计划清单=mtime 降序+首行计划名(剥 H1);非 plan 文件/空目录静默', () => {
  // 夹具走 resolveDataDir(root)(test-env 预载 SUNSHINEX_DATA_DIR=隔离数据根,解析被它覆写——
  // ed32f93 同族错位根修):两段夹具共用同一解析目录,第二段(空目录)前显式清场
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-tab-'));
  const dir = path.join(resolveDataDir(root), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const j1 = path.join(dir, 'j1.plan.md');
  const j2 = path.join(dir, 'j2.plan.md');
  const j3 = path.join(dir, 'j3.plan.md');
  fs.writeFileSync(j1, `\n# 重构认证模块\n1. 步骤A`);
  fs.writeFileSync(j2, '无H1首行计划名');
  fs.writeFileSync(j3, '');
  fs.writeFileSync(path.join(dir, 'j4.txt'), 'not a plan'); // 非 .plan.md 不入列
  const tNow = Date.now();
  fs.utimesSync(j2, new Date(tNow), new Date(tNow)); // j2 最新(降序首位)
  fs.utimesSync(j3, new Date(tNow - 30_000), new Date(tNow - 30_000));
  fs.utimesSync(j1, new Date(tNow - 60_000), new Date(tNow - 60_000)); // j1 最旧
  const sent: Array<{ status: number; body: unknown }> = [];
  const fakeRes = {} as import('node:http').ServerResponse;
  const io = {
    send: (_res: import('node:http').ServerResponse, status: number, body: object) => sent.push({ status, body }),
    sessionFor: () => ({ root }) as unknown as import('./session').SessionRuntime,
  };
  handlePlans(io, {} as import('node:http').IncomingMessage, fakeRes, 's1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.status, 200);
  const plans = (sent[0]!.body as { plans: Array<{ name: string; path: string; mtime: number }> }).plans;
  assert.equal(plans.length, 3, '非 plan.md 不入列');
  assert.equal(plans[0]!.name, '无H1首行计划名', 'mtime 降序(最近在前)');
  assert.equal(plans[0]!.path, j2);
  assert.equal(plans[1]!.name, '', '空档=未命名回退');
  assert.equal(plans[2]!.name, '重构认证模块', '首行非空行=计划名,H1 前缀剥除');
  assert.equal(plans[2]!.path, j1);
  // 无计划面:清场后(目录缺席)空清单 200,不抛
  fs.rmSync(dir, { recursive: true, force: true });
  handlePlans(io, {} as import('node:http').IncomingMessage, fakeRes, 's2');
  assert.equal((sent[1]!.body as { plans: unknown[] }).plans.length, 0);
});

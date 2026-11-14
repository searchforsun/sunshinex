import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager } from './index';
import type { CtxSnapshot } from './index';
import type { StorageAdapter } from '../../storage/adapter';
import { buildMessages } from './messages';

/** 快照导出/回种 + reloadContext snap 事件（2026-10-31 spec Task 3）：
 *  字节级往返（跨重建逐位稳定）、回种不触发订阅（重放零双写）、reloadContext 发 snap 信号（订阅面落 ctx-snap 行）。 */

// store 形参未用（持久化双轨已并轨至 journal 事件流）——哑对象透传即可
const fakeStore = {} as StorageAdapter;

test('snapshotExport/restoreSnapshot: 字节级往返', () => {
  const cm = new ContextManager('/nonexistent-root', fakeStore);
  const snap = cm.snapshotExport();
  const cm2 = new ContextManager('/nonexistent-root', fakeStore);
  assert.equal(cm2.restoreSnapshot(snap), true);
  // 字节级不变量：装配快照逐位相等
  assert.equal(JSON.stringify(cm2.snapshotExport()), JSON.stringify(snap));
});

test('restoreSnapshot 不触发订阅（重放零双写）', () => {
  const cm = new ContextManager('/nonexistent-root', fakeStore);
  let events = 0;
  cm.onContextChange(() => {
    events += 1;
  });
  cm.restoreSnapshot(cm.snapshotExport());
  assert.equal(events, 0);
});

test('reloadContext 发出 snap 事件（压缩/显式刷新后的落档信号）', () => {
  const cm = new ContextManager('/nonexistent-root', fakeStore);
  const kinds: string[] = [];
  cm.onContextChange((c) => kinds.push(c.kind));
  cm.reloadContext();
  assert.deepEqual(kinds, ['snap']);
});

test('restoreSnapshot 载荷不合法（条目 kind 越界）整包拒收返回 false', () => {
  const cm = new ContextManager('/nonexistent-root', fakeStore);
  const bad: CtxSnapshot = {
    items: [{ part: 'instructions', kind: 'bogus', content: 'x' }],
    sig: { skills: '', memory: '', sunshinex: null, globalSunshine: null },
  };
  assert.equal(cm.restoreSnapshot(bad), false);
  // 拒收后快照不被部分污染（整包原子）
  assert.equal(cm.snapshotView().length, cm.snapshotExport().items.length);
});

// —— 实例品性冻结层（2026-11-15 sunx 设计 §17.1：charter=会话冻结第三层，全局 → 项目 → 品性；
// 用户自撰物料原样直存零加工；缺席=无此层无空层；随 ctx-snap 导出/回种逐字节稳定） ——

test('charter 冻结层：构造注入 → 快照导出（instructions 尾条 + sig.charter）→ restore 回种逐字节恒等', () => {
  const cm = new ContextManager('/nonexistent-root', fakeStore, undefined, { charter: 'Charter v1 ...' });
  const snap = cm.snapshotExport();
  assert.equal(snap.sig.charter, 'Charter v1 ...', 'sig 随档记录品性原文');
  const instr = snap.items.filter((i) => i.part === 'instructions');
  assert.ok(instr.length > 0, '品性层条目在档');
  assert.equal(instr[instr.length - 1].content, 'Charter v1 ...', '层位在 instructions 尾（SUNSHINE 之后）');
  const cm2 = new ContextManager('/nonexistent-root', fakeStore);
  assert.equal(cm2.restoreSnapshot(snap), true);
  assert.equal(JSON.stringify(cm2.snapshotExport()), JSON.stringify(snap), '字节级往返');
  // buildMessages 首帧快照段（system#2）含品性原文（字节级：join 后 includes 原文）
  const msgs = buildMessages({ stableSegment: 'S', snapshot: cm2.snapshotView(), compacted: [], chain: [] });
  assert.ok(
    msgs.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('Charter v1 ...')),
    '回种后消息面渲染出品性层原文',
  );
});

test('charter 层位与刷新点存活：全局 → 项目 → 品性；reloadContext 不掉层', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-charter-'));
  try {
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), '# 项目规范\n- 规则A\n');
    const cm = new ContextManager(root, fakeStore, undefined, { charter: 'CHARTER-VERBATIM' });
    const instrOf = () => cm.snapshotPartsView().instructions.map((i) => i.content);
    let instr = instrOf();
    assert.ok(instr.indexOf('CHARTER-VERBATIM') > instr.findIndex((c) => c.includes('规则A')), '品性层在项目层之后');
    cm.reloadContext(); // 刷新点：盘重读（快照翻新），品性层存活（会话级常量，非磁盘源）
    instr = instrOf();
    assert.ok(instr.includes('CHARTER-VERBATIM'), '刷新点不掉层');
    assert.equal(cm.snapshotExport().sig.charter, 'CHARTER-VERBATIM');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('charter 缺席：无层零条目、sig.charter=null（无空层）；空串归一缺席', () => {
  const cm = new ContextManager('/nonexistent-root', fakeStore);
  const snap = cm.snapshotExport();
  assert.equal(snap.sig.charter ?? null, null);
  assert.ok(!snap.items.some((i) => i.part === 'instructions' && i.content === ''), '无空层条目');
  const empty = new ContextManager('/nonexistent-root', fakeStore, undefined, { charter: '' });
  assert.equal(empty.snapshotExport().sig.charter ?? null, null, '空串归一为缺席');
  assert.ok(!empty.snapshotExport().items.some((i) => i.part === 'instructions'), '空串不产空层');
  // 缺席形态回种同样恒等；回种以落档为准（构造注入不渗透落档态）
  const cm3 = new ContextManager('/nonexistent-root', fakeStore, undefined, { charter: 'X' });
  assert.equal(cm3.restoreSnapshot(snap), true);
  assert.equal(cm3.snapshotExport().sig.charter ?? null, null);
  assert.ok(!cm3.snapshotExport().items.some((i) => i.content === 'X'), '缺席落档回种后品性层缺席');
});

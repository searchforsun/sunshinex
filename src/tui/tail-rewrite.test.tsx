import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from './test-ink';
import { MessageList } from './components/MessageList';
import { App } from './components/App';
import { ScriptedAdapter } from '../model/adapter';
import { SessionController } from './session';
import { buildBannerInfo } from './banner-info';
import { buildTranscriptDecisions } from './transcript-view';
import { ChatItem } from './session';
import { createTailLedger, printedEntryLines, recomputeTailPlan } from './tail-rewrite';

const columns = 100;
let seq = 0;
function item(partial: Partial<ChatItem>): ChatItem {
  seq += 1;
  return { role: 'assistant', text: '', ts: 0, seq, ...partial };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 全量输出行数（banner 恒在场，差分口径互相抵消） */
async function renderedLines(messages: ChatItem[], view: { expandAll: boolean; latestFull: boolean }): Promise<number> {
  const r = render(
    <MessageList
      messages={messages}
      columns={columns}
      banner={buildBannerInfo()}
      expandAll={view.expandAll}
      latestFull={view.latestFull}
    />,
  );
  await sleep(60);
  const n = (r.allOutput().replace(/\n$/, '').split('\n')).length;
  r.unmount();
  return n;
}

/** 计数器 vs 真实渲染的差分门禁（2026-09-30 方案 A）：printedEntryLines 与 MessageRow 渲染分支
 *  一一对应——任一侧漂移即帧高错位、就地擦写落错行。两种视图形态（折叠/全展开）都钉 */
test('printedEntryLines 差分门禁：账本计数 === 真实渲染行数（折叠态与全展开态）', async () => {
  const rich: ChatItem[] = [
    item({ role: 'user', text: '请分析这个项目的结构与风险，并给出可执行的迁移建议；长文本触发按列宽折行，验证分带行数与计数器一致——'.repeat(2) }),
    item({ role: 'assistant', text: '先给结论：\n\n- 甲项要修\n- 乙项要观察\n\n| 模块 | 结论 |\n| --- | --- |\n| 渲染层 | 一致 |\n| 账本层 | 同源 |\n\n收尾段，验证块间空行计入。' }),
    item({ role: 'thinking', text: 'Thought for 3s', detail: '先看目录结构\n再读配置与入口\n最后汇总风险清单与迁移步骤' }),
    item({ role: 'tool', kind: 'call', text: 'READ src/tui/session.ts', callId: 'c1' }),
    item({ role: 'tool', kind: 'result', text: '首行摘要\n第二行\n第三行', ok: true, callId: 'c1' }),
    item({ role: 'system', text: '一段相当长的系统说明行，用于触发按列宽折行的行数膨胀，确保计数器与渲染器在换行边界处口径严格一致（截断到合适长度即可）'.repeat(2) }),
    item({ role: 'step', text: '阶段说明正文：\n\n- 步骤甲已完成\n- 步骤乙进行中' }),
    item({ role: 'assistant', text: '第二段正文收束。' }),
  ];
  for (const view of [{ expandAll: false, latestFull: false }, { expandAll: true, latestFull: true }]) {
    const base = await renderedLines([], view);
    const total = await renderedLines(rich, view);
    const delta = total - base;
    const decisions = buildTranscriptDecisions(rich, view);
    let expected = 0;
    for (let i = 0; i < rich.length; i++) {
      const d = decisions[i]!;
      if (!d.visible) continue;
      const counted = printedEntryLines(rich[i]!, d.full, columns);
      assert.ok(counted !== undefined, `条目 ${i}（${rich[i]!.role}）计数不可数——该形态出现在可打印路径即门禁失败`);
      expected += counted + 1; // marginBottom 档位
    }
    assert.equal(delta, expected, `视图 ${JSON.stringify(view)}：渲染行数 ${delta} 应等于账本口径 ${expected}`);
  }
});

/* ---------- recomputeTailPlan 纯函数 ---------- */

test('recomputeTailPlan：形态全等 → null（零重绘）；决策翻转 → from + 尾部行数和', () => {
  const u1 = item({ role: 'user', text: '问一' });
  const a1 = item({ role: 'assistant', text: '答一' });
  const t1 = item({ role: 'thinking', text: 'Thought for 2s', detail: '甲\n乙' });
  const u2 = item({ role: 'user', text: '问二' });
  const ledger = createTailLedger();
  ledger.slots.push({ item: u1, visible: true, full: true, lines: 3 });
  ledger.slots.push({ item: a1, visible: true, full: true, lines: 5 });
  ledger.slots.push({ item: t1, visible: true, full: true, lines: 4 });
  // 全等：条目引用与 visible/full 逐一相同
  recomputeTailPlan(ledger, [u1, a1, t1], [{ visible: true, full: true }, { visible: true, full: true }, { visible: true, full: true }]);
  assert.ok(ledger.plan === null, '屏上形态与决策全等 → 零重绘');
  const read = (): { from: number; suffixLines: number } | null => ledger.plan as { from: number; suffixLines: number } | null;
  // 锚点落定：t1 折叠（full 翻转）→ from=2，suffix = 4
  recomputeTailPlan(ledger, [u1, a1, t1], [{ visible: true, full: true }, { visible: true, full: true }, { visible: true, full: false }]);
  assert.deepEqual(read(), { from: 2, suffixLines: 4 }, '首失配位与其上已打印行数');
  // 条目富化（引用替换）也算失配
  const t1b = { ...t1, detail: '甲\n乙\n丙' };
  recomputeTailPlan(ledger, [u1, a1, t1b], [{ visible: true, full: true }, { visible: true, full: true }, { visible: true, full: false }]);
  assert.ok(read() !== null && read()!.from === 2, '引用替换即失配（富化行重写）');
  // 追加未记账条目：slots 覆盖不到的区间按 0 计（记账先行，常态不出现——防御口径）
  recomputeTailPlan(ledger, [u1, a1, t1, u2], [{ visible: true, full: true }, { visible: true, full: true }, { visible: true, full: false }, { visible: true, full: true }]);
  assert.ok(read() !== null && read()!.from === 2, '追加条目不改变首失配位');
  // 收缩（/rewind 等）：不可就地重写
  recomputeTailPlan(ledger, [u1], [{ visible: true, full: true }]);
  assert.equal(ledger.forceFull, true, '条目数收缩 → 强制全量');
  assert.ok(read() === null);
});

/* ---------- MessageList 记账集成（共享账本跨挂载模拟折叠翻转） ---------- */

test('MessageList 记账：打印形态入账；新锚点落定后 plan 指向首翻转行与尾部行数和', async () => {
  // 折叠语义（transcript-view）：非末段只留「首个工具对 + 首个思考行」——第二组过程行在新锚点
  // 落定后 visible 翻 false，即账本失配、需要尾部重写的形态
  const m1: ChatItem[] = [
    item({ role: 'user', text: '问一' }),
    item({ role: 'assistant', text: '答一' }),
    item({ role: 'thinking', text: 'T1', detail: '思考甲\n思考乙' }),
    item({ role: 'tool', kind: 'call', text: 'READ a.ts', callId: 'k1' }),
    item({ role: 'tool', kind: 'result', text: 'ok 首行', ok: true, callId: 'k1' }),
    item({ role: 'thinking', text: 'T2', detail: '思考丙' }),
    item({ role: 'tool', kind: 'call', text: 'READ b.ts', callId: 'k2' }),
    item({ role: 'tool', kind: 'result', text: 'ok2', ok: true, callId: 'k2' }),
  ];
  const ledger = createTailLedger();
  const r1 = render(
    <MessageList messages={m1} columns={columns} banner={buildBannerInfo()} expandAll={false} latestFull={false} ledger={ledger} />,
  );
  await sleep(60);
  assert.equal(ledger.slots.length, m1.length, '逐条入账');
  assert.ok(ledger.plan === null, '最新段全显：屏上形态与决策一致');
  assert.ok(ledger.slots.slice(2).every((s) => s.lines > 0), '过程行按打印行数入账');
  const suffixBefore = ledger.slots.slice(5).reduce((n, s) => n + s.lines, 0);
  r1.unmount();

  // 新锚点（问二）落定：第二组过程行折叠（visible 翻 false）→ 账本与决策失配
  const m2 = [...m1, item({ role: 'user', text: '问二' })];
  const r2 = render(
    <MessageList messages={m2} columns={columns} banner={buildBannerInfo()} expandAll={false} latestFull={false} ledger={ledger} />,
  );
  await sleep(60);
  assert.equal(ledger.slots.length, m2.length, '账本跨挂载续账（尾部重写现场）');
  const plan = ledger.plan as { from: number; suffixLines: number } | null;
  assert.ok(plan !== null, '折叠翻转产生重写计划');
  assert.equal(plan.from, 5, '首翻转位=被收拢的第二组首个过程行（thinking T2）');
  // 擦写范围=失配位到屏底：含折叠前的旧过程行（7 行）+ 其后已打印的新锚点行（问二 = 1 行 + 档位 1）
  assert.equal(plan.suffixLines, suffixBefore + 2, '尾部行数和=失配位至屏底的打印行数累计');
  r2.unmount();

  // 尾部重写挂载（rewriteFrom=5）：banner 与前缀条目结构性缺席（屏上原样保留），只重放尾部
  const r3 = render(
    <MessageList messages={m2} columns={columns} banner={buildBannerInfo()} expandAll={false} latestFull={false} ledger={ledger} rewriteFrom={5} />,
  );
  await sleep(60);
  const out3 = r3.allOutput();
  assert.ok(!out3.includes('sunshinex') || !out3.includes('答一'), 'banner 与前缀正文不得重放');
  assert.ok(out3.includes('问二'), '尾部新锚点行重放');
  assert.equal(ledger.slots.length, m2.length, '前缀槽位截留、尾部续账');
  r3.unmount();
});

/* ---------- App 段锚点接线（方案 A 端到端：折叠翻转 → 'tail' 重绘请求） ---------- */

test('App 段锚点 effect：新锚点落定折叠过程行 → 请求 tail 重绘；过程行追加本身零重绘', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tailapp-'));
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"答一"}', '{"done":true,"reply":"答二"}']) });
    const repaints: Array<string | undefined> = [];
    term = render(
      <App
        controller={ctrl}
        banner={{ version: '1.0.0', model: 'm', root: tmp }}
        onRequestRepaint={(m) => { repaints.push(m); }}
      />,
    );
    await sleep(250);
    // 任务一：正文锚点（答一）落定
    await ctrl.submit('问一');
    await ctrl.waitIdle();
    // 两对工具行入档（隶属答一锚点段，追加本身不开新段、无折叠翻转）
    for (const [cid, text] of [['k1', 'ok1'], ['k2', 'ok2']] as const) {
      ctrl.onEventForTest({ type: 'tool-call', text: 'READ', payload: { input: { path: 'a' }, callId: cid } } as never);
      ctrl.onEventForTest({ type: 'tool-result', text, payload: { callId: cid, ok: true } } as never);
    }
    await sleep(550); // 超 400ms 防抖窗：确认零重绘（无新锚点、无翻转）
    assert.ok(repaints.length === 0, `过程行追加不应触发重绘（实际 ${JSON.stringify(repaints)}）`);
    // 任务二：问二/答二双锚点落定 → 上一段第二组过程行折叠 → 账本失配 → tail 请求
    await ctrl.submit('问二');
    await ctrl.waitIdle();
    await sleep(650);
    assert.ok(repaints.includes('tail'), `折叠翻转应请求 tail 重绘（实际 ${JSON.stringify(repaints)}）`);
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('printedEntryLines：ansi 条目按剥码行数计', () => {
  const item = { role: 'assistant', text: '\x1b[31m甲\x1b[0m\n乙\n', ts: 1, seq: 1, ansi: true } as never;
  assert.equal(printedEntryLines(item, false, 80), 2);
});

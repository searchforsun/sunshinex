import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatItem } from './session';
import { buildTranscriptDecisions } from './transcript-view';

let seq = 0;
const item = (role: ChatItem['role'], text: string, extra?: Partial<ChatItem>): ChatItem => ({
  role,
  text,
  ts: 0,
  seq: ++seq,
  ...extra,
});

test('正文锚点：无 ▶ 行的调研会话——正文收编过程行，历史组折叠为首个思考+首个工具对', () => {
  const messages = [
    item('user', '调研 deepseek-harness'),
    item('tool', 'FETCH 404', { kind: 'call' }),
    item('tool', 'EXEC_FAILED', { kind: 'result', ok: false }),
    item('thinking', 'Thought for 6s', { detail: '思考一全文' }),
    item('tool', 'FETCH readme', { kind: 'call' }),
    item('tool', '# DeepSeek Harness', { kind: 'result', ok: true }),
    item('assistant', '深入抓取官方文档：架构设计、开发指南与 Web UI 使用指南'),
    item('tool', 'FETCH arch', { kind: 'call' }),
    item('tool', '# Architecture', { kind: 'result', ok: true }),
    item('assistant', '调研结论全文'),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: false });
  assert.ok(d[0].visible, '用户输入恒显示');
  assert.ok(d[6].visible && d[9].visible, '正文锚点恒显示');
  assert.ok(d[1].visible && d[2].visible && d[3].visible, '历史组保留首个工具对与首个思考行');
  assert.ok(!d[4].visible && !d[5].visible, '历史组其余过程行折叠隐藏');
  assert.ok(d[7].visible && d[8].visible, '最近正文组全行');
  assert.ok(!d[3].full && !d[8].full, 'latestFull=false 时内容保持摘要');
});

test('正文锚点：Ctrl+O 仅最近正文组及其后展开全文，历史组仍摘要', () => {
  const messages = [
    item('tool', 'FETCH a', { kind: 'call' }),
    item('tool', 'ra', { kind: 'result', ok: true, detail: '全文A' }),
    item('thinking', 'Thought for 6s', { detail: '思考全文A' }),
    item('assistant', '正文一'),
    item('tool', 'FETCH b', { kind: 'call' }),
    item('tool', 'rb', { kind: 'result', ok: true, detail: '全文B' }),
    item('thinking', 'Thought for 21s', { detail: '思考全文B' }),
    item('assistant', '正文二'),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(d[1].visible && d[2].visible && d[3].visible, '历史组保留首动作');
  assert.ok(!d[1].full && !d[2].full, '历史组内容保持摘要（不随 latestFull 展开）');
  assert.ok(d[4].visible && d[5].visible && d[6].visible, '最近正文组全行');
  assert.ok(d[5].full && d[6].full, '最近正文组思考与工具结果全文');
  const folded = buildTranscriptDecisions(messages, { expandAll: true, latestFull: true });
  assert.ok(folded[1].visible && !folded[1].full, 'Tab+Ctrl+O：历史组全行仍摘要，全文仅最近组');
});

test('正交性：Tab 解除全部行折叠但不改变内容深度（详情只归 Ctrl+O）', () => {
  const messages = [
    item('tool', 'FETCH a', { kind: 'call' }),
    item('tool', 'ra', { kind: 'result', ok: true, detail: '全文A' }),
    item('assistant', '正文一'),
    item('tool', 'FETCH b', { kind: 'call' }),
    item('tool', 'rb', { kind: 'result', ok: true, detail: '全文B' }),
    item('assistant', '正文二'),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: true, latestFull: false });
  assert.ok(d.every((s) => s.visible), 'Tab 解除全部行折叠');
  assert.ok(d.every((s) => !s.full), 'Tab 不改变内容深度');
});

test('运行态：正文未出时全行，Ctrl+O 直达全文、Tab 不产生详情', () => {
  const messages = [
    item('assistant', '正文一'),
    item('tool', 'FETCH b', { kind: 'call' }),
    item('tool', 'rb', { kind: 'result', ok: true, detail: '全文B' }),
    item('tool', 'FETCH c', { kind: 'call' }),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(d[0].visible, '正文一恒显示');
  assert.ok(d[1].visible && d[2].visible && d[3].visible, '进行中组全行（流式动作行不消失）');
  assert.ok(d[2].full && d[3].full, '进行中组位于最近正文组之后，随 Ctrl+O 全文');
});

test('运行态：无任何正文时全行摘要——Ctrl+O 直达全文，Tab 不产生详情', () => {
  const messages = [
    item('user', '读文件'),
    item('tool', 'READ a.txt', { kind: 'call' }),
    item('tool', 'ok', { kind: 'result', ok: true, detail: '全文' }),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(d.every((s) => s.visible), '无正文锚点不折叠');
  assert.ok(d[1].full && d[2].full, 'Ctrl+O 运行中直达全文');
  const d2 = buildTranscriptDecisions(messages, { expandAll: true, latestFull: false });
  assert.ok(d2.every((s) => s.visible), 'Tab 全行');
  assert.ok(!d2[1].full && !d2[2].full, 'Tab 不产生详情');
});

test('plan 场景：▶ 阶段行与正文混合分组——正文收编当前阶段、新 ▶ 开启下一组', () => {
  const messages = [
    item('step', '检索阶段'),
    item('tool', 'READ a.txt', { kind: 'call' }),
    item('tool', 'ok', { kind: 'result', ok: true }),
    item('tool', 'READ b.txt', { kind: 'call' }),
    item('tool', 'ok2', { kind: 'result', ok: true }),
    item('assistant', '阶段一结论'),
    item('step', '汇总阶段'),
    item('tool', 'READ c.txt', { kind: 'call' }),
    item('tool', 'ok3', { kind: 'result', ok: true, detail: '全文C' }),
    item('assistant', '汇总正文'),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: false });
  assert.ok(d[1].visible && d[2].visible, '历史组保留首个工具对');
  assert.ok(!d[3].visible && !d[4].visible, '历史组其余工具对折叠');
  assert.ok(d[0].visible && d[6].visible, '▶ 阶段行恒可见');
  assert.ok(d[5].visible && d[9].visible, '正文锚点恒显示');
  const deep = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(deep[7].full && deep[8].full, 'Ctrl+O 作用于最近正文组');
  assert.ok(!deep[2].full, '历史组不随 latestFull 展开');
});

test('回归：多阶段调研（▶ 各自成组 + 正文切块收编）——每阶段独立保留概要、Ctrl+O 落在正文所在组', () => {
  const messages = [
    item('thinking', 'Thought for 5s', { detail: '想A' }),
    item('tool', 'GLOB *', { kind: 'call' }),
    item('tool', '.gitignore', { kind: 'result', ok: true }),
    item('tool', 'READ pom.xml', { kind: 'call' }),
    item('tool', 'xml 内容', { kind: 'result', ok: true }),
    item('step', '补充查证：读取 README、CI 配置…'),
    item('thinking', 'Thought for 12s', { detail: '想B' }),
    item('tool', 'READ README.md', { kind: 'call' }),
    item('tool', 'md 内容', { kind: 'result', ok: true }),
    item('step', '正在核对前端 monorepo…'),
    item('thinking', 'Thought for 8s', { detail: '想C' }),
    item('tool', 'GLOB services', { kind: 'call', detail: 'G 全文' }),
    item('tool', 'Order.java', { kind: 'result', ok: true, detail: 'R 全文' }),
    item('assistant', 'Super Market 项目分析报告'),
    item('assistant', '（正文续块）'),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: false });
  assert.ok(d[0].visible && d[1].visible && d[2].visible, '开场过程保留首思考与首工具对');
  assert.ok(!d[3].visible && !d[4].visible, '开场其余工具对折叠');
  assert.ok(d[5].visible, '▶ 阶段行恒可见');
  assert.ok(d[6].visible && d[7].visible && d[8].visible, '补充查证阶段独立保留概要');
  assert.ok(d[9].visible, '▶ 阶段行恒可见');
  assert.ok(d[10].visible && d[11].visible && d[12].visible, '最近正文组全行');
  assert.ok(d[13].visible && d[14].visible, '正文流式切块全显');
  const deep = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(deep[11].full && deep[12].full, 'Ctrl+O 落在正文所在组（不再指向无过程行的切块组）');
  assert.ok(!deep[0].full && !deep[7].full, '历史组保持摘要');
});

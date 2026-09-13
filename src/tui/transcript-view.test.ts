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

test('桶模型：无 ▶ 行的调研会话——正文即锚点，历史桶折叠为首个思考+首个工具对', () => {
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
  assert.ok(d[1].visible && d[2].visible && d[3].visible, '历史桶保留首个工具对与首个思考行');
  assert.ok(!d[4].visible && !d[5].visible, '历史桶其余过程行折叠隐藏');
  assert.ok(d[7].visible && d[8].visible, '最近正文锚点桶全行');
  assert.ok(!d[3].full && !d[8].full, 'latestFull=false 时内容保持摘要');
});

test('桶模型：Ctrl+O 仅最近正文锚点桶及其后展开全文，历史桶仍摘要', () => {
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
  assert.ok(d[1].visible && d[2].visible && d[3].visible, '历史桶保留首动作');
  assert.ok(!d[1].full && !d[2].full, '历史桶内容保持摘要（不随 latestFull 展开）');
  assert.ok(d[4].visible && d[5].visible && d[6].visible, '最近正文锚点桶全行');
  assert.ok(d[5].full && d[6].full, '最近正文锚点桶思考与工具结果全文');
  const folded = buildTranscriptDecisions(messages, { expandAll: true, latestFull: true });
  assert.ok(folded[1].visible && !folded[1].full, 'Tab+Ctrl+O：历史桶全行仍摘要，全文仅最近桶');
});

test('桶模型：Tab 解除全部行折叠但内容保持摘要（与 Ctrl+O 正交）', () => {
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

test('桶模型：进行中桶（正文未出）全行，正文落定后自动成为收拢对象', () => {
  const messages = [
    item('assistant', '正文一'),
    item('tool', 'FETCH b', { kind: 'call' }),
    item('tool', 'rb', { kind: 'result', ok: true, detail: '全文B' }),
    item('tool', 'FETCH c', { kind: 'call' }),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(d[0].visible, '正文一恒显示');
  assert.ok(d[1].visible && d[2].visible && d[3].visible, '进行中桶全行（流式动作行不消失）');
  assert.ok(d[2].full && d[3].full, '进行中桶位于最近正文锚点之后，随 Ctrl+O 全文');
});

test('桶模型：无任何正文时全部视作进行中（全行摘要），latestFull 无作用域', () => {
  const messages = [
    item('user', '读文件'),
    item('tool', 'READ a.txt', { kind: 'call' }),
    item('tool', 'ok', { kind: 'result', ok: true, detail: '全文' }),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(d.every((s) => s.visible), '无正文锚点不折叠');
  assert.ok(d.every((s) => !s.full), 'latestFull 无作用域');
  const d2 = buildTranscriptDecisions(messages, { expandAll: true, latestFull: false });
  assert.ok(d2[2].full, '无组时沿用 expandAll 口径展开摘要');
});

test('桶模型：▶ 阶段行与 plan 逐步场景同样按正文锚点分组', () => {
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
  assert.ok(d[1].visible && d[2].visible, '历史桶保留首个工具对');
  assert.ok(!d[3].visible && !d[4].visible, '历史桶其余工具对折叠');
  assert.ok(d[0].visible && d[6].visible, '▶ 阶段行恒可见');
  assert.ok(d[5].visible && d[9].visible, '正文锚点恒显示');
  const deep = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(deep[7].full && deep[8].full, 'Ctrl+O 作用于最近正文锚点桶');
  assert.ok(!deep[2].full, '历史桶不随 latestFull 展开');
});

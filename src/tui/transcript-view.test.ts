import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatItem } from './session';
import { buildTranscriptDecisions } from './transcript-view';

let seq = 0;
const item = (role: ChatItem['role'], text: string, extra: Partial<ChatItem> = {}): ChatItem =>
  ({ seq: seq++, role, text, ts: 0, ...extra }) as ChatItem;

test('分段折叠：过程隶属其前正文，正文与阶段行恒显，仅最后一段全显', () => {
  const messages = [
    item('user', '分析一下项目'),
    item('thinking', 'Thought for 11s', { detail: '想A' }),
    item('tool', 'GLOB *', { kind: 'call' }),
    item('tool', '.gitignore', { kind: 'result', ok: true }),
    item('tool', 'READ pom.xml', { kind: 'call' }),
    item('tool', 'xml', { kind: 'result', ok: true }),
    item('assistant', '先看根目录结构'),
    item('thinking', 'Thought for 5s', { detail: '想B' }),
    item('tool', 'READ README.md', { kind: 'call' }),
    item('tool', 'md', { kind: 'result', ok: true }),
    item('assistant', '再看配置与文档'),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: false });
  assert.ok(d[0].visible, '用户问题恒显示');
  assert.ok(d[1].visible && d[2].visible && d[3].visible, '段0 保留首思考与首工具对');
  assert.ok(!d[4].visible && !d[5].visible, '段0 其余工具对折叠');
  assert.ok(d[6].visible, '正文一恒显示');
  assert.ok(d[7].visible && d[8].visible && d[9].visible, '段1 保留概要（隶属正文一的过程）');
  assert.ok(d[10].visible, '最后段正文恒显示');
  assert.ok(d.every((s) => !s.full), '默认态内容保持摘要');
  const deep = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(deep[7].full && deep[8].full && deep[9].full, 'Ctrl+O 展开最近正文段的过程全文');
  assert.ok(!deep[1].full && !deep[2].full, '更早阶段保持摘要');
  const tab = buildTranscriptDecisions(messages, { expandAll: true, latestFull: false });
  assert.ok(tab[4].visible && tab[5].visible, 'Tab 解除全部行折叠');
  assert.ok(tab.every((s) => !s.full), 'Tab 不改变内容深度');
});

test('运行中无正文：▶ 阶段即收拢上一段，当前段全行，Ctrl+O 直达全文', () => {
  const messages = [
    item('thinking', 'Thought for 11s', { detail: '想A' }),
    item('tool', 'GLOB *', { kind: 'call' }),
    item('tool', '.gitignore', { kind: 'result', ok: true }),
    item('step', '核对服务分层'),
    item('thinking', 'Thought for 5s', { detail: '想B' }),
    item('tool', 'GLOB services/*', { kind: 'call' }),
    item('tool', 'ok', { kind: 'result', ok: true }),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: false });
  assert.ok(d[0].visible && d[1].visible && d[2].visible, '开场段保留概要（边跑边收）');
  assert.ok(d[3].visible, '▶ 行恒显示');
  assert.ok(d[4].visible && d[5].visible && d[6].visible, '当前活动段全行');
  const deep = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(deep[4].full && deep[5].full && deep[6].full, 'Ctrl+O 运行中直达当前段全文');
});

test('正文0 开场形态：用户问题 / 正文0 / 过程概要 / 正文一', () => {
  const messages = [
    item('user', '分析项目'),
    item('assistant', '我先看根目录'),
    item('thinking', 'Thought for 5s', { detail: '想' }),
    item('tool', 'GLOB *', { kind: 'call' }),
    item('tool', 'files', { kind: 'result', ok: true }),
    item('assistant', '根目录结论'),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: false });
  assert.ok(d[0].visible && d[1].visible, '用户问题与正文0 恒显示');
  assert.ok(d[2].visible && d[3].visible && d[4].visible, '正文0 的过程保留概要（隶属其前正文）');
  assert.ok(d[5].visible, '正文一恒显示');
});

test('plan 形态：▶ 行与阶段正文各自成段，过程隶属其前锚点', () => {
  const messages = [
    item('step', 'Step1 分析结构'),
    item('tool', 'GLOB *', { kind: 'call' }),
    item('tool', 'files', { kind: 'result', ok: true }),
    item('assistant', '步骤1完成'),
    item('step', 'Step2 核对配置'),
    item('tool', 'READ pom.xml', { kind: 'call' }),
    item('tool', 'xml', { kind: 'result', ok: true }),
    item('assistant', '步骤2完成'),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: false });
  assert.ok(d[0].visible, '▶Step1 恒显示');
  assert.ok(d[1].visible && d[2].visible, 'Step1 过程保留概要');
  assert.ok(d[3].visible, '步骤1正文恒显示');
  assert.ok(d[4].visible, '▶Step2 恒显示');
  assert.ok(d[5].visible && d[6].visible, 'Step2 过程保留概要');
  assert.ok(d[7].visible, '步骤2正文恒显示');
  const deep = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(deep[5].full && deep[6].full, 'Ctrl+O 展开最近阶段（Step2）过程全文');
  assert.ok(!deep[1].full && !deep[2].full, 'Step1 过程保持摘要');
});

test('连续正文切块并入同段：流式多块不裂段', () => {
  const messages = [
    item('user', '写报告'),
    item('assistant', '报告标题'),
    item('assistant', '第一节'),
    item('assistant', '第二节'),
    item('thinking', 'Thought for 3s', { detail: '想' }),
    item('tool', 'READ x', { kind: 'call' }),
    item('tool', 'ok', { kind: 'result', ok: true }),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: false });
  assert.ok(d[1].visible && d[2].visible && d[3].visible, '连续切块同段恒显示');
  assert.ok(d[4].visible && d[5].visible && d[6].visible, '最后段全显');
});

test('单段简单任务：全程全显，Ctrl+O 全文', () => {
  const messages = [
    item('user', '读文件'),
    item('tool', 'READ a.txt', { kind: 'call' }),
    item('tool', 'ok', { kind: 'result', ok: true, detail: '全文' }),
    item('assistant', '读完了'),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(d.every((s) => s.visible), '单段全显');
  assert.ok(d[1].full && d[2].full, 'Ctrl+O 全文');
});

test('spawn 调用行（子代理转录归档 detail）：随所在段 latestFull 放行全文（规格 §6 展开验收）', () => {
  const messages = [
    item('user', '跑审查子代理'),
    item('tool', 'SPAWN reviewer', { kind: 'call', detail: '子代理转录首行\n子代理转录尾行' }),
    item('tool', '子任务报告', { kind: 'result', ok: true }),
    item('assistant', '主任务完成'),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: false });
  assert.ok(d[1].visible, '默认态 SPAWN 调用行可见（摘要形态）');
  assert.ok(!d[1].full, '默认态内容保持摘要');
  const deep = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(deep[1].visible && deep[1].full, 'Ctrl+O 放行 SPAWN 调用行全文（决策层无障碍，渲染层 ToolRow 须消费）');
});

test('收口 notice 行（system 说明）不新开段：尾追说明不吃掉刚发生思考的全文作用域（规格 §10 尾追纪律）', () => {
  const messages = [
    item('user', '任务'),
    item('thinking', 'Thought for 1s', { detail: '先想再想' }),
    item('assistant', '答复'),
    item('system', '! [skills] learned: 任务'), // 收口后尾追的沉淀说明行
  ];
  const deep = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(deep[3].visible, '说明行恒显（user/system 不参与折叠）');
  assert.ok(!deep[3].full, '说明行不是可展开的过程行');
  assert.ok(deep[2].visible, '正文恒显');
  assert.ok(deep[1].full, 'Ctrl+O：尾追说明行后，刚发生的思考仍在「最近两段」作用域内、全文展开');
  const tab = buildTranscriptDecisions(messages, { expandAll: true, latestFull: false });
  assert.ok(!tab[1].full, 'Tab（第一层）不改变内容深度，说明行同样不越权展开');
});

test('回归：▶ 阶段行开段——每阶段各留一组概要，Ctrl+O 只展开最近正文锚点组（用户本机实测形态）', () => {
  // 最小复现：任务内多个 phase（▶）阶段、每阶段后有多组思考/工具，末尾一条正文。
  // 实测症状：① 默认态 ▶ 行之间空着（除首段外概要不显示）② Ctrl+O 把整场过程全展开。
  const messages = [
    item('user', '1'),
    item('thinking', 'Thought for 12s', { detail: '想一' }),
    item('tool', 'GLOB *', { kind: 'call' }),
    item('tool', '.gitattributes', { kind: 'result', ok: true }),
    item('thinking', 'Thought for 9s', { detail: '想二' }),
    item('tool', 'GLOB *.md', { kind: 'call' }),
    item('tool', 'README.md', { kind: 'result', ok: true }),
    item('step', 'Reading README and pom.xml'),
    item('thinking', 'Thought for 11s', { detail: '想三' }),
    item('tool', 'READ README.md', { kind: 'call' }),
    item('tool', 'md', { kind: 'result', ok: true }),
    item('thinking', 'Thought for 7s', { detail: '想四' }),
    item('tool', 'READ pom.xml', { kind: 'call' }),
    item('tool', 'xml', { kind: 'result', ok: true }),
    item('step', 'Scanning the source tree'),
    item('thinking', 'Thought for 21s', { detail: '想五' }),
    item('tool', 'GLOB src/main/java/**/*.java', { kind: 'call' }),
    item('tool', 'java', { kind: 'result', ok: true }),
    item('assistant', 'Project Overview ...'),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: false });
  assert.ok(d[7].visible && d[14].visible, '▶ 阶段行恒显示');
  assert.ok(d[1].visible && d[2].visible && d[3].visible, '首段保留自己一组概要');
  assert.ok(!d[4].visible && !d[5].visible && !d[6].visible, '首段其余组折叠');
  assert.ok(d[8].visible && d[9].visible && d[10].visible, '阶段二保留自己一组概要（▶ 阶段不被跳过）');
  assert.ok(d[15].visible && d[16].visible && d[17].visible, '阶段三保留自己一组概要');
  assert.ok(d[18].visible, '末尾正文恒显示');

  const deep = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(deep[15].full && deep[16].full && deep[17].full, 'Ctrl+O 展开最近正文锚点组（阶段三）全文');
  assert.ok(!deep[1].full && !deep[8].full, '更早阶段保持摘要，不随 Ctrl+O 一并展开');
});

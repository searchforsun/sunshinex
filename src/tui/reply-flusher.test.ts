import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPLY_SEGMENT_MAX_LINES, stableReplySegment } from './reply-flusher';

test('reply-flusher：段落边界切块，seg 含边界空行的换行且为严格中缀', () => {
  const text = '第一段。\n\n第二段。';
  assert.equal(stableReplySegment(text, 0), '第一段。\n\n');
  assert.equal(stableReplySegment(text, 5), '\n', '残留空行单独放行（只推进不入档）');
  assert.equal(stableReplySegment(text, 6), null, '只剩未完结行：无安全点');
});

test('reply-flusher：闭合围栏整体放行，seg 含边界换行', () => {
  const text = '```json\n{"a": 1}\n```\n\n后续。';
  assert.equal(stableReplySegment(text, 0), '```json\n{"a": 1}\n```\n\n', '闭合 + 空行边界：围栏整块放行');
  const tail = text.indexOf('后续。');
  assert.equal(stableReplySegment(text, tail), null, '只剩未完结尾段：不入档');
});

test('reply-flusher：围栏内空行不产生切点（代码块完整性）', () => {
  const text = '```js\n行1\n\n行2\n```\n\n后文。';
  assert.equal(stableReplySegment(text, 0), '```js\n行1\n\n行2\n```\n\n', '围栏内空行不得切块');
  const mid = text.indexOf('行1');
  assert.equal(
    stableReplySegment(text, mid),
    '行1\n\n行2\n```\n\n',
    '从围栏内容起扫（防御路径）：补全至闭合围栏 + 段落边界，拼接仍无损',
  );
});

test('reply-flusher：围栏开启未闭合时零切点', () => {
  const text = '前言。\n\n```json\n{"a": 1}\n';
  assert.equal(stableReplySegment(text, 0), '前言。\n\n', '围栏前的段落正常放行');
  const after = text.indexOf('```json');
  assert.equal(stableReplySegment(text, after), null, '围栏内（未闭合）不可切');
});

test('reply-flusher：长围栏未闭合也按行数兜底切块（生成期滚动出稿）', () => {
  const text = '```js\n' + Array.from({ length: 60 }, (_, i) => `行${i}`).join('\n') + '\n';
  const seg = stableReplySegment(text, 0);
  assert.ok(seg !== null, '长围栏（超过 24 行）应产生切点，不等闭合');
  assert.equal(seg.split('\n').length - 1, REPLY_SEGMENT_MAX_LINES + 1, '首块 = 开栏行 + 上限行数内容');
  assert.ok(seg.startsWith('```js\n'), '切块自带开栏行：入档块独立成立');
  const seg2 = stableReplySegment(text, seg.length);
  assert.ok(seg2 !== null, '续块继续按行数兜底');
  assert.equal(seg2.split('\n').length - 1, REPLY_SEGMENT_MAX_LINES, '续块同样恰为上限行数');
});

test('reply-flusher：短围栏未闭合仍零切点（整块入档保结构）', () => {
  const text = '```json\n{"a": 1}\n';
  assert.equal(stableReplySegment(text, 0), null, '未超过行数上限的围栏：闭合前不切');
});

test('reply-flusher：逐行切点（完整流式裁决）——预建串一次交清所有完结行、实况节奏逐行放行', () => {
  const longPara = Array.from({ length: 30 }, (_, i) => `行${i}`).join('\n');
  const seg = stableReplySegment(longPara, 0);
  assert.ok(seg !== null, '完结行即切点');
  // cut 取最靠后完结行（滑动式）：30 行预建串（末行无换行）→ 前 29 行一次交清；
  // 实况流式下 flushReply 逐 token 调用，每完成一行即切一行——块长 = 1 行
  assert.equal(seg.split('\n').length - 1, 29, '预建串：所有完结行一次放行（末行未完不留）');
  // 实况节奏锚定：逐行流式——每块恰 1 行
  const one = stableReplySegment('行0\n', 0);
  assert.equal(one, '行0\n', '单完结行即切');
  const two = stableReplySegment('行0\n行1\n', 0);
  assert.equal(two, '行0\n行1\n', '两完结行切至最靠后（合帧积压时尽量多交账）');
});

test('reply-flusher：表格候选行守候——表头完成的瞬间分隔行未到不切（逐行切点的流式补丁，真机「表格没了」）', () => {
  const header = '| 层面 | 选型 |';
  // 表头行刚完结（尾换行、余量只剩空 remainder）：下一行未知，守候不切——先切即表头与分隔行分家
  assert.equal(stableReplySegment(header + '\n', 0), null, '表头行守候（分隔行未到）');
  // 分隔行到达：表格开启，仍零切点（等闭合）
  assert.equal(stableReplySegment(header + '\n| --- | --- |\n', 0), null, '表头+分隔行开启后整块保护');
  // 数据行流式到达（带换行）：表格期间零切点
  assert.equal(stableReplySegment(header + '\n| --- | --- |\n| 后端 | Spring Boot |\n', 0), null, '数据行到达仍保护');
  // 闭合（空行 + 后续正文）：整表随切点放行
  const closed = header + '\n| --- | --- |\n| 后端 | Spring Boot |\n\n后续。';
  assert.equal(stableReplySegment(closed, 0), header + '\n| --- | --- |\n| 后端 | Spring Boot |\n\n', '闭合即整表+空行放行');
  // 杂散管道行（下一行是真实非分隔行）：不定型为表格 → 照常切；滑动语义下一次交清所有完结行
  // （实况流式：表头守候到下一行到达即先行入档，正文行随后续 token 自成一块）
  const stray = header + '\n普通正文。\n';
  assert.equal(stableReplySegment(stray, 0), header + '\n普通正文。\n', '下一行非分隔行 → 照常逐行切（滑动交清）');
  // 管道行后跟空行再跟正文：守候行与空行并块放行（非表格形态）
  assert.equal(stableReplySegment(header + '\n\n正文。', 0), header + '\n\n', '管道行+空行并块');
});

test('reply-flusher：结构行守候（缩进块/表格行）——列表行经 start 承接可安全逐行（2026-09-30 终版）', () => {
  // 有序列表行不守候：单独成块经 List start 承接真实编号（「2. …」渲染 2. 非重排 1.），照常逐行
  assert.equal(stableReplySegment('1. 版本漂移\n', 0), '1. 版本漂移\n', '列表行逐行照切（start 承接编号）');
  // 缩进块行（4+ 空格，ASCII 对齐图）：下一行未知时守候——单独入档即缩进解释翻转、对齐散架
  assert.equal(stableReplySegment('    ┌──┐\n', 0), null, '缩进块行守候');
  // 缩进块到空行边界整块放行
  const art = '    ┌──┐\n    │框│\n\n后文。';
  assert.equal(stableReplySegment(art, 0), '    ┌──┐\n    │框│\n\n', '缩进块空行边界整块放行');
  // 表格行守候（承接 096da5c：表头与分隔行不得分家）
  assert.equal(stableReplySegment('| 层面 | 选型 |\n', 0), null, '表格行守候');
  // 散文行逐行照切（打字机节奏）
  assert.equal(stableReplySegment('散文行\n', 0), '散文行\n', '散文行逐行照切');
});

test('reply-flusher：结构守候按完结位（含部分到达下一行）——表格/缩进块跨任意合帧流率不拆块（2026-09-30 真机「第一行和第二行之间多了空格」实锤：守候只认空 remainder，分隔行部分到达即表头被切、与分隔行分家降级裸文本）', () => {
  const text = ['三、结构', '', '| 包 | 职责 |', '|---|---|', '| ai/ | 服务 |', '', '四、后续'].join('\n');
  for (const step of [1, 3, 8, 20]) {
    let committed = 0;
    const chunks = [];
    let i = 1;
    while (i <= text.length) {
      const seg = stableReplySegment(text.slice(0, i), committed);
      if (seg !== null) { chunks.push(seg); committed += seg.length; }
      i += step;
    }
    if (committed < text.length) chunks.push(text.slice(committed));
    assert.equal(chunks.join(''), text, `step=${step} 拼接无损`);
    const headerChunk = chunks.find((c) => c.includes('| 包 |'));
    assert.ok(headerChunk!.includes('|---|---|') && headerChunk!.includes('| ai/ |'), `step=${step} 表头/分隔/首数据行同块（守候按完结位）`);
  }
  // 分隔行部分到达的守候形态直测：表头完结、下一行只有一个「|」字符
  assert.equal(stableReplySegment('| 包 | 职责 |\n|', 0), null, '下一行部分到达仍守候（合帧实况）');
});

test('reply-flusher：纯空白切段返回原串（session 侧只推进不入档）', () => {
  assert.equal(stableReplySegment('\n\n正文', 0), '\n\n');
});

test('reply-flusher：无换行或已追平返回 null', () => {
  assert.equal(stableReplySegment('单行生成中', 0), null);
  assert.equal(stableReplySegment('a\nb\n', 4), null);
  assert.equal(stableReplySegment('', 0), null);
});

test('reply-flusher：GFM 表格超兜底线也整表放行，不中途切割', () => {
  const header = '| 模块 | 问题 | 建议 |';
  const divider = '| --- | --- | --- |';
  const rows = Array.from({ length: 30 }, (_, i) => `| 服务${i} | 问题${i} | 建议${i} |`);
  const table = [header, divider, ...rows].join('\n');
  const text = `前言。\n\n${table}\n\n后续。`;
  assert.equal(
    stableReplySegment(text, 0),
    `前言。\n\n${table}\n\n`,
    '32 行表格远超 24 行兜底：整表 + 空行一起放行',
  );
});

test('reply-flusher：分帧流式——表头块不被伪行闭合过早切出（回归：表头框线块+散行表体）', () => {
  const header = '| 桌面 | 技术选型 |';
  const divider = '| --- | --- |';
  // 帧 1：表头+分隔行刚写完（尾换行已到），数据行未到——尾部空 remainder 不得触发闭合
  const frame1 = `前言。\n\n${header}\n${divider}\n`;
  assert.equal(stableReplySegment(frame1, 0), '前言。\n\n', '表头块必须在数据行到达前滞留 pending');
  // 帧 1b：数据行刚写完（尾换行已到）但表格是否结束未知——仍不得切
  assert.equal(stableReplySegment(frame1 + '| 语言 | Java 21 |\n', 5), null, '表格未确认闭合不切');
  // 帧 2：数据行到齐 + 真实空行 + 后续正文——整表随空行边界放行
  const frame2 = frame1 + '| 语言 | Java 21 |\n| 框架 | Spring Boot 3 |\n\n正文继续。';
  assert.equal(
    stableReplySegment(frame2, 5),
    `${header}\n${divider}\n| 语言 | Java 21 |\n| 框架 | Spring Boot 3 |\n\n`,
    '数据行到齐后整表+空行边界一次成型',
  );
});

test('reply-flusher：表格流式未完（尾行为表格行且无换行）不切，等待整表', () => {
  const partial = ['| A | B |', '| --- | --- |', '| 行1 | 值 |', '| 行2 | 值'].join('\n');
  const text = `前言。\n\n${partial}`;
  const committed = '前言。\n\n'.length;
  assert.equal(stableReplySegment(text, committed), null, '表格未闭合不切');
});

test('reply-flusher：表格闭合于内容行即整表放行（不等后续段落边界）', () => {
  const header = '| 模块 | 问题 |';
  const divider = '| --- | --- |';
  const rows = ['| 服务A | 超卖风险 |', '| 服务B | 幂等缺失 |'];
  const table = [header, divider, ...rows].join('\n');
  // 表格后无空行直接跟正文（模型省略空行的常见输出）
  const text = `前言。\n\n${table}\n正文紧跟表格。`;
  const seg = stableReplySegment(text, 0);
  assert.ok(seg !== null, '表格闭合于内容行应立即产生切点');
  assert.ok(seg!.includes('| 服务B | 幂等缺失 |'), '切点应覆盖整张表');
  assert.ok(!seg!.includes('正文紧跟'), '表格后的正文不入本段');
});

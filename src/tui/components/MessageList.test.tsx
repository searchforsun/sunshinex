import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { MessageList, replyPreviewWindow } from './MessageList';
import { ChatItem, LiveBlock } from '../session';
import { BannerInfo } from '../banner-info';

const banner: BannerInfo = { version: '1.0', model: 'm', root: 'r' } as BannerInfo;
const mk = (over: Partial<ChatItem>): ChatItem => ({ role: 'assistant', text: '', ts: 1, seq: 1, ...over });

test('MessageList：ansi 条目直嵌 Text（框线表格呈现），普通条目照旧', () => {
  const one = render(
    <MessageList
      banner={banner}
      messages={[mk({ seq: 1, text: '│ a │ b │\n├───┼───┤', ansi: true })]}
      columns={80}
      expandAll={false}
      latestFull={false}
    />,
  );
  assert.ok(one.allOutput().includes('│ a │ b │'), 'ANSI 表格行原样上屏');
  one.unmount();
});

test('MessageList：ansi 条目防双重渲染——星号字面原样直嵌（markdansi 不转义星号，不得再过 MarkdownText 加粗）', () => {
  const one = render(
    <MessageList
      banner={banner}
      messages={[mk({ seq: 2, text: '**bold** 字面与结论行', ansi: true })]}
      columns={80}
      expandAll={false}
      latestFull={false}
    />,
  );
  assert.ok(one.allOutput().includes('**bold**'), '星号字面保留（经 MarkdownText 二次渲染会被吃成粗体字形）');
  one.unmount();
});

test('MessageList：ansi 条目间区域间距统一单空行——尾部 \\n 即块间 margin，marginBottom 折 0（不再双空行）', () => {
  const one = render(
    <MessageList
      banner={banner}
      messages={[
        mk({ seq: 1, text: '片段甲首行\n片段甲次行\n', ansi: true }),
        mk({ seq: 2, text: '片段乙首行\n', ansi: true }),
      ]}
      columns={80}
      expandAll={false}
      latestFull={false}
    />,
  );
  const lines = one.allOutput().replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').replace(/\n+$/, '').split('\n');
  const i = lines.findIndex((l) => l.includes('片段甲次行'));
  let gap = 0;
  for (let j = i + 1; j < lines.length && lines[j]!.trim() === ''; j++) gap++;
  assert.equal(gap, 1, `ansi→ansi 边界空行数应恒 1（实际 ${gap}——margin 叠加时代为 2）`);
  one.unmount();
});

test('MessageList：live reply 期间 MdBufferPreview 按水位切片显示未消费结构（表格已开表头可见，已入档内容不重演）', () => {
  // 源里表格已入档（渲染态在 Static），水位指向后续未消费结构起点——预览只显示水位之后的内容
  const text = '前言。\n\n| a | b |\n|---|\n| 1 |\n\n四、后续\n\n| x | y |\n|---|\n| 2';
  const live: LiveBlock = { kind: 'reply', text, startedAt: 0, tailStart: text.indexOf('| x | y |') } as LiveBlock;
  const one = render(
    <MessageList banner={banner} messages={[]} live={live} columns={80} expandAll={false} latestFull={false} />,
  );
  assert.match(one.lastFrame() ?? '', /\| x \| y \|/, '水位后的未消费结构在预览');
  assert.ok(!((one.lastFrame() ?? '').includes('| a | b |')), '已入档的前一张表不以裸文本重演（同屏重复病根）');
  one.unmount();
});

test('MessageList：tailStart 缺省（无未消费结构）预览只显示当前未完行', () => {
  const live: LiveBlock = { kind: 'reply', text: '前言。\n\n已完结段落\n未完行', startedAt: 0 } as LiveBlock;
  const one = render(
    <MessageList banner={banner} messages={[]} live={live} columns={80} expandAll={false} latestFull={false} />,
  );
  assert.match(one.lastFrame() ?? '', /未完行/, '未完行在预览');
  assert.ok(!((one.lastFrame() ?? '').includes('已完结段落')), '已入档段落不重演');
  one.unmount();
});

test('MessageList：MdBufferPreview 全文尾窗——100 行未闭合围栏仅按视口物理上限截尾、无标记行（防 ink3 clearTerminal + 流式非局部）', () => {
  const body = '```ts\n' + Array.from({ length: 100 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const live: LiveBlock = {
    kind: 'reply',
    text: body,
    startedAt: 0,
    tailStart: 0, // 围栏开栏即结构起点（session mdConsume 镜像）
  } as LiveBlock;
  const rows = 24;
  const cap = Math.min(28, Math.max(8, rows - 6)); // MdBufferPreview 缺省回落公式
  const one = render(
    <MessageList banner={banner} messages={[]} live={live} columns={80} rows={rows} expandAll={false} latestFull={false} />,
  );
  const frame = one.lastFrame() ?? '';
  // 物理行口径：只剥 log-update 的单个尾随换行
  const height = frame.replace(/\n$/, '').split('\n').length;
  assert.equal(height, cap + 1, `帧高 = cap ${cap} + margin 1（实际 ${height}）——超视口尾段截到物理上限，其余全文`);
  assert.ok(frame.includes('const v99 = 99;'), '最新行（尾行）可见');
  assert.ok(!frame.includes('const v0 = 0;'), '超限头行被截去（物理必需，非策略小窗）');
  assert.ok(!frame.includes('…'), '无截断标记行（标记行随截断出现即 +1 行跳动）');
  one.unmount();
});

test('MessageList：MdBufferPreview 全文尾窗——cap 内尾段全文流式（不截头成局部片段）、空尾段不占位（输入区紧跟内容）', () => {
  // 14 行围栏（真机代码框量级）：cap(18@24行) 内必须全文呈现，不得截成局部片段
  const fence = '```text\n' + Array.from({ length: 14 }, (_, i) => `图示第${i + 1}行`).join('\n');
  const liveFence: LiveBlock = { kind: 'reply', text: fence, startedAt: 0, tailStart: 0 } as LiveBlock;
  const full = render(
    <MessageList banner={banner} messages={[]} live={liveFence} columns={80} rows={24} expandAll={false} latestFull={false} />,
  );
  const fullFrame = full.lastFrame() ?? '';
  assert.match(fullFrame, /图示第1行/, '围栏首行在屏（cap 内全文流式，不截头）');
  assert.match(fullFrame, /图示第14行/, '围栏末行在屏');
  const fullHeight = fullFrame.replace(/\n$/, '').split('\n').length;
  assert.equal(fullHeight, 14 + 2 + 1, '帧高 = 围栏实高（14 行+代码盒上下边框 2）+ margin（随内容生长）');
  full.unmount();
  // 空尾段（块闭合到下一 delta 之间）：窗口不占位
  const liveEmpty: LiveBlock = { kind: 'reply', text: '已入档。\n\n', startedAt: 0 } as LiveBlock;
  assert.deepEqual(replyPreviewWindow(liveEmpty, 80, 18), [], '空尾段返回空=窗口不占位');
  // 短尾段：全文单行
  const liveShort: LiveBlock = { kind: 'reply', text: '已入档。\n\n段中一行', startedAt: 0 } as LiveBlock;
  assert.deepEqual(replyPreviewWindow(liveShort, 80, 18).join('\n'), '段中一行', 'cap 内尾段全文不截');
});

test('replyPreviewWindow：水位坐标失配防御——tailStart 越界回落全文起点（2026-10-02「流式正文隐形」钉：交错/重放边界下 tailStart 是 mdSource 坐标而 live.text 重起算，越界切片恒空=预览黑窗、正文隐形流式直到块边界一次性倾泻）', () => {
  const live: LiveBlock = { kind: 'reply', text: '交错后的新正文正在流式长出', startedAt: 0, tailStart: 999 } as LiveBlock;
  assert.match(
    replyPreviewWindow(live, 80, 18).join('\n'),
    /新正文/,
    '坐标失配时从 0 起显（live.text 整体即未消费尾段），不得恒空黑窗',
  );
  // 在界水位照旧精确切片（防回归：越界分支不得吞掉正常水位路径）
  const ok: LiveBlock = { kind: 'reply', text: '已入档段\n\n未入档尾段行', startedAt: 0, tailStart: '已入档段\n\n'.length } as LiveBlock;
  assert.equal(replyPreviewWindow(ok, 80, 18).join('\n'), '未入档尾段行', '在界水位精确切片照旧');
});

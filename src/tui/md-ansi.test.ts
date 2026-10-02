// src/tui/md-ansi.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMd, wrapAnsiLines, ansiLineCount, normalizeCjkLine, isFenceLine, softWrapAnsi } from './md-ansi';

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');

test('renderMd：表格成框线、ANSI 输出、宽度受控', () => {
  const out = renderMd('| a | b |\n|---|---|\n| 1 | 2 |', 60);
  assert.ok(out.includes('│'), '表格框线成形');
  assert.ok(strip(out).split('\n').every((l) => l.length <= 60), '行宽 ≤ width');
});

test('renderMd：全角分隔行归一后成表（|───|───|）', () => {
  const out = renderMd('| 包 | 职责 |\n|───|───|\n| x | y |', 60);
  assert.ok(out.includes('│'), '全角分隔行归一生效');
});

test('wrapAnsiLines：20 万列无空格行折行不爆栈、ANSI 码不切坏', () => {
  const huge = '\x1b[31m' + 'a'.repeat(200_000) + '\x1b[0m';
  const out = wrapAnsiLines(huge, 60);
  const lines = out.split('\n');
  assert.ok(lines.length > 3000, '已按宽折行');
  assert.ok(lines.every((l) => strip(l).length <= 60), '剥码后行宽恒 ≤ 60');
  assert.ok(!/\u001b$/.test(out), '行尾不留半截转义码');
});

test('ansiLineCount：剥码行数', () => {
  assert.equal(ansiLineCount('\x1b[31m甲\x1b[0m\n乙\n'), 2);
});

test('normalizeCjkLine：全角管道/破折号/冒号归一；围栏内原样', () => {
  assert.equal(normalizeCjkLine('｜ a ｜───｜', false), '| a |---|');
  assert.equal(normalizeCjkLine('|：x：|', false), '|:x:|');
  assert.equal(normalizeCjkLine('｜ 不动 ｜', true), '｜ 不动 ｜');
});

test('normalizeCjkLine/renderMd：全角空格/零宽空白行归一为空行——renderMd 段落不合并（F2 回归）', () => {
  // 旧 preprocess 规则承接（markdown.ts 2026-09-28 真机「结论与表格间大段空白」病根）：
  // CommonMark 空白行判定只认 ASCII 空白，仅含 U+3000/U+200B..D/U+FEFF 的行被当正文 → 段落合并
  assert.equal(normalizeCjkLine('\u3000\u3000', false), '', '纯全角空格行 → 空行');
  assert.equal(normalizeCjkLine(' \t\u200B\u200C\u200D\uFEFF ', false), '', '混零宽字符空白行 → 空行');
  assert.equal(normalizeCjkLine('\u3000\u200B', true), '\u3000\u200B', '围栏内代码内容原样（不归一）');
  assert.equal(normalizeCjkLine('', false), '', '空行不动（+ 量词不匹配空串）');
  const out = strip(renderMd('第一段\n\u3000\u3000\n第二段', 60));
  assert.ok(out.includes('第一段') && out.includes('第二段'), '两段内容均在');
  assert.ok(!out.split('\n').some((l) => l.includes('第一段') && l.includes('第二段')), '两段不合并到同一行');
  const a = out.indexOf('第一段');
  const b = out.indexOf('第二段');
  assert.ok(a >= 0 && b > a && out.slice(a, b).includes('\n'), '两段间有换行分隔（空行归一生效）');
});

test('normalizeCjkLine：行域语义——空白行归一保尾换行（N1 回归：\\s 吞尾换行致空行 push no-op、表格 flushTable 失效）', () => {
  // 流式路径（session.mdConsume）逐行带尾 \n 喂入：\s 含 \n，整行测正则会连尾换行吞成 ''
  // → 空行不达 streamer（markdansi push('') no-op）→ 表格 flushTable 失效、段落粘连
  assert.equal(normalizeCjkLine('\n', false), '\n', '纯换行行原样（不得吞成空串）');
  assert.equal(normalizeCjkLine('\u3000\n', false), '\n', '全角空白行 → 空行 + 保尾换行');
  assert.equal(normalizeCjkLine(' \t\u200B\uFEFF\n', false), '\n', '混零宽空白行 → 空行 + 保尾换行');
  assert.equal(normalizeCjkLine('正文\n', false), '正文\n', '正文行不动（含尾换行）');
  assert.equal(normalizeCjkLine('｜ a ｜\n', false), '| a |\n', '管道归一保尾换行');
  assert.equal(normalizeCjkLine('\u3000\n', true), '\u3000\n', '围栏内代码内容原样（含尾换行）');
  // 无尾换行的源级调用（normalizeMd split 产物）保持 F2 语义
  assert.equal(normalizeCjkLine('\u3000\u3000', false), '');
});

test('isFenceLine：以 ```/~~~ 开头即围栏行（开/闭奇偶由调用侧跟踪）', () => {
  assert.ok(isFenceLine('```ts'));
  assert.ok(isFenceLine('``` 后内容'));
  assert.ok(isFenceLine('~~~'));
  assert.ok(!isFenceLine('普通行'));
});

test('renderMd：表格 tableTruncate 关闭（单元格换行不截断）+ 宽度受控（2026-09-30 真机「表格被截断且只占半屏」）', () => {
  const table = '| 分发点 | 位置 |\n|---|---|\n| AI 服务工厂 | core/AiCodeGeneratorServiceFactory.java:101, core/AiCodeGeneratorFacade.java:55 |';
  const out = renderMd(table, 100);
  assert.ok(!out.includes('…'), '长单元格换行呈现、无省略号截断');
  assert.ok(out.includes('AiCodeGeneratorFacade.java:55'), '截断丢掉的尾部内容在');
  const narrow = renderMd('| aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | b |\n|---|---|\n| 1 | 2 |', 40);
  assert.ok(narrow.includes('│'), '表格渲染成功');
  assert.ok(narrow.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').split('\n').every((l) => l.length <= 40), '宽度受控（超宽单元格换行入格）');
});

/* ---------- 正文行距律·分区版（2026-10-01 用户裁决「不同区域不同行距，整体协调」+ 同日终裁
 *  「有序列表还是有多余的行距」：有序与无序同档，列表项一律紧排成组） ---------- */

test('BODY_LINE_SPACING 分区：列表项（无序+有序+任务清单）紧排成组、段落间单空行、组间边界单空行', () => {
  const src = '- 甲项\n- 乙项\n\n段落一行\n\n段落二行\n\n1. 步骤一\n2. 步骤二\n\n- [ ] 任务甲\n- [ ] 任务乙';
  const out = strip(renderMd(src, 80));
  assert.ok(out.includes('• 甲项\n• 乙项'), '无序项间紧排（同类枚举聚拢成组）');
  assert.ok(out.includes('1. 步骤一\n2. 步骤二'), '有序项间紧排（与无序同档）');
  assert.ok(out.includes('[ ] 任务甲\n[ ] 任务乙'), '任务清单项间紧排（勾选框行不散排）');
  assert.ok(out.includes('乙项\n\n段落一行'), '组→段落边界单空行');
  assert.ok(out.includes('段落一行\n\n段落二行'), '段落间单空行');
  assert.ok(out.includes('段落二行\n\n1. 步骤一'), '段落→列表组边界单空行');
  assert.ok(out.includes('步骤二\n\n[ ] 任务甲'), '有序组→任务组边界单空行');
  assert.ok(!out.includes('\n\n\n'), '行距档位不叠加（无 3+ 连续换行）');
});

test('softWrapAnsi：ANSI 原子不切坏、拉丁词不断、续行悬挂缩进', () => {
  const line = '\x1b[36m▸\x1b[0m 这是一个超长的中英文混排段落 english words 不应在词中间断开继续补充直到触发折行边界观察续行形态';
  const lines = softWrapAnsi(line, 30, 2);
  assert.ok(lines.length > 1, '已折行');
  assert.ok(lines.slice(1).every((l) => l.startsWith('  ')), '续行悬挂缩进 2 格');
  const flat = lines.join('');
  assert.ok(flat.includes('\x1b[36m▸\x1b[0m'), 'SGR 原子保留');
  assert.ok(lines.every((l) => !/\x1b$/.test(l)), '行尾不留半截转义码');
  assert.ok(lines.every((l) => strip(l).length <= 30), '剥码后行宽恒 ≤ width');
});

test('renderMd：围栏豁免行距——代码盒内容无空行插入、盒线完好', () => {
  const out = strip(renderMd('前言一句。\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n尾段。', 80));
  assert.ok(!out.includes('const a = 1;\n\nconst b = 2;'), '代码行间无行距插入');
  assert.ok(out.includes('┌') && out.includes('└'), '代码盒框线完好');
});

test('renderMd：分割线全宽盒线（markdansi HR_WIDTH=40 上限绕行，dim 呈现）', () => {
  const out = renderMd('上文\n\n---\n\n下文', 120);
  assert.ok(strip(out).split('\n').includes('─'.repeat(120)), '分割线为全宽盒线字符');
  assert.ok(!out.includes('—'), '不使用 markdansi 的 40 列 em-dash 线');
  assert.ok(out.includes('\x1b[2m'), 'dim 弱化呈现');
  assert.ok(strip(out).split('\n').every((l) => l.length <= 120), '行宽 ≤ width');
});

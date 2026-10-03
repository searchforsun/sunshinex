/** R10 短期收敛特征化钉（D29 并轨后单链化改写，2026-10-04）：md-theme.ts 与旧硬编码值逐一相等——
 *  收缩零漂移门禁。旧值取自普查 R10 证据快照：md-ansi.ts HI_SGR（SGR 码）、MarkdownText.tsx HI_COLOR
 *  （ink 色名——该形态已随回看链退役摘除，其「同色」约束以 sgr↔ink 对照表形式保留钉）、
 *  hr 字符 '─'、MessageList MdBufferPreview 预览公式 min(28, max(8, rows-6)) 上下限。
 *  任何一侧与旧值漂移即红 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HI_TOKEN_SGR, hiSgr, MD_HR_CHAR, REPLY_PREVIEW_MAX_ROWS, REPLY_PREVIEW_MIN_ROWS } from './md-theme';
import { HiKind } from './highlight';

const KINDS: readonly HiKind[] = ['keyword', 'string', 'comment', 'number', 'plain'];

test('单形态表 sgr = md-ansi 旧硬编码 HI_SGR 逐值相等（主链 ANSI 渲染零漂移）', () => {
  const old: Record<HiKind, string> = { keyword: '\x1b[35m', string: '\x1b[32m', comment: '\x1b[90m', number: '\x1b[33m', plain: '' };
  for (const k of KINDS) assert.equal(hiSgr(k), old[k], `${k} SGR 码与旧值漂移`);
  for (const k of KINDS) assert.equal(HI_TOKEN_SGR[k], old[k], `${k} 表内值与旧值漂移`);
});

test('退役 inkName 形态同色对照：现表 sgr 码经 R10 同色映射仍指向旧 ink 色名（色系不随收缩漂移）', () => {
  const sgrToInk: Record<string, string> = { '\x1b[35m': 'magenta', '\x1b[32m': 'green', '\x1b[90m': 'gray', '\x1b[33m': 'yellow', '': '' };
  const oldInk: Record<HiKind, string> = { keyword: 'magenta', string: 'green', comment: 'gray', number: 'yellow', plain: '' };
  for (const k of KINDS) assert.equal(sgrToInk[hiSgr(k)] ?? '__无映射__', oldInk[k], `${k} 色系与旧 ink 形态不同色`);
});

test('hr 字符与预览上下限 = 两侧旧硬编码值', () => {
  assert.equal(MD_HR_CHAR, '─');
  assert.equal(REPLY_PREVIEW_MAX_ROWS, 28);
  assert.equal(REPLY_PREVIEW_MIN_ROWS, 8);
});

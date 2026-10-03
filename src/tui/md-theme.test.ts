/** R10 短期收敛特征化钉：共享常量单点 md-theme.ts 与两侧旧硬编码值逐一相等——迁移零漂移门禁。
 *  旧值取自普查 R10 证据快照：md-ansi.ts HI_SGR（SGR 码）、MarkdownText.tsx HI_COLOR（ink 色名）、
 *  hr 字符 '─'、MessageList MdBufferPreview 预览公式 min(28, max(8, rows-6)) 上下限。
 *  任何一侧与旧值漂移即红——两链渲染输出必须逐字节不变 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HI_TOKEN_COLOR, hiSgr, hiInkName, MD_HR_CHAR, REPLY_PREVIEW_MAX_ROWS, REPLY_PREVIEW_MIN_ROWS } from './md-theme';
import { HiKind } from './highlight';

const KINDS: readonly HiKind[] = ['keyword', 'string', 'comment', 'number', 'plain'];

test('同源表 sgr 形态 = md-ansi 旧硬编码 HI_SGR 逐值相等（主链 ANSI 渲染零漂移）', () => {
  const old: Record<HiKind, string> = { keyword: '\x1b[35m', string: '\x1b[32m', comment: '\x1b[90m', number: '\x1b[33m', plain: '' };
  for (const k of KINDS) assert.equal(hiSgr(k), old[k], `${k} SGR 码与旧值漂移`);
  for (const k of KINDS) assert.equal(HI_TOKEN_COLOR[k].sgr, old[k], `${k} 表内 sgr 与旧值漂移`);
});

test('同源表 inkName 形态 = MarkdownText 旧硬编码 HI_COLOR 逐值相等（回看链 ink 渲染零漂移）', () => {
  const old: Record<HiKind, string> = { keyword: 'magenta', string: 'green', comment: 'gray', number: 'yellow', plain: '' };
  for (const k of KINDS) assert.equal(hiInkName(k), old[k], `${k} ink 色名与旧值漂移`);
  for (const k of KINDS) assert.equal(HI_TOKEN_COLOR[k].inkName, old[k], `${k} 表内 inkName 与旧值漂移`);
});

test('双形态同源自洽：同一 token 的 sgr 码与 inkName 指向同一终端色', () => {
  const sgrToInk: Record<string, string> = { '\x1b[35m': 'magenta', '\x1b[32m': 'green', '\x1b[90m': 'gray', '\x1b[33m': 'yellow', '': '' };
  for (const k of KINDS) assert.equal(hiInkName(k), sgrToInk[hiSgr(k)] ?? '__无映射__', `${k} 两形态不同色`);
});

test('hr 字符与预览上下限 = 两侧旧硬编码值', () => {
  assert.equal(MD_HR_CHAR, '─');
  assert.equal(REPLY_PREVIEW_MAX_ROWS, 28);
  assert.equal(REPLY_PREVIEW_MIN_ROWS, 8);
});

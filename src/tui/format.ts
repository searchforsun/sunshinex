import { t } from '../i18n';
import type { BreakdownPartId, ContextBreakdown } from '../harness/context/breakdown';
import { displayWidth } from './text-band';

/** token 数紧凑显示：≥1000 记 k（1200 → 1.2k；12345 → 12k），负值/非有限值按 0 收束 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}

/** 可读时长：秒 → 分段 h/m/s（<1m 只显秒 59s；跨分含分 10m 2s；跨时 1h 21m 30s），负值/非有限值按 0 收束 */
export function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '0s';
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** /context 分段标签（外观双语；id 与装配面一一对应，呈现序即 parts 序） */
function partLabel(id: BreakdownPartId): string {
  switch (id) {
    case 'stable': return t('system prompt (stable)', '系统提示词（稳定段）');
    case 'instructions': return t('instructions (SUNSHINE.md)', '指令（SUNSHINE.md 两层）');
    case 'skills': return t('skills index', '技能清单');
    case 'memory': return t('memory index', '记忆索引');
    case 'compacted': return t('compacted summary', '压缩摘要');
    case 'chain': return t('session chain', '会话链');
    case 'skill': return t('skill block (pending)', '技能块（待注入）');
  }
}

/** /context 分段行尾注（条目数说明；压缩段附折叠前缀行数——链短的原因可解释） */
function partNote(id: BreakdownPartId, count: number, chainFrom: number): string {
  switch (id) {
    case 'instructions': return count > 0 ? t(`${count} lines`, `${count} 行`) : '';
    case 'compacted': return count > 0 ? t(`${count} block(s), folding ${chainFrom} chain steps`, `${count} 块，已折叠链前缀 ${chainFrom} 行`) : '';
    case 'chain': return count > 0 ? t(`${count} steps`, `${count} 行`) : '';
    case 'skill': return '';
    default: return '';
  }
}

/** /context 构成报表（system 消息面纯文本直显，列对齐按显示宽度补位）：
 *  头行 total/window/free 汇总 + 分段行（标签左对齐、tokens 右对齐、占比=占窗口比，与状态栏 ctx 分母同口径）+
 *  链内动作细分行（tokens 降序）。token 为 CJK 近似估算，工具 schema 为请求级字段不计入。 */
export function formatContextBreakdown(b: ContextBreakdown): string {
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const pct = (n: number): string => (b.window > 0 ? ((n / b.window) * 100).toFixed(1) : '0.0');
  const padEnd = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - displayWidth(s)));
  const padStart = (s: string, w: number): string => ' '.repeat(Math.max(0, w - displayWidth(s))) + s;
  const header = t(
    `Context: ${fmt(b.total)} / ${fmt(b.window)} tokens (${pct(b.total)}% used, ${fmt(b.free)} free) — estimated, tools schema not included`,
    `上下文：${fmt(b.total)} / ${fmt(b.window)} tokens（已用 ${pct(b.total)}%，空闲 ${fmt(b.free)}）——估算口径，工具 schema 未计入`,
  );
  const tokW = Math.max(...b.parts.map((p) => displayWidth(fmt(p.tokens))));
  const labelW = Math.max(...b.parts.map((p) => displayWidth(partLabel(p.id))));
  const rows = b.parts.map((p) => {
    const note = partNote(p.id, p.count, b.chainFrom);
    return `  ${padEnd(partLabel(p.id), labelW)}  ${padStart(fmt(p.tokens), tokW)} tok  ${padStart(pct(p.tokens), 5)}%${note ? `  ${note}` : ''}`;
  });
  const detail =
    b.chainByAction.length > 1
      ? [`    ${b.chainByAction.map((a) => `${a.action} ×${a.steps} = ${fmt(a.tokens)}`).join('  ·  ')}`]
      : [];
  return [header, ...rows, ...detail].join('\n');
}

import { AlertCircle, Bot, Database, Info, MessageSquare, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ChatEntry } from '../../chat-reducer';
import { t } from '../../i18n';

export function systemIconOf(entry: ChatEntry): ReactNode {
  if (entry.kind === 'error') return <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />;
  if (entry.kind !== 'notice') return null;
  if (entry.md.startsWith('✻')) return <Bot size={14} strokeWidth={1.75} aria-hidden="true" />;
  if (/^\[[^\]]+ → [^\]]+\]/.test(entry.md)) return <MessageSquare size={14} strokeWidth={1.75} aria-hidden="true" />;
  return <Info size={14} strokeWidth={1.75} aria-hidden="true" />;
}

/** agent-message / inbox drain 通知：`[from → to] text`。气泡只展示来源名与正文。 */
export function agentMessageOf(entry: ChatEntry): { from: string; text: string } | null {
  if (entry.kind !== 'notice') return null;
  const m = /^\[([^\]]+) → ([^\]]+)\] ([\s\S]*)$/.exec(entry.md);
  if (m === null || m[1] === undefined) return null;
  return { from: m[1], text: m[3] ?? '' };
}

/** 模型切换说明行判定（2026-11-25 用户裁定「模型切换系统提示要和 fork 系统提示一样,和上侧保持
 *  距离」）:notice 正文由 session.ts 单点 t() 生成（中/英两语),此处按同一文案形态识别——
 *  命中即按 fork-origin 同档上边距渲染（与上侧内容拉开分节距离） */
export function isModelSwitchNotice(md: string): boolean {
  return /^(?:模型从 .+ 切换至 .+|Model switched from .+ to .+)$/.test(md);
}

/** G14.19 旁白分类(G14 批):[skills]/[memory] 打头的学习/记忆系统信息用专用图标(Sparkles/
 *  Database 微着色)+剥标签前缀——与一般系统提示(Info 灰)一眼区分;非此类回 null 走 systemIconOf。
 *  2026-10-31 用户裁定 i18n+可点:saved/updated/learned 动词本地化(添加记忆/更新记忆/添加技能/
 *  更新技能),tag/ref 随返(渲染面 data-* 落 DOM,Chat 容器点击委托开对应侧栏页签定位) */
export function noticeAccentOf(entry: ChatEntry): { icon: ReactNode; md: string; tag?: 'memory' | 'skills'; ref?: string } | null {
  if (entry.kind !== 'notice') return null;
  if (entry.md.startsWith('[skills]')) {
    const rest = entry.md.slice('[skills]'.length).trimStart();
    const m = /^(learned|updated):\s*(\S+)/.exec(rest);
    if (m !== null) {
      const zh = m[1] === 'learned' ? t('Skill added', '添加技能') : t('Skill updated', '更新技能');
      return { icon: <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />, md: `${zh}: ${m[2]}`, tag: 'skills', ref: m[2] };
    }
    return { icon: <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />, md: rest };
  }
  if (entry.md.startsWith('[memory]')) {
    const rest = entry.md.slice('[memory]'.length).trimStart();
    const m = /^(saved|updated):\s*(.+)$/.exec(rest);
    if (m !== null) {
      const zh = m[1] === 'saved' ? t('Memory saved', '添加记忆') : t('Memory updated', '更新记忆');
      const first = m[2].split(',')[0]?.trim() ?? '';
      return { icon: <Database size={14} strokeWidth={1.75} aria-hidden="true" />, md: `${zh}: ${m[2]}`, tag: 'memory', ref: first };
    }
    return { icon: <Database size={14} strokeWidth={1.75} aria-hidden="true" />, md: rest };
  }
  return null;
}


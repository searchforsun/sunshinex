import type { ChatEntry } from './chat-reducer';

/** 会话流日期分组(Codex 形:跨日插居中日期分隔;spec §3.2)。纯投影:无 ts 条目贴前组
 *  (首条无 ts 入无标组,label='' 渲染面跳过分隔行);now 注入便于测试。 */
export interface ChatDayGroup {
  key: string;
  label: string;
  entries: ChatEntry[];
}

export function groupEntriesByDay(entries: readonly ChatEntry[], now: Date = new Date()): ChatDayGroup[] {
  const sameYear = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
  const crossYear = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const groups: ChatDayGroup[] = [];
  for (const e of entries) {
    const day = typeof e.ts === 'number' && e.ts > 0 ? dayKeyOf(new Date(e.ts)) : undefined;
    const last = groups[groups.length - 1];
    if (day === undefined) {
      if (last !== undefined) last.entries.push(e);
      else groups.push({ key: 'none', label: '', entries: [e] });
      continue;
    }
    if (last !== undefined && last.key === day) {
      last.entries.push(e);
      continue;
    }
    const d = new Date(e.ts!);
    groups.push({ key: day, label: d.getFullYear() === now.getFullYear() ? sameYear.format(d) : crossYear.format(d), entries: [e] });
  }
  return groups;
}

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

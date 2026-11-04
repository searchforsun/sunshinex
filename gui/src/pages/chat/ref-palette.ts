/**
 * $ / # 软引用 palette 纯函数域（agents-teams P1 Task 4，spec 2026-11-04 §3.1/§3.2 GUI 面）——
 * 触发令牌解析（refTokenAt，词法与 mention.splitMentionTokens 的 $/# 支同款：词边界起手 +
 * 小写首字符）、目录前缀过滤（filterRefEntries）、双组扁平单游标（flatRefItems）、未知引用
 * 聚合（unknownRefTokens，R5：发送前只读对照「已缓存」entries，不拦截不改写）。零 DOM 依赖
 * （ref-palette.test.ts 直测）；面板渲染件在 mention.tsx（RefPalette，FilePalette 同居）、
 * 键盘链在 use-composer-keys.ts、装配与懒加载在 Chat.tsx。
 */

/** 目录条目（agentsView.view.entries / teamsView.view.entries 的 id+name 投影；shadowed 行
 *  在装配面剔除——同 id 两级行只留生效者） */
export interface RefEntry {
  id: string;
  name: string;
}

/** 两目录缓存（Chat useState 真值；首触懒拉前为空列——面板照开仅无项=不渲染） */
export interface RefEntries {
  agents: RefEntry[];
  teams: RefEntry[];
}

/** palette 触发态（use-composer-keys 键面与 Chat 渲染面共享形态） */
export interface RefPal {
  query: string;
  from: number;
  sym: '$' | '#';
}

/** 带符号的扁平行（键盘游标/onPick 载荷；sym 决定插入文本前缀） */
export interface RefItem extends RefEntry {
  sym: '$' | '#';
}

/** caret 前 $/# 触发令牌：命中返回 { query, from(符号下标), sym }；不命中 null。
 *  词法 = splitMentionTokens 的 $/# 支同款（(^|\s) 词边界起手 + [a-z] 小写首字符）——
 *  a$b / PATH=$PATH（词中）、#L30 / #Title（非小写首字符）天然不命中；空 query 合法
 *  （刚敲符号即开面板）；令牌须贴 caret（后缀窗口），caret 中段=已敲部分即 query。
 *  注：任务面给的正则 /([$#])([a-z][a-z0-9-]*)$/ 是词法核，词边界与空 query 两条件
 *  （测试规格 a$b 不触发 / 刚敲 $ 触发）由 (^|\s) 前导 + 可选 query 组补齐。 */
export function refTokenAt(text: string, caret: number): RefPal | null {
  const m = /(^|\s)([$#])([a-z][a-z0-9-]*)?$/.exec(text.slice(0, Math.max(0, caret)));
  if (m === null) return null;
  const from = (m.index ?? 0) + (m[1]?.length ?? 0);
  return { query: m[3] ?? '', from, sym: m[2] === '#' ? '#' : '$' };
}

/** id 前缀过滤（大小写不敏感——catalog id 词法允许大写而触发令牌恒小写，宽进窄出）；
 *  两组各自过滤保原序，空 query 全量保留 */
export function filterRefEntries(entries: RefEntries, query: string): RefEntries {
  const q = query.toLowerCase();
  const hit = (e: RefEntry): boolean => e.id.toLowerCase().startsWith(q);
  return { agents: entries.agents.filter(hit), teams: entries.teams.filter(hit) };
}

/** 过滤 + 双组扁平（agents 在前 teams 在后——键盘 ↑↓ 跨两组连续编号的行源） */
export function flatRefItems(entries: RefEntries, query: string): RefItem[] {
  const { agents, teams } = filterRefEntries(entries, query);
  return [
    ...agents.map((e) => ({ ...e, sym: '$' as const })),
    ...teams.map((e) => ({ ...e, sym: '#' as const })),
  ];
}

/** R5 未知引用聚合（发送前只读检查）：消息里全部 $/# token（与 token 解析面同词法：
 *  (^|\s) 起手 + 小写首字符），未命中缓存 entries id 集者原样收集（含符号）；同 token
 *  去重保序。调用方约定：entries 从未拉过（palette 未开过）跳过整个检查——不为提示补拉。 */
export function unknownRefTokens(text: string, entries: RefEntries): string[] {
  const ids = new Set([...entries.agents, ...entries.teams].map((e) => e.id));
  const out: string[] = [];
  for (const m of text.matchAll(/(^|\s)([$#][a-z][a-z0-9-]*)/g)) {
    const tok = m[2] ?? '';
    if (ids.has(tok.slice(1))) continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

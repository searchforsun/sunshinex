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

/** 会话任务板任务（2026-11-20 用户裁定「$/# 出来当前会话正在运行的或存在的团队及任务,不含
 *  临时 spawn 子智能体」）：任务板上的开放任务（pending/running）——spawn 子智能体在账本不在板，
 *  天然不入列 */
export interface RefTask {
  id: string;
  title: string;
  status: string;
}

/** 两目录缓存+本会话实时实体（2026-11-20）：agents/teams=目录（惰拉一次）；liveTeams/liveTasks=
 *  当前会话实时（Chat 由投影 teams/board 派生，随快照更新）——实时项置顶，目录项在后 */
export interface RefEntries {
  agents: RefEntry[];
  teams: RefEntry[];
  liveTeams?: RefEntry[];
  liveTasks?: RefTask[];
  /** 本会话存活团队成员（2026-11-21 用户实测「$ 怎么不显示会话中的团队成员」）：id=成员名
   *  （send_agent_team_message 按名寻址），name 同值仅作显示 */
  liveMembers?: RefEntry[];
}

/** palette 触发态（use-composer-keys 键面与 Chat 渲染面共享形态） */
export interface RefPal {
  query: string;
  from: number;
  sym: '$' | '#';
}

/** 带符号的扁平行（键盘游标/onPick 载荷；sym 决定插入文本前缀）。
 *  section=分组头（相邻同值只渲染一次；undefined=无组头，$ 域守恒旧）；note=行尾状态注解（任务态） */
export interface RefItem extends RefEntry {
  sym: '$' | '#';
  section?: string;
  note?: string;
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

/** 条目展示名/插入名（2026-11-20 用户裁定「# $ 后面只跟上名称,用户不感知 id」）：名称优先，
 *  无名/与 id 同形回落 id；**含空白字符的名称回落 id**（token 词法以空白为界，名称带空格会
 *  被截断成半个 token——宁可让这条显 id 也不产坏引用） */
export function refPickLabel(e: RefEntry): string {
  const name = e.name !== '' ? e.name : e.id;
  return /\s/.test(name) ? e.id : name;
}

/** 名称→id 发送期展开（2026-11-20 用户裁定「发送给 agent 时再拼上 id」）：草稿里插入的是名称，
 *  发送前按目录把 `#名称`/`$名称` 还原成 `#id`/`$id`（模型契约不变）。长名先换（防前缀吞并：
 *  「数据」不会吃掉「数据平台专家」的头部）；已在册的 id 形态原样保留（幂等） */
export function expandRefNames(text: string, entries: RefEntries): string {
  const pairs: Array<{ from: string; to: string }> = [];
  for (const a of entries.agents) {
    const label = refPickLabel(a);
    if (label !== a.id) pairs.push({ from: `$${label}`, to: `$${a.id}` });
  }
  for (const t of entries.teams) {
    const label = refPickLabel(t);
    if (label !== t.id) pairs.push({ from: `#${label}`, to: `#${t.id}` });
  }
  // 本会话实时团队/任务(2026-11-20):名称/标题插入 → 发送期还原 id(任务 id=t<seq>,模型按板 id 用)
  for (const t of entries.liveTeams ?? []) {
    const label = refPickLabel(t);
    if (label !== t.id) pairs.push({ from: `#${label}`, to: `#${t.id}` });
  }
  for (const m of entries.liveMembers ?? []) {
    if (m.name !== m.id) pairs.push({ from: `$${m.name}`, to: `$${m.id}` });
  }
  for (const t of entries.liveTasks ?? []) {
    const label = t.title !== '' ? t.title : t.id;
    if (!/\s/.test(label) && label !== t.id) pairs.push({ from: `#${label}`, to: `#${t.id}` });
  }
  pairs.sort((x, y) => y.from.length - x.from.length);
  let out = text;
  for (const p2 of pairs) out = out.split(p2.from).join(p2.to);
  return out;
}

/** id 前缀过滤（大小写不敏感——catalog id 词法允许大写而触发令牌恒小写，宽进窄出）；
 *  两组各自过滤保原序，空 query 全量保留 */
export function filterRefEntries(entries: RefEntries, query: string): RefEntries {
  const q = query.toLowerCase();
  const hit = (e: RefEntry): boolean => e.id.toLowerCase().startsWith(q);
  return { agents: entries.agents.filter(hit), teams: entries.teams.filter(hit) };
}

/** 过滤 + 单域扁平（2026-11-05 用户裁定：$ 与 # 拆开各弹各的，不再同面板双组混列——
 *  sym 决定取哪组；键盘 ↑↓ 在单组内循环） */
export function flatRefItems(entries: RefEntries, query: string, sym: '$' | '#'): RefItem[] {
  const hit = sym === '$' ? filterRefEntries(entries, query).agents : filterRefEntries(entries, query).teams;
  return hit.map((e) => ({ ...e, sym }));
}

/** 面板行单点（渲染/键盘共用）：$=目录子智能体（无组头，旧形）；#=本会话团队 → 本会话任务 →
 *  目录团队三段（2026-11-20 用户裁定「直接 $ # 出来当前会话正在运行的或存在的团队及任务」）。
 *  实时段任一在场时目录段补「目录团队」组头以示来源；实时全空=旧形单段无组头（零回归）。 */
export function refPanelItems(entries: RefEntries, query: string, sym: '$' | '#'): RefItem[] {
  if (sym === '$') {
    // 本会话成员置顶（2026-11-21）：成员名即寻址键，选中插 $名；目录 agents 在后
    const qs = query.toLowerCase();
    const liveM = (entries.liveMembers ?? [])
      .filter((e) => qs === '' || e.name.toLowerCase().includes(qs))
      .map((e) => ({ ...e, sym: '$' as const, section: 'Live members' }));
    const catalogA = filterRefEntries(entries, query).agents.map((e) => ({
      ...e,
      sym: '$' as const,
      ...(liveM.length > 0 ? { section: 'Catalog agents' } : {}),
    }));
    return [...liveM, ...catalogA];
  }
  const q = query.toLowerCase();
  const hit = (id: string, name: string): boolean => q === '' || id.toLowerCase().includes(q) || name.toLowerCase().includes(q);
  const liveTeams = (entries.liveTeams ?? []).filter((e) => hit(e.id, e.name)).map((e) => ({ ...e, sym: '#' as const, section: 'Live teams' }));
  const liveTasks = (entries.liveTasks ?? []).filter((e) => hit(e.id, e.title)).map((e) => ({ id: e.id, name: e.title, sym: '#' as const, section: 'Live tasks', note: e.status }));
  const catalog = filterRefEntries(entries, query).teams.map((e) => ({
    ...e,
    sym: '#' as const,
    ...(liveTeams.length > 0 || liveTasks.length > 0 ? { section: 'Catalog teams' } : {}),
  }));
  return [...liveTeams, ...liveTasks, ...catalog];
}

/** R5 未知引用聚合（发送前只读检查）：消息里全部 $/# token（与 token 解析面同词法：
 *  (^|\s) 起手 + 小写首字符），未命中缓存 entries id 集者原样收集（含符号）；同 token
 *  去重保序。调用方约定：entries 从未拉过（palette 未开过）跳过整个检查——不为提示补拉。 */
export function unknownRefTokens(text: string, entries: RefEntries): string[] {
  const ids = new Set([
    ...[...entries.agents, ...entries.teams].map((e) => e.id),
    ...(entries.liveTeams ?? []).map((e) => e.id),
    ...(entries.liveTasks ?? []).map((e) => e.id),
  ]);
  // 名称形态也算已匹配（2026-11-20 名称插入口径：插入的是名称，未匹配提示不得因此误报）
  const names = new Set<string>();
  for (const e of [...entries.agents, ...entries.teams, ...(entries.liveTeams ?? [])]) {
    if (e.name !== '' && e.name !== e.id && !/\s/.test(e.name)) names.add(e.name);
  }
  for (const t of entries.liveTasks ?? []) {
    if (t.title !== '' && t.title !== t.id && !/\s/.test(t.title)) names.add(t.title);
  }
  const out: string[] = [];
  for (const m of text.matchAll(/(^|\s)([$#][a-z][a-z0-9-]*)/g)) {
    const tok = m[2] ?? '';
    if (ids.has(tok.slice(1)) || names.has(tok.slice(1))) continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

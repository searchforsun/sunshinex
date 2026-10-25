/**
 * 应用级导航历史(前进/后退,浏览器形):记录壳层「位置」流——welcome 空态与已开会话。
 * 回跳=直接 openSession(记录的 sessionId):会话常驻 daemon 注册表(仅受控删除/收编空壳
 * 时移出),GUI 会话端点全按 :id 寻址,无需重走 newSession+attach——无 journal 档的新会话
 * (journal id 首次写链才铸造,App 端不可知)同样可回跳。纯状态单点,App 壳消费。
 */

/** 壳层导航位置:welcome=无会话空态;chat=已开会话(sessionId 即 daemon 在座键) */
export type NavLoc =
  | { k: 'welcome' }
  | { k: 'chat'; sessionId: string; root: string; journalId: string };

/** 导航历史:栈 + 当前位次(后退=idx 左移,前进=idx 右移;idx 右侧为前进尾支) */
export interface NavHistory {
  stack: NavLoc[];
  idx: number;
}

export const emptyNavHistory = (): NavHistory => ({ stack: [], idx: -1 });

/** 位置判等键:相邻去重依据——同会话连续记录折叠(rewind/重复 open 同会话不涨栈) */
export const navKeyOf = (loc: NavLoc): string => (loc.k === 'welcome' ? 'welcome' : loc.sessionId);

/** 栈容量:超出裁最旧(导航史是便宜品,防长会话期无界增长) */
export const NAV_CAP = 50;

/** 记录一次导航:截断前进尾支 → 相邻去重 → 尾追 → cap 裁最旧。纯函数返回新史 */
export function pushNav(h: NavHistory, loc: NavLoc, cap = NAV_CAP): NavHistory {
  const cur = h.stack[h.idx];
  if (cur !== undefined && navKeyOf(cur) === navKeyOf(loc)) return h;
  const stack = [...h.stack.slice(0, h.idx + 1), loc];
  const trimmed = stack.length > cap ? stack.slice(stack.length - cap) : stack;
  return { stack: trimmed, idx: trimmed.length - 1 };
}

/** 导航控制面(NavButtons/ChatTopbar 消费):两端可用性与回调动词 */
export interface NavControls {
  canBack: boolean;
  canForward: boolean;
  back(): void;
  forward(): void;
}

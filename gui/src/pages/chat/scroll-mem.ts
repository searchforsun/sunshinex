/**
 * G14.212 会话滚动位存档(localStorage `sunshinex.chat-scroll`)：id → { d: 距底 px, t: 时刻 }。
 * 非贴底(>80px,同贴底判定阈值)才记;贴底离开删档(再进照旧跳底)。内存单例跨 Chat 重挂载
 * 存活(key 换装即读),localStorage 节流落盘(冷却 800ms 直写+尾随写);容量封顶 100(超出丢
 * 最旧),存储满/禁用静默。
 * (2026-10-27 技术债轮自 Chat.tsx 外提——≤800 验收线回弹清算,行为零变化;消费面 Chat
 * onScroll 存档/挂载恢复位)
 */
import { loadStoredMap, persistCappedMap } from '../../ui-util';

const SCROLL_KEY = 'sunshinex.chat-scroll';
type ScrollMem = Record<string, { d: number; t: number; k?: string; o?: number }>;
let scrollMem: ScrollMem | null = null;
let scrollFlushAt = 0;
/** 最近一次 saveScrollPos 时刻(=滚动活动探针):落盘必须等滚动停顿,滚动中同步写 localStorage
 *  会打进当前帧——2026-11-19 用户实测「快速滑动有卡顿感」:滚动中每 ~800ms 一次的同步落盘
 *  (JSON.stringify 全表 + setItem)在实测帧线里对应 22ms 尖峰(压掉 setItem 后 0 帧>20ms) */
let lastSaveAt = 0;
let scrollFlushTimer: ReturnType<typeof setTimeout> | null = null;
/** 滚动停顿判据(ms):最后一次存档后静默这么久才允许落盘 */
const SETTLE_MS = 400;

function scrollMemMap(): ScrollMem {
  if (scrollMem !== null) return scrollMem;
  scrollMem = loadStoredMap<{ d: number; t: number; k?: string; o?: number }>(SCROLL_KEY);
  return scrollMem;
}

/** 节流落盘收口(卸载/切换前冲刷;Chat 经 useChatScroll 注入消费) */
export function flushScrollMem(): void {
  if (scrollFlushTimer !== null) {
    clearTimeout(scrollFlushTimer);
    scrollFlushTimer = null;
  }
  scrollFlushAt = Date.now();
  if (scrollMem === null) return;
  persistCappedMap(SCROLL_KEY, scrollMem, 100, (v) => v.t);
}

/** 滚动停顿后再落盘:定时器到点仍见新的滚动存档(用户还在滑)就顺延,绝不插进滚动帧 */
function flushWhenSettled(): void {
  scrollFlushTimer = null;
  const now = Date.now();
  if (now - lastSaveAt < SETTLE_MS) {
    scrollFlushTimer = setTimeout(flushWhenSettled, 300);
    return;
  }
  flushScrollMem();
}

/** 落档(2026-11-18 虚拟窗口):除距底 dist 外再记内容锚(块 key + 块顶相对视口偏移)——虚拟
 *  窗口下总高是估算值,距底反推不可靠;锚式恢复按块模型坐标落点,冷开/换座都准。
 *  anchor 缺省(jsdom/降级面)照旧只记距底。
 *  2026-11-19:落盘异步化(见 lastSaveAt 注)——内存表即权威,localStorage 仅供跨重启;
 *  滚动停顿 SETTLE_MS 后才写,滚动中零同步 I/O */
export function saveScrollPos(id: string, dist: number, anchor?: { key: string; off: number }): void {
  const m = scrollMemMap();
  lastSaveAt = Date.now();
  if (dist <= 0) delete m[id];
  else m[id] = { d: Math.round(dist), t: lastSaveAt, ...(anchor !== undefined && anchor.key !== '' ? { k: anchor.key, o: Math.round(anchor.off) } : {}) };
  if (scrollFlushTimer !== null) return;
  scrollFlushTimer = setTimeout(flushWhenSettled, Date.now() - scrollFlushAt > 800 ? 120 : 800);
}

/** 存档读取:仅非贴底位(≤80px 视为贴底语义,回 null 走跳底) */
export function peekScrollPos(id: string): number | null {
  const hit = scrollMemMap()[id];
  const out = hit !== undefined && hit.d > 80 ? hit.d : null;
  return out;
}

/** 锚式恢复位(块 key + 块顶相对视口偏移);无锚/档不足阈值回落 null(距底恢复路径接手) */
export function peekScrollAnchor(id: string): { key: string; off: number } | null {
  const hit = scrollMemMap()[id];
  if (hit === undefined || hit.d <= 80 || typeof hit.k !== 'string' || hit.k === '' || typeof hit.o !== 'number') return null;
  return { key: hit.k, off: hit.o };
}

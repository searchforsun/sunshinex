/**
 * 快捷键集中分发器 + 动作总线(2026-11-25 调研轮,取代散落的 window keydown 内联绑定):
 * window keydown 捕获态按注册表规范化匹配 → 动作 id → bus 广播;处理器回 true=已消费,
 * 分发器才 preventDefault + stopImmediatePropagation——未消费不拦(如 Alt+← 无史可退时
 * 放浏览器态原生历史导航,与旧 use-nav-history 行为一致)。
 * 挂起面:设置/定时任务覆盖层全屏期间键面整体暂停(旧 nav 键同口径,App 落旗),
 * 仅白名单 app.shortcuts 豁免——设置页内仍可唤起快捷键帮助页;录制态见旗让位。
 */
import { SHORTCUT_DEFS, eventToCombo } from './registry';
import type { ShortcutId } from './registry';
import { isShortcutCapturing, resolveShortcutKeys } from './store';

type Handler = (e: KeyboardEvent) => boolean;
const handlers = new Map<ShortcutId, Set<Handler>>();

/** 订阅动作(处理器回 true=已消费触发拦截;回 false/void=放行)。返回解绑函数 */
export function onShortcut(id: ShortcutId, fn: Handler): () => void {
  let set = handlers.get(id);
  if (set === undefined) {
    set = new Set();
    handlers.set(id, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

function emit(id: ShortcutId, e: KeyboardEvent): boolean {
  const set = handlers.get(id);
  if (set === undefined) return false;
  let consumed = false;
  for (const fn of set) {
    if (fn(e) === true) consumed = true;
  }
  return consumed;
}

/** 生效键串 → 动作 id 反查(已清除=不匹配) */
function matchCombo(combo: string): ShortcutId | null {
  for (const d of SHORTCUT_DEFS) {
    if (resolveShortcutKeys(d.id) === combo) return d.id;
  }
  return null;
}

let suspended = false;
/** 挂起豁免面:覆盖层全屏时仍可用的动作(快捷键帮助页——设置页内唤起本页) */
const SUSPEND_ALLOW: ReadonlySet<ShortcutId> = new Set<ShortcutId>(['app.shortcuts']);

/** 覆盖层挂起旗(设置/定时任务全屏时 App 落 true;分发器按白名单豁免) */
export function setShortcutsSuspended(on: boolean): void {
  suspended = on;
}

/** 挂载集中分发器(App 壳一次性挂载;返回卸载函数) */
export function installShortcutDispatcher(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (isShortcutCapturing()) return; // 录制态:ShortcutsPane 录制器自理
    const combo = eventToCombo(e);
    if (combo === null) return;
    const id = matchCombo(combo);
    if (id === null) return;
    if (suspended && !SUSPEND_ALLOW.has(id)) return;
    if (emit(id, e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  window.addEventListener('keydown', onKey, true);
  return () => {
    window.removeEventListener('keydown', onKey, true);
  };
}

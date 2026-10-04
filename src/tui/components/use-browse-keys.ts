import * as React from 'react';
import { SessionController, TuiState } from '../session';
import { runningDelegations } from '../chat-model';
import { RetainedUiState } from '../ui-state';
import { moveCursor } from './OptionSelector';
import { BrowseRow } from './BrowseList';
import type { RawKey } from './use-input';

/** Ctrl+B 浏览序列单点（2026-09-28 统一口径）：运行中委派在前（启动序,并集选择器口径）+ 已完成 spawn 按
 *  subagentMeta.delegatedAt 委派时间升序在后（旧档字段缺省回落 seq 序）——↑↓ 键盘分发与动态区列表渲染
 *  共用同一函数，两侧永不漂移 */
export function browseRows(st: TuiState): BrowseRow[] {
  return [
    ...runningDelegations(st).map((r) => ({ id: `live:${r.label}`, label: r.label, running: true as const })),
    ...st.messages
      .filter((m) => m.kind === 'call' && m.text.startsWith('SPAWN ') && m.subagentMeta)
      .map((m) => ({ id: `archived:${m.seq}`, label: m.text.replace(/^SPAWN /, ''), seq: m.seq, meta: m.subagentMeta }))
      .sort((a, b) => (a.meta?.delegatedAt ?? a.seq!) - (b.meta?.delegatedAt ?? b.seq!)),
  ];
}

/** browse 模态键分发 hook（D17-H2 拆自 App useInput 第 2/3 层，行为零变化）：
 *  收编子代理浏览态的整段按键分支、Ctrl+B 进入分支及其专属状态（browseMode / browseCursor / setBrowse）。
 *  浏览在场恒吞键；进入 inspect 经 enterInspect 注入（inspect hook 的 setInspectRetained），不复制其状态 */
export function useBrowseKeys({
  controller,
  stateRef,
  store,
  enterInspect,
}: {
  controller: SessionController;
  /** 键分发 ref 真值（App 持有）：浏览器序列构造必须读 ref 不读闭包（节流滞后） */
  stateRef: React.MutableRefObject<TuiState>;
  store: RetainedUiState;
  /** Enter 命中行 → 进入全屏查看（live/archived），由 useInspectKeys 提供 */
  enterInspect: (v: { kind: 'live'; label: string } | { kind: 'archived'; seq: number }) => void;
}): {
  browseMode: boolean;
  browseCursor: number;
  browseModeRef: React.MutableRefObject<boolean>;
  /** 模态接管（判定序第 2 位=browse 在场吞键、第 3 位=Ctrl+B 进入）：任一命中恒 true，否则 false 交下一位 */
  handleKey: (input: string, key: RawKey) => boolean;
} {
  // 子代理浏览模式（Ctrl+B）：本地态 + ref 真值（useInput 处理器经 effect 重挂存在闭包滞后，对标 qCursor 先例）；
  // 两态经 retain 跨重挂保留——repaint effect 依赖含 browseMode（行高亮须 Static 整屏重放），不在 retain 则
  // 一按 Ctrl+B 即卸载重挂、浏览态丢失（真机「按 Ctrl+B 挂死」观感）；旧 retain 快照缺字段回落关闭态
  const [browseMode, setBrowseMode] = React.useState(store.browseMode ?? false);
  const browseModeRef = React.useRef(store.browseMode ?? false);
  const [browseCursor, setBrowseCursor] = React.useState(store.browseCursor ?? 0);
  const browseCursorRef = React.useRef(store.browseCursor ?? 0);
  const setBrowse = (mode: boolean, cursor = 0): void => {
    browseModeRef.current = mode;
    browseCursorRef.current = cursor;
    // store 同步先于 setState（对标 setInspectRetained）：browse→inspect 切换经 onRequestRepaint 同步卸载，
    // 本帧「现场回写」effect 永不再跑（setBrowse(false) 的提交被卸载吞掉），不同步写即重挂后 browseMode
    // 残留 true——全屏态叠加浏览态吞键（真机「Tab/Esc 须先按 Enter 才生效」病根）
    store.browseMode = mode;
    store.browseCursor = cursor;
    setBrowseMode(mode);
    setBrowseCursor(cursor);
  };
  // 子代理浏览模式（Ctrl+B 进入）：短接管 ↑/↓/Enter/Esc；其余按键一律吞掉不落输入缓冲。
  // 光标与模式取 ref 真值（处理器经 effect 重挂存在闭包滞后，对标 qCursor 先例）；仅 idle/error 可进入
  const handleKey = (input: string, key: RawKey): boolean => {
    if (browseModeRef.current) {
      // 统一子代理浏览器（2026-09-28 用户裁决：历史与运行中全部由动态区承载）：合并序列单点口径——
      // 运行中子代理在前 + 已完成 spawn 委派时间升序在后；常态 ChildPanel 只显运行中，浏览列表两类行统一呈现
      const st = stateRef.current;
      const rows = browseRows(st);
      if (rows.length === 0) { setBrowse(false); return true; }
      const clamp = (n: number): number => Math.max(0, Math.min(rows.length - 1, n));
      if (key.escape) { setBrowse(false); return true; }
      if (key.upArrow || key.downArrow) {
        // 光标移动零 repaint（选中列表动态区每帧自绘）；窗口按每页 8 行自动平移（BrowseList 同口径）。
        // 回环移动（2026-10-02 交互统一）：问询/审批/计划/斜杠菜单全部 moveCursor 回环，浏览列表同款——
        // 全部列表一套肌肉记忆，到边即停是孤例
        setBrowse(true, moveCursor(browseCursorRef.current, rows.length, key.upArrow ? -1 : 1));
        return true;
      }
      if (key.return) {
        const row = rows[clamp(browseCursorRef.current)];
        if (row?.running) {
          // 运行中 → 进入全屏实时视图（规格 §3.3）
          enterInspect({ kind: 'live', label: row.label });
        } else if (row?.seq !== undefined) {
          // 已完成 → 进入全屏回看（detail 派生）
          enterInspect({ kind: 'archived', seq: row.seq });
        }
        setBrowse(false);
        return true;
      }
      // Ctrl+C：退出浏览并走暂停确认（同主视图两次 Ctrl+C 口径——浏览态原语义只退浏览不暂停，运行中暂停在此不可达）
      if (key.ctrl && input === 'c') {
        setBrowse(false);
        if (stateRef.current.pauseConfirm) controller.interrupt();
        else controller.requestPause();
        return true;
      }
      return true;
    }
    // Ctrl+B 进入统一子代理浏览器：运行中子代理或已完成 spawn 任一在场即可；state 读 ref 真值
    if (key.ctrl && input === 'b') {
      const st = stateRef.current;
      const rows = browseRows(st);
      if (rows.length > 0) {
        setBrowse(true, rows.length - 1); // 光标缺省落最近一条
      }
      return true;
    }
    return false;
  };
  return { browseMode, browseCursor, browseModeRef, handleKey };
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { Connection } from '../connection';
import { zoomScale } from '../ui-zoom';
import type { TabParams } from './tab-state';
import { WebTab } from './WebTab';

/** 浏览器页签常驻池(2026-11-03 浏览器状态按会话隔离):全部会话座位的 web 页签统一挂在应用根下,
 *  切会话/收起侧栏/进设置都不卸载——webview 卸载=页面状态丢失,且后台会话的 agent 失去可驱动页。
 *  可见项=当前座位活动的 web 页签,按侧栏页签体占位框(anchorRef)逐帧对位;其余离屏(不 display:none
 *  ——隐藏的 guest 停止出帧,agent 截图黑屏)。
 *  分区:会话座位 persist:sx-<浏览器键>(daemon /browser-key,=journalId,重启保留登录态,与浏览器插件
 *  MCP 连接同键);欢迎页草稿座位用内存分区(发送后迁入会话座位即换分区重挂) */
export interface WebPoolItem {
  readonly seat: string;
  readonly uid: string;
  readonly params: TabParams;
}

export const DRAFT_PARTITION = 'sx-draft';

/** 离屏位置(远离视口但保持真实尺寸,guest 照常布局/出帧) */
const OFFSCREEN_X = -100_000;

export function WebTabPool({
  conn,
  items,
  visibleUid,
  anchorRef,
  root,
  draftSeat,
  onMeta,
  onClose,
  onActivate,
}: {
  conn: Connection;
  items: readonly WebPoolItem[];
  /** 当前应显示的页签 uid(null=全部离屏) */
  visibleUid: string | null;
  /** 侧栏活动页签体(占位框)——可见项按其视口矩形对位 */
  anchorRef: MutableRefObject<HTMLDivElement | null>;
  root: string;
  draftSeat: string;
  onMeta: (seat: string, uid: string, patch: { url?: string; pageTitle?: string; pageIcon?: string }) => void;
  onClose: (seat: string, uid: string) => void;
  onActivate: (seat: string, uid: string) => void;
}): JSX.Element {
  const [partitions, setPartitions] = useState<Record<string, string>>({});
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const { seat } of items) {
      if (requested.current.has(seat)) continue;
      requested.current.add(seat);
      if (seat === draftSeat || conn.browserKey === undefined) {
        setPartitions((p) => ({ ...p, [seat]: DRAFT_PARTITION }));
        continue;
      }
      conn.browserKey(seat).then(
        (key) => setPartitions((p) => ({ ...p, [seat]: `persist:sx-${key}` })),
        // 会话已不在 daemon(过期座位):内存分区兜底,页签仍可用
        () => setPartitions((p) => ({ ...p, [seat]: `sx-tmp-${seat}` })),
      );
    }
  }, [items, conn, draftSeat]);

  /** 池项元素表(直写寻址;回调 ref 挂卸维护) */
  const itemEls = useRef(new Map<string, HTMLDivElement>());
  const setItemRef = (uid: string) => (el: HTMLDivElement | null): void => {
    if (el === null) itemEls.current.delete(uid);
    else itemEls.current.set(uid, el);
  };
  /** 对位单帧:占位框 gBCR(视觉 px)→ 可见池项样式(本地 px=视觉/zoom,ui-zoom 跨空间契约;
   *  zoom1.25 不除即整体右移 25% 左侧空白+宽度放大 25% 右侧越视口)。**直写 DOM 不经 React
   *  状态**——状态一帧一渲染提交在拖栏这类连续布局变化下必然滞后(WebTab 全子树 reconcile
   *  更重),实测左缘拖影、框溢出侧栏边界;直写与测量同帧落笔,paint 前即锚定占位框 */
  const applyRect = (): void => {
    const anchor = anchorRef.current;
    const item = visibleUid === null ? undefined : itemEls.current.get(visibleUid);
    if (anchor === null || item === undefined) return;
    const r = anchor.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const z = zoomScale();
    const s = item.style;
    s.left = `${r.left / z}px`;
    s.top = `${r.top / z}px`;
    s.width = `${r.width / z}px`;
    s.height = `${r.height / z}px`;
  };
  // 可见项切换(挂载/换签)同步写位:layout effect 在 paint 前生效,无「首帧落旧位」闪面
  useLayoutEffect(() => {
    applyRect();
  }, [visibleUid, anchorRef]);
  // 逐帧跟随(拖栏/收展开/窗口缩放)
  useEffect(() => {
    if (visibleUid === null) return;
    let raf = 0;
    const tick = (): void => {
      applyRect();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visibleUid, anchorRef]);

  /** 页签上次落定的分区:换座(同档运行时换号并座)后新座分区在途期间沿用——分区串不变则 WebTab
   *  key 不变,webview 不卸载不重载 */
  const partByUid = useRef(new Map<string, string>());
  return (
    <div className="sx-webpool">
      {items.map((it) => {
        const vis = it.uid === visibleUid;
        const part = partitions[it.seat] ?? partByUid.current.get(it.uid);
        if (part !== undefined) partByUid.current.set(it.uid, part);
        return (
          <div
            key={it.uid}
            ref={setItemRef(it.uid)}
            className="sx-webpool-item"
            data-seat={it.seat}
            data-uid={it.uid}
            /* 动态定位值(left/top/width/height)不入 style prop——React 重渲染会按 prop 复位
             * 内联样式,冲掉直写值造成回跳;prop 只持离屏位(不可见恒离屏),可见项四值全归
             * applyRect 直写管 */
            style={{ position: 'fixed', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--surface)', ...(vis ? {} : { left: OFFSCREEN_X, top: 0 }) }}
            {...(vis ? {} : { inert: '' as unknown as boolean, 'aria-hidden': true })}
          >
            {part !== undefined && (
              <WebTab
                key={part}
                conn={conn}
                params={it.params}
                uid={it.uid}
                root={root}
                partition={part}
                onMeta={(uid, patch) => onMeta(it.seat, uid, patch)}
                onClose={() => onClose(it.seat, it.uid)}
                onActivate={() => onActivate(it.seat, it.uid)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 浏览器键(=journalId)对应的池项座位:会话按 journalId 删除时据分区反查运行时座位 */
export function seatsOfBrowserKey(key: string): string[] {
  const part = `persist:sx-${key}`;
  return Array.from(document.querySelectorAll('.sx-webpool-item'))
    .filter((el) => el.querySelector('webview')?.getAttribute('partition') === part)
    .map((el) => (el as HTMLElement).dataset.seat ?? '')
    .filter((s) => s !== '');
}

/** 持有某 guest webContents 的池项座位(页内弹窗按开启者归座) */
export function seatOfWebContents(webContentsId: number): string | undefined {
  for (const el of Array.from(document.querySelectorAll('.sx-webpool-item'))) {
    const wv = el.querySelector('webview') as (HTMLElement & { getWebContentsId?: () => number }) | null;
    try {
      if (wv?.getWebContentsId?.() === webContentsId) return (el as HTMLElement).dataset.seat;
    } catch { /* 未 attach */ }
  }
  return undefined;
}

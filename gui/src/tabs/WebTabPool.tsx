import { useEffect, useRef, useState } from 'react';
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

interface Rect { left: number; top: number; width: number; height: number }

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

  const [rect, setRect] = useState<Rect>({ left: 0, top: 0, width: 800, height: 600 });
  useEffect(() => {
    if (visibleUid === null) return;
    let raf = 0;
    const tick = (): void => {
      const el = anchorRef.current;
      if (el !== null) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          // gBCR=视觉 px,本池项 position:fixed 在 html zoom 子树内样式 px=本地值(视觉/zoom)——
          // 不除即错位+超宽(ui-zoom 跨空间契约;zoom1.25 实测:池项整体右移 25%,右侧越视口)
          const z = zoomScale();
          const next: Rect = { left: r.left / z, top: r.top / z, width: r.width / z, height: r.height / z };
          setRect((p) => (p.left === next.left && p.top === next.top && p.width === next.width && p.height === next.height ? p : next));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [visibleUid, anchorRef]);

  return (
    <div className="sx-webpool">
      {items.map((it) => {
        const vis = it.uid === visibleUid;
        const part = partitions[it.seat];
        return (
          <div
            key={it.uid}
            className="sx-webpool-item"
            data-seat={it.seat}
            data-uid={it.uid}
            style={{ position: 'fixed', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--surface)', left: vis ? rect.left : OFFSCREEN_X, top: vis ? rect.top : 0, width: rect.width, height: rect.height }}
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

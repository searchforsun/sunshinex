import { useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { ChatEntry } from '../../chat-reducer';

/**
 * 对话刻度导航条(2026-10-26 九轮微调):
 * - 位置:贴主对话左缘(面板边框+固定呼吸距 6px),不随主对话宽度变化;
 * - 刻度:每条用户消息一枚等长短横(12×1.5);hover 变长为默认两倍(24px),相邻 18px 成弧形;
 *   当前滚动位置正对的刻度加重显色(不加长,长度变化只在 hover);
 * - 预览:hover 刻度右侧浮出固定宽 280px 预览卡(视觉对齐全局 data-tip 卡:elev-prominent
 *   阴影/lg 圆角/无边框),高度随内容 8 行封顶;
 * - 显隐:余量 ≥24(放下变长刻度)且 ≥2 条用户消息;垂直 10vh..90vh 居中。
 */

/** 呼吸参数(单一出处:组件测量门控与 CSS 视觉同口径) */
const HUG_LEFT = 6; // 贴边距
const SHOW_MIN_MARGIN = 24; // 余量门控:能放下 hover 刻度(贴 6+长 18)+呼吸;刻度长度视觉值在 CSS 同口径
const MIN_USERS = 2;

/** 气泡文本 → 预览文本:剥 markdown 痕迹,限 200 字(预览卡 8 行封顶,CSS line-clamp 兜底) */
function previewText(md: string): string {
  const flat = md
    .replace(/^>\s?/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图]')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*`_~]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' ');
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

export function ChatRail(props: {
  /** 可见窗内的条目(与 DOM 渲染集一致——点击按序反查 .entry-user) */
  readonly entries: readonly ChatEntry[];
  readonly chatScrollRef: MutableRefObject<HTMLElement | null>;
  readonly sideChat?: boolean;
}): JSX.Element {
  const { entries, chatScrollRef, sideChat } = props;
  // 余量实测:贴左 6px + hover 刻度 18px + 呼吸 → 余量 ≥24 才显示(用户裁定:放得下边长刻度才显示)。
  // 贴边锚点=面板左缘实测(RO 双值:余量判显隐 + 面板左 x 供 fixed 定位)

  const users = entries.filter((e) => e.kind === 'user' && e.md.trim() !== '');
  const [geo, setGeo] = useState<{ margin: number; left: number }>({ margin: 0, left: HUG_LEFT });
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const pad = Number.parseFloat(getComputedStyle(el).paddingLeft);
      const rect = el.getBoundingClientRect();
      setGeo({
        margin: Number.isFinite(pad) ? Math.max(0, pad - 18) : 0,
        left: Math.round(rect.left + HUG_LEFT),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [chatScrollRef]);
  /** 当前滚动位置正对的刻度(九轮):视口顶下 120px 分界——最后一条顶边越线的用户气泡;
   *  scroll rAF 节流单点,加重显色不加长(长度变化只在 hover) */
  const [activeIdx, setActiveIdx] = useState(-1);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el === null) return;
    let raf = 0;
    const onScroll = (): void => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const nodes = el.querySelectorAll('.entry-user');
        const line = el.getBoundingClientRect().top + 120;
        let idx = -1;
        nodes.forEach((n, i) => {
          if (n.getBoundingClientRect().top <= line) idx = i;
        });
        setActiveIdx(idx);
      });
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [chatScrollRef, users.length]);

  // 辅助对话/<2 条用户消息/余量不足放不下变长刻度:整条不渲染(用户裁定)
  if (sideChat === true || users.length < MIN_USERS || geo.margin < SHOW_MIN_MARGIN) return <></>;


  const jump = (index: number): void => {
    const el = chatScrollRef.current;
    if (el === null) return;
    const nodes = el.querySelectorAll('.entry-user');
    const node = nodes[index];
    if (node !== undefined) {
      node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  };

  return (
    <div className="sx-rail" aria-hidden="true">
      {/* 贴窗口左缘:fixed 锚面板左缘实测 x+6(滚动/缩放随 RO 实时跟随;恒居中 10vh..90vh) */}
      <div
        className="sx-rail-inner"
        role="navigation"
        aria-label="会话刻度导航"
        style={{ left: `${geo.left}px` }}
      >
        <div className="sx-rail-list">
          {users.map((u, i) => (
            <button key={u.key} type="button" className={`sx-rail-tick${i === activeIdx ? ' active' : ''}`} aria-label={`第 ${i + 1} 条消息`} onClick={() => jump(i)}>
              <span className="sx-rail-preview">{previewText(u.md)}</span>
              <span className="sx-rail-bar" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

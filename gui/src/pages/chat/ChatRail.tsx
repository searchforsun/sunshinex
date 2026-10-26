import { useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { ChatEntry } from '../../chat-reducer';
import { zoomScale } from '../../ui-zoom';

/**
 * 对话刻度导航条(2026-10-27 十一轮):
 * - 位置:贴主对话滚动口左缘(边框+固定呼吸距 6px),实测视觉坐标 /zoomScale 归一注入 fixed 子树;
 * - 刻度:每条用户消息一枚等长短横(12×1.5);hover 变长为默认两倍(24px),相邻 18px 成弧形;
 *   当前滚动位置正对的刻度加重显色(不加长,长度变化只在 hover);
 * - 预览:hover 刻度右侧浮出固定宽 280px 预览卡(视觉对齐全局 data-tip 卡),高度随内容 8 行封顶;
 * - 显隐:列左实测余量 ≥17(上一轮 34 减半,2026-10-27 用户裁定「缩到当前间距的一半就开启」)
 *   且 ≥2 条用户消息——余量=滚动容器 padding-left−18(限宽由对称 padding 承担,满宽档/平台档
 *   同口径);贴边 6+hover 刻度 24 仍不侵入列起位(18+17=35>30);
 * - 居中:刻度串几何中线=滚动口视觉中线(rect 中心 /zoomScale),inner translateY(-50%) 精确
 *   落中线(弃 10vh..90vh 视口带,顶栏/composer 不对称致假居中)。不做列高上限:overflow 裁剪
 *   容器会切掉刻度按钮的绝对定位预览卡(2026-10-27 裁定保预览)。
 */

/** 呼吸参数(单一出处:组件测量门控与 CSS 视觉同口径) */
const HUG_LEFT = 6; // 贴边距
const SHOW_MIN_MARGIN = 17; // 余量门控:上一轮 34 减半(2026-10-27 用户裁定「缩到当前间距的一半就开启」)
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
  // 显隐+锚点+中线实测(RO 三值):余量=paddingLeft−18 判显隐;滚动口左缘/中线视觉坐标除以
  // zoomScale 换算回 CSS 坐标注入 fixed 子树(zoom 子树内坐标=视觉/zoom,D50 契约)

  const users = entries.filter((e) => e.kind === 'user' && e.md.trim() !== '');
  const [geo, setGeo] = useState<{ show: boolean; left: number; top: number }>({
    show: false,
    left: HUG_LEFT,
    top: 0,
  });
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el === null) return;
    let raf = 0;
    // 测量单点(多通道汇入):读值全部现取(padding/rect 强制同步布局),setGeo 带同值守卫
    const measure = (): void => {
      const cs = getComputedStyle(el);
      const pad = Number.parseFloat(cs.paddingLeft);
      const rect = el.getBoundingClientRect();
      const z = zoomScale() || 1;
      setGeo((prev) => {
        const next = {
          show: Number.isFinite(pad) && pad - 18 >= SHOW_MIN_MARGIN,
          left: Number.isFinite(rect.left) ? Math.round(rect.left / z + HUG_LEFT) : HUG_LEFT,
          top: Number.isFinite(rect.top) ? Math.round((rect.top + rect.height / 2) / z) : 0,
        };
        return prev.show === next.show && prev.left === next.left && prev.top === next.top ? prev : next;
      });
    };
    // 显隐/锚点滞后一拍的三种来源各配一条触发线(十二轮半:单挂 RO 时,交互拖拽/渲染步
    // 节流期间 RO 交付停滞,刻度状态整段拖到偶发交付才更新——缩/涨两向滞后到越过阈值很远):
    // ①RO:盒尺寸变化(三栏拖拽/视口/折叠);②resize:窗口级变化的兜底通道(rAF 去抖);
    // ③MutationObserver:App RO 直写 .sx-main 等的 --chat-max 内联值——微任务通道,
    //   渲染步冻结时也送达,专治 RO 停摆段;自身 left/top 写回会同值自愈(setGeo 守卫截停)
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const onResize = (): void => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    window.addEventListener('resize', onResize);
    const mo =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((muts) => {
            for (const m of muts) {
              const t = m.target instanceof HTMLElement ? m.target : null;
              if (t !== null && t.style.getPropertyValue('--chat-max') !== '') {
                measure();
                return;
              }
            }
          });
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['style'], subtree: true });
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      if (raf !== 0) cancelAnimationFrame(raf);
      mo?.disconnect();
    };
  }, [chatScrollRef]);
  /** 当前滚动位置正对的刻度(九轮):视口顶下 120px 分界——最后一条顶边越线的用户气泡;
   *  scroll rAF 节流单点,加重显色不加长(长度变化只在 hover) */
  const [activeIdx, setActiveIdx] = useState(-1);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el === null) return;
    let raf = 0;
    const onScroll = (): void => {
      // 隐藏态(辅助对话/消息不足)不排动画帧:贴底跟随测试以 rAF 计数为不变量面,
      // 且隐藏态 activeIdx 无意义;可见性随 users.length 变化由 effect 依赖重跑承接
      if (raf !== 0 || sideChat === true || users.length < MIN_USERS) return;
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
  if (sideChat === true || users.length < MIN_USERS || !geo.show) return <></>;


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
      {/* 贴滚动口左缘+中线:fixed 锚实测 x/中线 y(滚动/缩放随 RO 实时跟随;translateY(-50%) 落中线) */}
      <div
        className="sx-rail-inner"
        role="navigation"
        aria-label="会话刻度导航"
        style={{ left: `${geo.left}px`, top: `${geo.top}px` }}
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

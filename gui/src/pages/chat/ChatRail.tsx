import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/** 滚动口实测锚(单点):show=余量门控;left/top=贴滚动口左缘+中线(视觉坐标 /zoomScale 归一,D50 契约) */
function railAnchor(el: HTMLElement): { show: boolean; left: number; top: number } | null {
  const pad = Number.parseFloat(getComputedStyle(el).paddingLeft);
  if (!Number.isFinite(pad)) return null;
  const rect = el.getBoundingClientRect();
  const z = zoomScale() || 1;
  return {
    show: pad - 18 >= SHOW_MIN_MARGIN,
    left: Number.isFinite(rect.left) ? Math.round(rect.left / z + HUG_LEFT) : HUG_LEFT,
    top: Number.isFinite(rect.top) ? Math.round((rect.top + rect.height / 2) / z) : 0,
  };
}

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
  /** 可见窗内的条目(刻度序列=有正文的用户消息;DOM 气泡按 data-entry-key 键寻址,纯图/空 md 不入列) */
  readonly entries: readonly ChatEntry[];
  readonly chatScrollRef: MutableRefObject<HTMLElement | null>;
  readonly sideChat?: boolean;
}): JSX.Element {
  const { entries, chatScrollRef, sideChat } = props;
  // 显隐+锚点+中线实测(RO 三值):余量=paddingLeft−18 判显隐;滚动口左缘/中线视觉坐标除以
  // zoomScale 换算回 CSS 坐标注入 fixed 子树(zoom 子树内坐标=视觉/zoom,D50 契约)

  const users = entries.filter((e) => e.kind === 'user' && e.md.trim() !== '');
  // 锚点直写 style 不经 React 提交(十三轮半,果冻效应根因):left/top 若走 state,重渲染
  // 落地比测量晚一拍——拖三栏滑动线/开关菜单时锚点追着布局跑,刻度悬在半空不落新边框。
  // show 仍走 state(挂卸载决策,翻转由 layout effect 当帧补锚)
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el === null) return;
    let raf = 0;
    // 测量单点(多通道汇入):读值全部现取(padding/rect 强制同步布局),锚点直写,show 同值守卫
    const measure = (): void => {
      const a = railAnchor(el);
      if (a === null) return;
      const inner = innerRef.current;
      if (inner !== null) {
        inner.style.left = `${a.left}px`;
        inner.style.top = `${a.top}px`;
      }
      setShow((prev) => (prev === a.show ? prev : a.show));
    };
    // 显隐/锚点滞后一拍的三种来源各配一条触发线(十二轮半:单挂 RO 时,交互拖拽/渲染步
    // 节流期间 RO 交付停滞,刻度状态整段拖到偶发交付才更新——缩/涨两向滞后到越过阈值很远):
    // ①RO:盒尺寸变化(三栏拖拽/视口/折叠);②resize:窗口级变化的兜底通道(rAF 去抖);
    // ③MutationObserver:App RO 直写 .sx-main 等的 --chat-max 内联值——微任务通道,
    //   渲染步冻结时也送达,专治 RO 停摆段;自身 left/top 写回同值自愈(setGeo 守卫截停)
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
  // 挂载/重挂当帧补锚(show 翻转重渲染后,绘制前同步写 left/top,避免 fixed auto 位置闪帧)
  useLayoutEffect(() => {
    if (!show) return;
    const el = chatScrollRef.current;
    const inner = innerRef.current;
    if (el === null || inner === null) return;
    const a = railAnchor(el);
    if (a !== null) {
      inner.style.left = `${a.left}px`;
      inner.style.top = `${a.top}px`;
    }
  }, [show, chatScrollRef]);
  /** 当前滚动位置正对的刻度(九轮):视口顶下 120px 分界——最后一条顶边越线的用户气泡;
   *  scroll rAF 节流单点,加重显色不加长(长度变化只在 hover)。
   *  十二轮半:DOM .entry-user 与刻度序列不再同序同长(纯图/空 md 用户气泡进 DOM 不进刻度),
   *  按 data-entry-key 键寻址——越线的最后一只带键气泡反查刻度序,无键气泡跳过 */
  const [activeIdx, setActiveIdx] = useState(-1);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el === null) return;
    const keyIdx = new Map(users.map((u, i) => [u.key, i]));
    let raf = 0;
    const onScroll = (): void => {
      // 隐藏态(辅助对话/消息不足)不排动画帧:贴底跟随测试以 rAF 计数为不变量面,
      // 且隐藏态 activeIdx 无意义;可见性随 users.length 变化由 effect 依赖重跑承接
      if (raf !== 0 || sideChat === true || users.length < MIN_USERS) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const nodes = el.querySelectorAll('.entry-user[data-entry-key]');
        const line = el.getBoundingClientRect().top + 120;
        let idx = -1;
        nodes.forEach((n) => {
          if (n.getBoundingClientRect().top <= line) {
            const ui = keyIdx.get(n.getAttribute('data-entry-key') ?? '');
            if (ui !== undefined) idx = ui;
          }
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
  if (sideChat === true || users.length < MIN_USERS || !show) return <></>;


  const jump = (index: number): void => {
    const el = chatScrollRef.current;
    if (el === null) return;
    // 键寻址(十二轮半):DOM 用户气泡集 ⊇ 刻度序列(纯图/空 md 进 DOM 不进刻度),按序号
    // 反查会错位——按 data-entry-key 直取目标气泡
    const target = users[index];
    if (target === undefined) return;
    const node = el.querySelector(`.entry-user[data-entry-key="${CSS.escape(target.key)}"]`);
    if (node === null) return;
    // 落点要准(用户裁定,不要平滑滑动):.entry 挂 content-visibility:auto,离屏条目
    // 只有估算高(contain-intrinsic-size),scrollIntoView 一次到位按估算高算滚动量必落偏——
    // 即时跳到位后按目标真实盒位置迭代校正;上方条目陆续水合会把目标继续推偏,预算 150 帧
    // 且连续 2 帧偏差≤2px 才收(24 帧封顶实测残差 87px:级联未停循环已退役)
    el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top;
    let tries = 0;
    let stable = 0;
    const correct = (): void => {
      if (!el.isConnected || tries > 150) return;
      tries++;
      const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
      if (Math.abs(delta) <= 2) {
        stable++;
        if (stable >= 2) return;
      } else {
        stable = 0;
        el.scrollTop += delta;
      }
      requestAnimationFrame(correct);
    };
    requestAnimationFrame(correct);
  };

  return (
    <div className="sx-rail" aria-hidden="true">
      {/* 贴滚动口左缘+中线:fixed 锚实测 x/中线 y 直写 style(测量同帧落位;translateY(-50%) 落中线) */}
      <div ref={innerRef} className="sx-rail-inner" role="navigation" aria-label="会话刻度导航">
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

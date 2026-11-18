import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { ChatEntry } from '../../chat-reducer';
import { t } from '../../i18n';
import { rAFConverge } from '../../ui-util';
import { CHAT_MAX_EVENT } from '../../thread-width';
import { zoomScale } from '../../ui-zoom';
import { MD_IMAGE_STRIP_RE } from './md-image-syntax';

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

/** 滚动口实测锚(单点):show=余量门控;left/top=贴滚动口左缘+中线(视觉坐标 /zoomScale 归一,D50 契约)。
 *  2026-10-28 用户实测「导航条宽/短/跑到顶部」:容器 display:none(keep-alive 隐藏席/换页瞬间)
 *  时 rect 全 0——旧零尺寸守卫仍产出 (HUG_LEFT,0) 坐标并被 measure 写入 inner,把刻度钉死窗顶;
 *  RO 交付停滞期无改写机会即滞留(2026-11-07 用户报障「刚生成时出现在左上角」)。现零尺寸返回
 *  null=坐标不写、显隐保持上一态(容器 display:none 时 fixed 子树本就不可见,恢复由 RO 非零重测) */
function railAnchor(el: HTMLElement): { show: boolean; left: number; top: number } | null {
  const pad = Number.parseFloat(getComputedStyle(el).paddingLeft);
  if (!Number.isFinite(pad)) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
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
    .replace(MD_IMAGE_STRIP_RE, t('[image]', '[图]'))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*`_~]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' ');
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

export function ChatRail(props: {
  /** 全量条目(2026-11-18 用户裁定「刻度条一次加载完」:序列=模型而非挂载窗——冷/后台补齐期
   *  刻度即刻完整;点击未挂载条目经 onReveal 先扩窗后落点)。DOM 气泡按 data-entry-key 寻址,
   *  纯图/空 md 不入列 */
  readonly entries: readonly ChatEntry[];
  readonly chatScrollRef: MutableRefObject<HTMLElement | null>;
  readonly sideChat?: boolean;
  /** 目标条目未挂载时先扩挂载窗(MessageList 提供:返回是否已挂上);缺省=旧行为(找不到即不跳) */
  readonly onReveal?: (key: string) => boolean;
  /** 模型反查当前轮(2026-11-18 用户裁定「刻度时刻显示视口下侧所属用户气泡轮次、没有空档期」):
   *  入参=判定线的内容坐标(块前缀和同空间),返回该线所属用户条的 key。虚拟窗口下长正文轮的
   *  用户气泡常在挂载窗外,旧 DOM 反查取不到=加亮断档;传入即按模型算,缺省回落 DOM 反查 */
  readonly activeKeyAt?: (lineContent: number) => string | null;
}): JSX.Element {
  const { entries, chatScrollRef, sideChat, onReveal } = props;
  // 显隐+锚点+中线实测(RO 三值):余量=paddingLeft−18 判显隐;滚动口左缘/中线视觉坐标除以
  // zoomScale 换算回 CSS 坐标注入 fixed 子树(zoom 子树内坐标=视觉/zoom,D50 契约)

  /** 刻度行数据一次算好随 entries 封存(2026-11-18 大会话滚动 CPU 轮):旧实现每次渲染现算
   *  filter+replyByKey+N 份 previewText(正则剥 markdown),滚动期 activeIdx 每变一次=整条刻度
   *  重渲染一遍——上千条会话即每秒数万次正则的 CPU 尖峰。预览串只随消息内容变,不与滚动相关 */
  const rows = useMemo(() => {
    const users = entries.filter((e) => e.kind === 'user' && e.md.trim() !== '');
    // 每部分回复正文(2026-10-31 用户裁定:取该轮**最后一个**正文条——流式/思考分段会把一轮拆成
    // 多条 assistant,末条=收束全文;首条常只是开头段。持续覆盖直至下一用户消息)
    const replyByKey = new Map<string, string>();
    {
      let pendingKey: string | null = null;
      for (const e of entries) {
        if (e.kind === 'user') {
          pendingKey = e.md.trim() !== '' ? e.key : null;
          continue;
        }
        if (pendingKey !== null && e.kind === 'assistant' && e.md.trim() !== '') {
          replyByKey.set(pendingKey, previewText(e.md));
        }
      }
    }
    return users.map((u) => ({ key: u.key, pv: previewText(u.md), reply: replyByKey.get(u.key) }));
  }, [entries]);
  /** 键 → 刻度序(滚动判定用;随 rows 封存) */
  const keyIdx = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
  // 锚点直写 style 不经 React 提交(十三轮半,果冻效应根因):left/top 若走 state,重渲染
  // 落地比测量晚一拍——拖三栏滑动线/开关菜单时锚点追着布局跑,刻度悬在半空不落新边框。
  // show 仍走 state(挂卸载决策,翻转由 layout effect 当帧补锚)
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [show, setShow] = useState(false);
  /** 首亮放行门(2026-10-31 用户复测「稳定门后仍会跳」):两次相同测量可能都落在内容未渲染的
   *  过渡布局上,条目落位后照样跳——改为时限放行:挂载 350ms 沉降期内的测量只静默写坐标不放行
   *  显示,沉降完成才可首亮(亮起即终位);已亮后实时跟随不受门限(流式高度变化不停亮) */
  const revealAtRef = useRef(false);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el === null) return;
    let raf = 0;
    // 测量单点(多通道汇入):读值全部现取(padding/rect 强制同步布局),锚点直写,show 同值守卫
    const measure = (): void => {
      const a = railAnchor(el);
      if (a === null) return; // 零尺寸/异常:坐标与显隐都保持上一态,绝不写 (6,0) 毒化坐标
      const inner = innerRef.current;
      if (inner !== null) {
        inner.style.left = `${a.left}px`;
        inner.style.top = `${a.top}px`;
      }
      setShow((p) => {
        if (p) return a.show ? p : false; // 已亮:只随余量门收起,位置继续实时跟随
        return revealAtRef.current && a.show; // 未亮:沉降期(350ms)不放行,亮起即终位
      });
    };
    // 显隐/锚点滞后一拍的三种来源各配一条触发线(十二轮半:单挂 RO 时,交互拖拽/渲染步
    // 节流期间 RO 交付停滞,刻度状态整段拖到偶发交付才更新——缩/涨两向滞后到越过阈值很远):
    // ①RO:盒尺寸变化(三栏拖拽/视口/折叠);②resize:窗口级变化的兜底通道(rAF 去抖);
    // ③CHAT_MAX_EVENT:限宽写入方直发(thread-width 单点,App RO 落 --chat-max 内联值即同步
    //   派发,冒泡至 window)——渲染步冻结时也送达,专治 RO 停摆段;自身 left/top 写回同值
    //   自愈(setGeo 守卫截停)。2026-10-27 技术债轮 I4:原 documentElement 全树
    //   MutationObserver 补丁通道退役(观测「写入后果」改「写入本身」)
    measure();
    // 首载沉降补测(2026-10-28 用户实测:首次加载锚在左上角,加宽才复位)——首帧测量时
    // 顶栏/菜单/字体未定稿,rect 是过渡值;其后滚动口尺寸若不变 RO 不再触发,错锚即滞留。
    // 挂载后数帧+350ms+字体就绪各补测一次(railAnchor 幂等,零尺寸由守卫收起)
    const settleRafs = [2, 5, 9].map(() => requestAnimationFrame(() => measure()));
    // 沉降放行(首亮门):350ms 补测同帧放行首亮——此前测量只养坐标不显示
    const settleTimer = window.setTimeout(() => {
      revealAtRef.current = true;
      measure();
    }, 350);
    void Promise.resolve(document.fonts?.ready).then(() => measure(), () => undefined);
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
    // 通道③直达不经 rAF 去抖:原 MO 微任务语义=渲染步冻结也即到,去抖会退回帧依赖
    const onChatMax = (): void => measure();
    window.addEventListener(CHAT_MAX_EVENT, onChatMax);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener(CHAT_MAX_EVENT, onChatMax);
      if (raf !== 0) cancelAnimationFrame(raf);
      settleRafs.forEach((f) => cancelAnimationFrame(f));
      window.clearTimeout(settleTimer);
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
  /** 当前滚动位置正对的刻度(九轮):视口下缘上 40px 分界——最后一条顶边越线的用户气泡;
   *  scroll rAF 节流单点,加重显色不加长(长度变化只在 hover)。
   *  十二轮半:DOM .entry-user 与刻度序列不再同序同长(纯图/空 md 用户气泡进 DOM 不进刻度),
   *  按 data-entry-key 键寻址——越线的最后一只带键气泡反查刻度序。
   *  2026-11-18 大会话滚动 CPU 轮(用户实测「打开多个会话后滑动 CPU 高」,上千条产品口径):
   *  ①气泡节点表一次收集、按 rows 签名失效——旧实现每滚动帧 querySelectorAll 全表;
   *  ②二分查越线气泡(O(log N) 次盒读,文档序=纵向序)——旧实现逐只 gBCR 严格 O(N)/帧;
   *  ③加亮直改 DOM class,不走 state——旧实现每变一次 activeIdx 整条刻度重渲染(N 按钮+N 预览);
   *  ④80ms 节流 + 尾帧补算:加亮是视觉指示,不需要逐帧。 */
  const activeRef = useRef(-1);
  const tickRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const applyActive = useCallback((idx: number): void => {
    if (activeRef.current === idx) return;
    const prev = tickRefs.current[activeRef.current];
    if (prev !== undefined && prev !== null) prev.classList.remove('active');
    activeRef.current = idx;
    const next = tickRefs.current[idx];
    if (next !== undefined && next !== null) next.classList.add('active');
  }, []);
  // rows 更替(或刻度条重挂)后新按钮无 active 类:按仍有效的旧序号补回(超界归 -1)
  useLayoutEffect(() => {
    if (activeRef.current >= rows.length) activeRef.current = -1;
    const el = tickRefs.current[activeRef.current];
    if (el !== undefined && el !== null) el.classList.add('active');
  }, [rows, show]);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el === null) return;
    if (sideChat === true || rows.length < MIN_USERS) return;
    let raf = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    let lastAt = 0;
    let nodes: Element[] = [];
    let nodesSig = '';
    const collect = (): Element[] => {
      const sig = `${rows.length}:${rows[rows.length - 1]?.key ?? ''}`;
      if (sig === nodesSig && nodes.length > 0 && nodes[0]!.isConnected) return nodes;
      nodesSig = sig;
      nodes = Array.from(el.querySelectorAll('.entry-user[data-entry-key]'));
      return nodes;
    };
    const compute = (): void => {
      lastAt = performance.now();
      // 模型反查优先(入参=内容坐标):视口下缘所属轮与挂载无关,永不断档
      if (props.activeKeyAt !== undefined) {
        const rect = el.getBoundingClientRect();
        const key = props.activeKeyAt(el.scrollTop + (rect.bottom - 40 - rect.top));
        applyActive(key === null ? -1 : (keyIdx.get(key) ?? -1));
        return;
      }
      const list = collect();
      if (list.length === 0) {
        applyActive(-1);
        return;
      }
      // 判定线=滚动口下缘上 40px(2026-10-28 用户裁定:加粗刻度=「输入框上面那个会话」,
      // 旧 top+120 以视口顶为准,与尾随阅读位不符);取线上最后一只带键气泡反查刻度序
      const line = el.getBoundingClientRect().bottom - 40;
      let lo = 0;
      let hi = list.length - 1;
      let hit = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid]!.getBoundingClientRect().top <= line) {
          hit = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      applyActive(hit < 0 ? -1 : (keyIdx.get(list[hit]!.getAttribute('data-entry-key') ?? '') ?? -1));
    };
    const onScroll = (): void => {
      // 隐藏态(辅助对话/消息不足)不排动画帧:贴底跟随测试以 rAF 计数为不变量面,
      // 且隐藏态无意义;可见性随 rows.length 变化由 effect 依赖重跑承接
      if (raf !== 0 || trailing !== null) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (performance.now() - lastAt < 80) {
          trailing = setTimeout(() => {
            trailing = null;
            compute();
          }, 80);
          return;
        }
        compute();
      });
    };
    compute();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
      if (trailing !== null) clearTimeout(trailing);
    };
  }, [chatScrollRef, rows, keyIdx, sideChat, applyActive]);

  // 辅助对话/<2 条用户消息/余量不足放不下变长刻度:整条不渲染(用户裁定)
  if (sideChat === true || rows.length < MIN_USERS || !show) return <></>;


  const jump = (index: number): void => {
    const el = chatScrollRef.current;
    if (el === null) return;
    // 键寻址(十二轮半):DOM 用户气泡集 ⊇ 刻度序列(纯图/空 md 进 DOM 不进刻度),按序号
    // 反查会错位——按 data-entry-key 直取目标气泡
    const target = rows[index];
    if (target === undefined) return;
    let node = el.querySelector(`.entry-user[data-entry-key="${CSS.escape(target.key)}"]`);
    if (node === null) {
      // 未挂载条目(刻度全量、挂载窗/虚拟窗口未覆盖):先扩窗并落模型坐标(虚拟窗口下滚动事件
      // 驱动切片重算),块序列/切片落定后节点才出现——有界 rAF 轮询(≤90 帧)再落点收敛;
      // 旧实现只给扩窗返回值 true 的路径重试,跨窗跳转(返回 false)会直接放弃
      if (onReveal === undefined) return;
      onReveal(target.key);
      let tries = 0;
      const seek = (): void => {
        const n2 = el.querySelector(`.entry-user[data-entry-key="${CSS.escape(target.key)}"]`);
        if (n2 === null) {
          tries += 1;
          if (tries < 90) requestAnimationFrame(seek);
          return;
        }
        el.scrollTop += n2.getBoundingClientRect().top - el.getBoundingClientRect().top;
        rAFConverge(el, () => n2.getBoundingClientRect().top - el.getBoundingClientRect().top, (d) => { el.scrollTop += d; }, 2);
      };
      requestAnimationFrame(seek);
      return;
    }
    // 落点要准(用户裁定,不要平滑滑动):.entry 挂 content-visibility:auto,离屏条目
    // 只有估算高(contain-intrinsic-size),scrollIntoView 一次到位按估算高算滚动量必落偏——
    // 即时跳到位后按目标真实盒位置迭代校正;上方条目陆续水合会把目标继续推偏,迭代骨架
    // =ui-util rAFConverge 单点(eps=2,150 帧封顶:24 帧封顶实测残差 87px,级联未停循环已退役)
    el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top;
    rAFConverge(
      el,
      () => node.getBoundingClientRect().top - el.getBoundingClientRect().top,
      (delta) => {
        el.scrollTop += delta;
      },
      2,
    );
  };

  return (
    <div className="sx-rail" aria-hidden="true">
      {/* 贴滚动口左缘+中线:fixed 锚实测 x/中线 y 直写 style(测量同帧落位;translateY(-50%) 落中线)。
          挂载即锚(ref 回调):show 已亮期间 users<2→≥2 跨渲染门阈值时 inner 首次挂载,而 [show]
          布局效应不重跑——此前坐标从未写入,fixed 落静态位置=内容左缘顶部(2026-11-07 用户报障
          「运行中生成第二用户气泡产生刻度时出现在左上角」) */}
      <div
        ref={(el) => {
          innerRef.current = el;
          const sc = chatScrollRef.current;
          if (el !== null && sc !== null) {
            const a = railAnchor(sc);
            if (a !== null) {
              el.style.left = `${a.left}px`;
              el.style.top = `${a.top}px`;
            }
          }
        }}
        className="sx-rail-inner"
        role="navigation"
        aria-label={t('Session outline rail', '会话刻度导航')}
      >
        <div className="sx-rail-list">
          {rows.map((r, i) => (
            <button
              key={r.key}
              ref={(el) => {
                tickRefs.current[i] = el;
              }}
              type="button"
              className="sx-rail-tick"
              aria-label={t(`Message ${i + 1}`, `第 ${i + 1} 条消息`)}
              onClick={() => jump(i)}
            >
              {/* hover 预览卡内容(2026-10-31 用户裁定改版:仅 hover 文字内容变)——前段=用户输入
                  (亮色,2 行封顶),后段=该轮回复正文(暗色,2 行封顶),各自 line-clamp 多余省略 */}
              <span className="sx-rail-preview">
                <span className="sx-rail-pv-user">{r.pv}</span>
                {r.reply !== undefined && <span className="sx-rail-pv-reply">{r.reply}</span>}
              </span>
              <span className="sx-rail-bar" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

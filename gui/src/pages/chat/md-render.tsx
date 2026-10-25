import { memo, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Copy, Maximize2, Square, WrapText } from 'lucide-react';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { t } from '../../i18n';
import { highlightByLang } from '../../highlight';
import { zoomScale } from '../../ui-zoom';
import { openExternalUrl } from '../../ui-util';
import { Mermaid } from '../../Mermaid';
import { FileIcon } from '../../file-icon';
import { useCopyFeedback } from '../../use-copy-feedback';
import { TipButton } from './RunFooter';

/** md 渲染插件单点(2026-10-25 用户报障「数学公式没有渲染」):gfm+math/katex 全管线统一——
 *  全部 ReactMarkdown 消费面(正文/气泡/尾块/技能体/计划卡/Files/agent 转录)共用同一引用
 *  (数组身份恒定,memo 内面比较不破)。行内 $...$ 与块级 $$...$$ 经 rehype-katex 出 KaTeX */
export const MD_REMARK_PLUGINS = [remarkGfm, remarkMath];
export const MD_REHYPE_PLUGINS = [rehypeKatex];

/** md 渲染域（D32 批C-5 拆分自 Chat.tsx）：链接放行/无链接组件面单例/文件 token 显形名/
 *  用户气泡与通用 md 组件工厂/代码块卡/Mermaid 容器（lightbox 缩放平移）。Files 页与
 *  chat/EntryViews 经 Chat 原路径再导出消费。行为零变化（Chat.test/files.test 为锚）。 */

/** G14.124 文件链接放行:react-markdown 缺省 urlTransform 剥非 web 协议(C:/… 全灭)——
 *  md 链接口径要求 href 原样抵达 a 覆写(file 链接渲染为 span 不产 <a href>,无注入面) */
export const keepUrl = (url: string): string => url;

/** G14.121 无链接版组件面(导出共享——Files 页 md 预览复用:mermaid/代码块/表格同源) */
export const mdComponentsPlain = buildMdComponents(() => undefined);

/** G14.121 文件 token 显形名:绝对/相对路径一律显末段文件名(全路径进 title 悬浮) */
function tokenDisplayName(p: string): string {
  return p.split(/[\\/]/).filter((s) => s.length > 0).pop() ?? p;
}

/** 目录判定上下文(Chat 注入会话级解析:记账表/工作区索引的尾斜杠内部标记):md 链接面据此把
 *  目录 href 渲染成黄目录;缺省恒 false=文件口径(Files 预览/代理转录无会话索引,回落文件面) */
export const DirResolverContext = createContext<(p: string) => boolean>(() => false);

/** 目录判定便捷 hook(md 工厂消费面):取上下文解析器(引用恒稳,memo 不破) */
export function useDirResolver(): (p: string) => boolean {
  return useContext(DirResolverContext);
}

/** G14.125 用户气泡组件面:标准 md 链接文件化(a 覆写,onOpenFile 在场才可点;web 新窗)——
 *  非标引用(@token code/裸路径)不做文件渲染(G14.125 去兼容),保持通用 chip 原样;
 *  isDir=目录解析(目录引用链接显黄目录,undefined=全按文件) */
export function buildUserMdComponents(onOpenFile: ((p: string) => void) | undefined, isDir?: (p: string) => boolean): Record<string, (props: { children?: ReactNode; className?: string }) => JSX.Element> {
  return {
    ...mdComponentsPlain,
    // G14.124/125 用户气泡同款 md 链接文件化(onOpenFile 在场才可点;web 链接 2026-10-25 起
    // 点击走系统默认浏览器——与正文链接同拦截,Electron 内默认行为是开自家子窗)
    a(props: { href?: string; children?: ReactNode }) {
      const href = props.href ?? '';
      if (onOpenFile === undefined || href === '' || /^(mailto:|#)/i.test(href)) return <a href={href}>{props.children}</a>;
      if (/^(https?:|\/\/)/i.test(href)) {
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openExternalUrl(href);
            }}
          >
            {props.children}
          </a>
        );
      }
      return (
        <span
          role="button"
          tabIndex={0}
          className="file-link"
          data-tip={href}
          onClick={(e) => {
            e.stopPropagation();
            onOpenFile(href);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation();
              onOpenFile(href);
            }
          }}
        >
          <FileIcon path={href} folder={isDir?.(href)} />
          <span className="file-link-name">{tokenDisplayName(href)}</span>
        </span>
      );
    },
  };
}

/** G14.125 md 组件面工厂(导出——Files 页 md 预览复用,传各自 onOpenFile):pre 分流
 *  (mermaid 围栏→Mermaid 懒加载/失败回落,其余围栏→CodeBlock hljs+头部)+ table 横滚 +
 *  md 原生超链接文件化(G14.124:非 web href=文件路径 → icon+文件名 file-link,点击开侧栏;
 *  web 链接新窗 <a>;非标准 md 引用——裸路径/代码形态 token——不做文件渲染,G14.125 去兼容);
 *  isDir=目录解析(目录 href 显黄目录,缺省全按文件) */
export function buildMdComponents(onOpenFile: (p: string) => void, isDir?: (p: string) => boolean): Record<string, (props: { children?: ReactNode }) => JSX.Element> {
  return {
    pre(props: { children?: ReactNode }) {
      const child = Array.isArray(props.children) ? props.children[0] : props.children;
      const el = child as { props?: { className?: string; children?: unknown } } | null;
      const cls = el?.props?.className ?? '';
      const raw = el?.props?.children;
      // react-markdown 保留围栏末行换行(value 尾随 \n)——剥掉一个尾换行,复制面/高亮面拿净代码
      const code = (typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(String).join('') : String(raw ?? '')).replace(/\r?\n$/, '');
      if (cls.includes('language-mermaid')) return <MermaidBlock chart={code} />;
      const m = /language-([\w-]+)/.exec(cls);
      return <CodeBlock code={code} lang={m?.[1]} />;
    },
    table(props: { children?: ReactNode }) {
      return (
        <div className="table-wrap">
          <table>{props.children}</table>
        </div>
      );
    },
    // G14.124 md 原生超链接 → 文件引用:非 web 协议 href 视为文件路径,渲染 icon+文件名
    // (token 同款 file-link),点击/回车开侧栏 file 标签;web 链接 2026-10-25 起点击走系统
    // 默认浏览器(preventDefault+openExternalUrl——Electron 内默认行为是开自家子窗)
    a(props: { href?: string; children?: ReactNode }) {
      const href = props.href ?? '';
      if (href === '' || /^(mailto:|#)/i.test(href)) return <a href={href}>{props.children}</a>;
      if (/^(https?:|\/\/)/i.test(href)) {
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openExternalUrl(href);
            }}
          >
            {props.children}
          </a>
        );
      }
      return (
        <span
          role="button"
          tabIndex={0}
          className="file-link"
          data-tip={href}
          onClick={(e) => {
            e.stopPropagation();
            onOpenFile(href);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation();
              onOpenFile(href);
            }
          }}
        >
          <FileIcon path={href} folder={isDir?.(href)} />
          <span className="file-link-name">{tokenDisplayName(href)}</span>
        </span>
      );
    },
  };
}

/** 代码块卡(G11 §5.2):surface-code 面+头部栏(语言名+复制钮 hover 浮现)+hljs 高亮;
 *  代码禁折行(white-space:pre+横滚)——排版错乱主因即旧版强折行。memo 按 code+lang,
 *  流式增量帧仅末块重算 */
const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang?: string }): JSX.Element {
  // G14.205 自动换行切换:默认横向滚动,开启后 pre-wrap 纵向排布(无横向滚动条)
  const [wrap, setWrap] = useState(false);
  const { status, copy } = useCopyFeedback();
  const html = useMemo(() => highlightByLang(code, lang), [code, lang]);
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang ?? ''}</span>
        <span className="code-head-actions">
          <TipButton
            className="sx-tip-right"
            tip={wrap ? t('Overflow scroll', '横向滚动') : t('Wrap long lines', '自动换行')}
            label="toggle code wrap"
            icon={<WrapText size={12} strokeWidth={1.75} aria-hidden="true" className={wrap ? 'code-wrap-on' : undefined} />}
            onClick={() => setWrap((v) => !v)}
          />
          <TipButton
            className="sx-tip-right"
            tip={status === 'ok' ? t('Copied', '已复制') : t('Copy', '复制')}
            label="copy code"
            icon={status === 'ok' ? <Check size={12} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => copy(code)}
          />
        </span>
      </div>
      <pre className={wrap ? 'wrap' : undefined}>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
});

/** Mermaid 容器(G11 §5.4):hover 显放大/复制钮;放大=lightbox(遮罩 contain 居中,点击/Esc 关,
 *  Esc 监听随开关挂卸);复制=源码。回落态(fallback/pending)两钮同样在场——降级不失功能。
 *  G14.122:渲染失败 → 放大钮收起(浮层只属成功图);浮层内容=克隆已渲 SVG(不二次渲染,
 *  免 concurrent render 空白);浮层面板下移缩窄,不遮标签条钮
 *  G14.2xx 视图手感:拖动钳制(内容恒不全丢)、滚轮绕指针缩放、按钮绕视心缩放(不跳) */
export function MermaidBlock({ chart, onNodeClick }: { chart: string; onNodeClick?: (nodeId: string) => void }): JSX.Element {
  const [zoom, setZoom] = useState(false);
  /** 渲染成败(null=在途):false 即收放大钮 */
  const [renderOk, setRenderOk] = useState<boolean | null>(null);
  /** 2026-10-25 错误文案(Mermaid 上抛,展示面不變):在场时复制钮=报错+源码同复制(此前报错不可复制) */
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /** G14.2xx 复制回显:useCopyFeedback 单点——图标换 ✓ + tooltip 变「已复制」,1.5s 自回 */
  const { status, copy: copyChart } = useCopyFeedback();
  // G14.107 lightbox 视图态:缩放(s)/平移(x,y);滚轮缩放+拖动平移+按钮组(+ % − [] X)
  const [view, setView] = useState({ x: 0, y: 0, s: 1 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  /** G14.213 节点点击绑定(消费方语义,如任务 DAG 跳子智能体):内联渲染落定与 lightbox 克隆后各绑一次 */
  const bindNodes = (root: HTMLElement | null): void => {
    if (root === null || onNodeClick === undefined) return;
    for (const g of Array.from(root.querySelectorAll('g.node'))) {
      const nodeId = g.getAttribute('data-id') ?? g.id.replace(/^flowchart-/, '').replace(/-\d+$/, '');
      if (nodeId === '') continue;
      (g as HTMLElement).style.cursor = onNodeClick !== undefined ? 'pointer' : '';
      g.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onNodeClick(nodeId);
      });
    }
  };
  /** G14.122 SVG 克隆源/宿:开盒把行内已渲 SVG 拷进浮层(轻秒开,无重渲竞态);
   *  baseRef=100% 基准尺寸(克隆时刻实测)——G14.123 真矢量缩放的参照 */
  const inlineRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const baseRef = useRef<{ w: number; h: number } | null>(null);
  /** G14.2xx 平移钳制:内容与面板每轴恒有 ≥56 本地 px 交集——图拖不出可视区
   *  (修「拖动后被截断/原始边框外没有渲染」:此前无界,图可整个拖出面板变全空) */
  const clampView = (v: { x: number; y: number; s: number }): { x: number; y: number; s: number } => {
    const body = bodyRef.current;
    const base = baseRef.current;
    if (body === null || base === null) return v;
    const z = zoomScale();
    const panelW = body.getBoundingClientRect().width / z / 2;
    const panelH = body.getBoundingClientRect().height / z / 2;
    const m = 56;
    const axis = (pos: number, half: number, panel: number): number => {
      const lo = m - panel - half;
      const hi = panel - m + half;
      if (lo > hi) return 0; // 极限小窗:居中
      return Math.min(hi, Math.max(lo, pos));
    };
    return { x: axis(v.x, (base.w * v.s) / 2, panelW), y: axis(v.y, (base.h * v.s) / 2, panelH), s: v.s };
  };
  /** G14.2xx 缩放:按钮(focal 缺省)绕当前视心——拖身后 +/− 不再跳回面板中心;
   *  滚轮(focal=指针面板本地坐标)绕指针定针——正在看的位置保持不动 */
  const zoomAt = (factor: number, focal?: { x: number; y: number }): void => {
    setView((v) => {
      const s1 = Math.min(8, Math.max(0.2, Math.round(v.s * factor * 100) / 100));
      if (s1 === v.s) return v;
      const k = s1 / v.s;
      return clampView({
        x: focal === undefined ? v.x * k : focal.x + (v.x - focal.x) * k,
        y: focal === undefined ? v.y * k : focal.y + (v.y - focal.y) * k,
        s: s1,
      });
    });
  };
  const zoomAtRef = useRef(zoomAt);
  zoomAtRef.current = zoomAt; // 滚轮原生监听取最新(组件体内函数每渲染换身份)
  useEffect(() => {
    if (zoom) setView({ x: 0, y: 0, s: 1 }); // 开盒复位
  }, [zoom]);
  useEffect(() => {
    if (renderOk !== true) return;
    const t = setTimeout(() => bindNodes(inlineRef.current), 0); // G14.213 内联渲染落定即绑节点点击
    return () => clearTimeout(t);
  }, [renderOk]);
  useEffect(() => {
    if (zoom && panRef.current !== null && inlineRef.current !== null) {
      panRef.current.innerHTML = inlineRef.current.innerHTML;
      const svg = panRef.current.querySelector('svg');
      if (svg !== null) {
        const r = svg.getBoundingClientRect();
        baseRef.current = { w: r.width / zoomScale(), h: r.height / zoomScale() }; // 视觉→本地(svg 宽高写本地)
      }
      bindNodes(panRef.current); // G14.213 克隆面节点点击重绑(innerHTML 克隆不带监听)
    }
  }, [zoom, renderOk]);
  // G14.123 真矢量缩放:缩放改写 svg 布局宽高(viewBox 按档重排,逐档锐利),transform 只承担平移
  useEffect(() => {
    const svg = panRef.current?.querySelector('svg') ?? null;
    const base = baseRef.current;
    if (svg === null || base === null) return;
    svg.style.maxWidth = 'none';
    svg.style.maxHeight = 'none';
    svg.style.width = `${Math.round(base.w * view.s * 100) / 100}px`;
    svg.style.height = `${Math.round(base.h * view.s * 100) / 100}px`;
  }, [view.s, zoom, renderOk]);
  useEffect(() => {
    if (!zoom) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setZoom(false);
    };
    const onMove = (ev: MouseEvent): void => {
      const d = dragRef.current;
      if (d === null) return;
      // client 增量是视觉 px,view.x/y 写本地 transform=视觉/根放缩(ui-zoom.ts 契约)
      setView((v) => clampView({ ...v, x: d.ox + (ev.clientX - d.sx) / zoomScale(), y: d.oy + (ev.clientY - d.sy) / zoomScale() }));
    };
    const onUp = (): void => {
      dragRef.current = null;
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [zoom]);
  // G14.2xx 滚轮缩放挂原生非被动监听:preventDefault 挡背景聊天流跟滚(lightbox 在 .chat
  // 滚动祖先内),focal=指针位置绕点缩放
  useEffect(() => {
    if (!zoom) return;
    const el = bodyRef.current;
    if (el === null) return;
    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const z = zoomScale();
      zoomAtRef.current(ev.deltaY < 0 ? 1.15 : 1 / 1.15, {
        x: (ev.clientX - r.left) / z - r.width / (2 * z),
        y: (ev.clientY - r.top) / z - r.height / (2 * z),
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom]);
  return (
    <div className="mermaid-block">
      <div ref={inlineRef} className="mermaid-inline">
        <Mermaid
          chart={chart}
          onStatus={(ok, msg) => {
            setRenderOk(ok);
            setErrorMsg(ok ? null : (msg ?? null)); // 成功即清(流式静默路径无 msg,不误存)
          }}
        />
      </div>
      <div className="mermaid-actions">
        {renderOk !== false && (
          <TipButton className="sx-tip-right" tip={t('Zoom', '放大')} label="zoom mermaid" icon={<Maximize2 size={12} strokeWidth={1.75} aria-hidden="true" />} onClick={() => setZoom(true)} />
        )}
        <TipButton
          className="sx-tip-right"
          tip={status === 'ok' ? t('Copied', '已复制') : t('Copy', '复制')}
          label="copy mermaid"
          icon={status === 'ok' ? <Check size={12} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
          onClick={() => copyChart(errorMsg !== null ? `${errorMsg}\n\n${chart}` : chart)}
        />
      </div>
      {zoom && (
        <div
          className="mermaid-lightbox"
          role="dialog"
          aria-label={t('Mermaid preview', 'Mermaid 预览')}
          onClick={() => setZoom(false)}
        >
          {/* 拖动平移:svg wrapper 上 mousedown 捕获,window move/up 驱动(钳制在 clampView);
              滚轮缩放=原生非被动监听挂 body(绕指针);内容=克隆 SVG(G14.122,开盒时 useEffect 填充);
              动作钮随体(不遮标签条) */}
          <div
            ref={bodyRef}
            className="mermaid-lightbox-body"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => {
              dragRef.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
            }}
          >
            <div className="mermaid-lb-actions" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
              <button type="button" aria-label={t('Zoom out', '缩小')} onClick={() => zoomAt(1 / 1.2)}>−</button>
              {/* G14.117 缩放百分比(− + 之间);方框钮=复位视图 */}
              <span className="mermaid-lb-zoom">{Math.round(view.s * 100)}%</span>
              <button type="button" aria-label={t('Zoom in', '放大')} onClick={() => zoomAt(1.2)}>+</button>
              <button type="button" aria-label={t('Reset view', '复位')} onClick={() => setView({ x: 0, y: 0, s: 1 })}>
                <Square size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button type="button" aria-label={t('Close', '关闭')} onClick={() => setZoom(false)}>✕</button>
            </div>
            <div
              ref={panRef}
              className="mermaid-lb-pan"
              style={{ transform: `translate(${view.x}px, ${view.y}px)`, cursor: dragRef.current !== null ? 'grabbing' : 'grab' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Editor } from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import { Check, ChevronRight, CodeXml, Copy, Eye, ExternalLink, MoreHorizontal, WrapText } from 'lucide-react';
import type { Connection } from '../connection';
import type { FileResp } from '../connection';
import { zoomScale } from '../ui-zoom';
import { monacoLangOf, useSxTheme } from '../monaco-setup';
import { monacoCodeFontOptions } from '../font-preset';
import { t } from '../i18n';
import { FileIcon } from '../file-icon';
import { isAbsPath, normRel, OPEN_DEFAULT_KEY } from '../ui-util';
import { MdImageContext } from './chat/md-render';
import { useCopyFeedback } from '../use-copy-feedback';
import { SessionRowMenu } from '../sidebar/session-row-menu';
import { buildMdComponents, keepUrl, MD_REHYPE_PLUGINS, MD_REMARK_PLUGINS } from './Chat';

/**
 * G6 Files 页（会话内文件只读预览）——G14.5 起 VSCode 形态（用户裁定）：**顶部文件路径面包屑**
 * （逐级段名+分隔符，免路径图标——图标只保留在气泡/正文引用面）+ **Monaco 只读源码视图**（原生行号/高亮/主题跟随）。
 * 无常驻输入行/加载钮（加载入口=目录树点击/工具行/Diff 跳转，均经 initialPath 自动加载）；
 * 裸开档（+菜单「文件」无路径）示空态引导+路径输入（Enter/加载钮，仅空态/错误态在场）。
 * G7 请求序守卫保持：requestIdRef 单调发号，慢旧应答不覆写。
 * G14.119 面包屑工作区锚点（root 注入）：区内文件锚到工作区目录名显相对路径。
 * G14.121 md 预览：右上悬浮 眼睛/复制 钮——眼睛切格式化渲染，再点 </> 回源码；复制写原文剪贴板。
 * G14.125 md 内标准超链接跳内部文件标签页（不开浏览器页）：href 相对当前 md 所在目录解析，
 * web 链接仍新窗浏览器。
 */

export interface FilesProps {
  conn: Connection;
  /** 当前会话（:id 寻址维） */
  sessionId: string;
  /** 到场自动加载的路径（跳转注入；undefined = 空态待选） */
  initialPath?: string;
  /** 工作区根（G14.119 面包屑锚点）：区内文件锚到工作区目录名显相对路径，区外才显绝对路径 */
  root?: string;
  /** md 预览内链点击（G14.125）：href 已解析为绝对路径，App 注入开 file 标签 */
  onOpenFile?: (path: string) => void;
  /** G14.2xx 目录路径移交(输入目录 → 目录页签定位展开;undefined = 宿主不支持) */
  /** G14.154 选区「在辅助对话中提问」：携带 @引用 文本,App 注入 fork+开辅助标签 */
  onSideAsk?: (insert: string) => void;
}

/** 一次加载的三态：file=成功面（含 truncated 标）；error=失败面（HTTP 错误消息）；loading 在途 */
interface LoadState {
  file: FileResp | null;
  error: string | null;
  loading: boolean;
}

const EMPTY_LOAD: LoadState = { file: null, error: null, loading: false };

/** G14.119 面包屑分段：path 在工作区内 → [工作区目录名, ...相对段]；区外 → 绝对段（原样）。
 *  win/posix 双分隔归一后再比对（daemon 回路径分隔符随平台）。 */
function breadcrumbSegments(path: string, root: string | undefined): string[] {
  const norm = path.replace(/\\/g, '/');
  if (root !== undefined && root !== '') {
    const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm === rootNorm || norm.startsWith(rootNorm + '/')) {
      const ws = rootNorm.split('/').filter(Boolean).pop() ?? rootNorm;
      return [ws, ...norm.slice(rootNorm.length + 1).split('/').filter(Boolean)];
    }
  }
  return norm.split('/').filter(Boolean);
}

/** G14.125 md 内相对 href → 绝对路径（相对当前 md 所在目录解析，支持 ./ 与 ../；绝对 href 原样） */
function resolveHref(mdPath: string, href: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(href) || href.startsWith('/')) return href;
  const dir = mdPath.replace(/\\/g, '/').slice(0, Math.max(mdPath.lastIndexOf('/'), 0));
  const out: string[] = [];
  for (const seg of `${dir}/${href}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export function Files({ conn, sessionId, initialPath, root, onOpenFile, onSideAsk }: FilesProps): JSX.Element {
  const [load, setLoad] = useState<LoadState>(EMPTY_LOAD);
  /** G7 请求序守卫：发号单调节点——发请求 ++,应答落定时号不匹配即过期丢弃 */
  const requestIdRef = useRef(0);
  const theme = useSxTheme();
  /** G14.121 md 格式化预览态（换路径/换文件即回源码） */
  const [preview, setPreview] = useState(false);
  const { status: copied, copy: writeCopy } = useCopyFeedback();
  /** G14.2xx 自动换行(正文代码块同款交互):源码视图默认横向滚动,开启后 wordWrap 纵向排布(无横向滚动条) */
  const [wrap, setWrap] = useState(false);
  /** 2026-10-27 用户裁定:路径行右侧 ⋯ 菜单(复制相对/绝对路径)+外部打开钮(应用=左侧选中方式) */
  const [pathMenu, setPathMenu] = useState<{ x: number; y: number } | null>(null);
  const [pathCopied, setPathCopied] = useState('');
  const pathCopiedTimer = useRef<number | null>(null);
  const copyPath = (text: string, tag: string): void => {
    void navigator.clipboard?.writeText(text).then(() => setPathCopied(tag), () => setPathCopied(''));
    // 连续复制防叠跑:前一次的归位 timer 先清(不清则提前掐掉后一次的 ✓ 尾标)
    if (pathCopiedTimer.current !== null) clearTimeout(pathCopiedTimer.current);
    pathCopiedTimer.current = window.setTimeout(() => setPathCopied(''), 1500);
  };
  const relOf = (): string => {
    const p = (load.file?.path ?? '').replace(/\\/g, '/');
    const rn = (root ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (rn !== '' && p.startsWith(rn + '/')) return p.slice(rn.length + 1);
    return p;
  };
  /** 2026-10-27 用户裁定:外部打开=打开当前文件本体(非工作区根;explorer 打开其所在位置,
   *  Code/Cursor 等编辑器直接开文件)。失败可见化:load.error 面承接(文件已删/应用探测后被
   *  卸载的 spawn 失败走 daemon 侧 error 事件,HTTP 面可能仍 200——此处只接 HTTP 拒绝面) */
  const openExternally = (): void => {
    const target = load.file?.path ?? '';
    if (target === '') return;
    void conn
      .openInEditor(target, localStorage.getItem(OPEN_DEFAULT_KEY) ?? 'explorer')
      .catch((err: unknown) => setLoad((prev) => ({ ...prev, error: err instanceof Error ? err.message : String(err) })));
  };

  /** G14.139 选区加引用:Monaco 实例/当前文件/选区信息 ref(回调闭包免陈旧)+悬浮钮显隐 */
  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null);
  const filePathRef = useRef<string>('');
  filePathRef.current = load.file?.path ?? '';
  const rootRef = useRef(root);
  rootRef.current = root;
  /** G14.211 选区载荷=rel+行锚(两种显形派生:短写 @文件名:L 进当前任务[账本解析],全路径 @rel:L 进辅助对话) */
  const selRef = useRef<{ rel: string; lines: string } | null>(null);
  const selRangeRef = useRef<{ line: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** G14.154 悬浮工具条状态(绝对定位 React 面,跟随选区;弃 monaco overlay——其位置不随选区重算) */
  const [selBar, setSelBar] = useState<{ top: number; left: number; rel: string; lines: string } | null>(null);
  /** Monaco RO 同帧 layout(2026-10-29 果冻残余根修):RO 句柄随编辑器卸载断开 */
  const monoRoRef = useRef<ResizeObserver | null>(null);
  useEffect(() => () => {
    editorRef.current = null;
    monoRoRef.current?.disconnect();
    monoRoRef.current = null;
  }, []);
  // 字体预设热更:Monaco 数字面只在挂载取一次,切换预设须 updateOptions(字族/字号/行高)
  useEffect(() => {
    const apply = (): void => {
      editorRef.current?.updateOptions(monacoCodeFontOptions());
    };
    window.addEventListener('sunshinex:font-preset', apply);
    return () => window.removeEventListener('sunshinex:font-preset', apply);
  }, []);

  /** 加载单点：trim 空 no-op；请求期间保留旧文（切换不闪空）,失败倒错误态不静默 */
  /** 文件读取单点(2026-10-27 欢迎页全局草稿):无会话(欢迎页草稿座)走 /app/file(root 信任域),
   *  有会话走既有 /session/:id/file */
  const readFileOf = useCallback(
    (p: string): Promise<FileResp> => (sessionId === '' ? conn.appFile(root ?? '', p) : conn.readFile(sessionId, p)),
    [conn, sessionId, root],
  );
  const fetchFile = useCallback(
    (p: string): void => {
      // 绝对路径原样(跨项目树开签);相对才走 normRel——避免 posix /ws/… 被剥头成相对 404
      const target = isAbsPath(p) ? p.trim() : normRel(p);
      if (target === '') return;
      const rid = ++requestIdRef.current;
      setLoad((prev) => ({ file: prev.file, error: null, loading: true }));
      void readFileOf(target).then(
        (f) => {
          if (rid !== requestIdRef.current) return; // 过期应答:丢弃
          if (f.type === 'directory') {
            // 目录无预览(directory 页签已退役):回落空态;有 onOpenFile 则尾斜杠回抛→App 左侧树/外开
            setLoad(EMPTY_LOAD);
            if (onOpenFile !== undefined) {
              onOpenFile(/[\\/]$/.test(target) ? target : `${target}/`);
            }
            return;
          }
          setLoad({ file: f, error: null, loading: false });
        },
        (err: unknown) => {
          if (rid !== requestIdRef.current) return; // 过期应答:丢弃
          setLoad({ file: null, error: err instanceof Error ? err.message : String(err), loading: false });
        },
      );
    },
    [readFileOf, onOpenFile],
  );

  /** initialPath 到场自动加载（跳转面：依赖含 initialPath——已挂载时新跳转同样触发）。
   *  2026-10-26 keep-alive 去重:同路径不重拉——keep-alive 下隐藏标签随上游回调身份变化
   *  重渲染,无去重即 fetch 风暴(实测 a.ts×3);跨实例互不影响(ref 为实例私有) */
  const lastFetchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialPath === undefined || initialPath === '') return;
    if (lastFetchedRef.current === initialPath) return;
    lastFetchedRef.current = initialPath;
    fetchFile(initialPath);
  }, [initialPath, fetchFile]);

  // 磁盘变更感知(2026-11-13 用户裁定「侧栏页签打开的文件,磁盘改了要刷新到」):3s 轮询现路径,
  // 内容(dataURL/文本)与现显不同才落态——预览面只读零输入态可丢;过期应答守卫沿用 requestIdRef
  // (readFileOf 单点口径,会话/欢迎页两态同享);轮询失败静默(文件暂不可读不顶掉现有内容)
  const diskWatchPath = load.file?.path;
  useEffect(() => {
    if (diskWatchPath === undefined || diskWatchPath === '') return;
    const timer = window.setInterval(() => {
      // 应用不可见/页签非活动时不轮询(2026-11-13「多页签+多会话卡顿」):keep-alive 下 N 个
      // 文件页签各 1 次/3s 请求会叠加;回窗即续,最多延迟一个周期
      if (document.visibilityState !== 'visible') return;
      const rid = ++requestIdRef.current; // 与用户切换同一守卫:在途轮询被新请求(切换/重载)作废
      void readFileOf(diskWatchPath).then(
        (f) => {
          if (f.type === 'directory') return;
          if (rid !== requestIdRef.current) return; // 过期应答:丢弃
          setLoad((prev) => (prev.file !== null && prev.file.path === f.path && prev.file.content === f.content && prev.file.data === f.data ? prev : { file: f, error: null, loading: false }));
        },
        () => undefined,
      );
    }, 3000);
    return () => window.clearInterval(timer);
  }, [diskWatchPath, readFileOf]);

  // G14.121 换文件即回源码形态(预览态不跨文件延续)
  useEffect(() => {
    setPreview(false);
  }, [load.file?.path]);

  const segments = load.file !== null ? breadcrumbSegments(load.file.path, root) : [];
  const isMd = load.file !== null && /\.md$/i.test(load.file.path);
  /** 2026-10-26 侧栏预览:图片扩展名(type=image 载荷)→ dataURL 直显替代源码视图 */
  const isImage = load.file !== null && load.file.type === 'image' && typeof load.file.mime === 'string' && typeof load.file.data === 'string';
  /** G14.125 预览组件面:md 内标准超链接按当前 md 目录解析为绝对路径后开内部 file 标签 */
  /** 2026-10-26 正文 md 图片同口径:md 预览里图片语法的工作区路径经 readFile 解析直显 */
  const mdImageLoader = useCallback(
    (p: string) => readFileOf(p),
    [conn, sessionId],
  );
  const previewComponents = useMemo(
    () =>
      buildMdComponents((href) => {
        if (onOpenFile === undefined || load.file === null) return;
        onOpenFile(resolveHref(load.file.path, href));
      }),
    [onOpenFile, load.file?.path],
  );
  const copyContent = (): void => {
    if (load.file === null) return;
    writeCopy(load.file.content);
  };

  return (
    <div className="files" aria-label="files">
      {load.file !== null ? (
        <>
          {/* 顶部文件路径面包屑(VSCode 同形)+右上悬浮动作(md=预览切换+复制;hover 显形) */}
          <div className="files-head">
            <div className="files-breadcrumb" aria-label="file path">
              {segments.map((seg, i) => (
                <span key={`${seg}:${i}`} className="files-crumb">
                  {i > 0 && <ChevronRight size={14} strokeWidth={1.75} className="files-crumb-sep" aria-hidden="true" />}
                  {/* 2026-11-04 用户裁定:末段文件名前补回文件图标(面包屑曾一度丢失) */}
                  {i === segments.length - 1 && i > 0 && load.file !== null && (
                    <span className="files-crumb-ico" aria-hidden="true">
                      <FileIcon path={load.file.path} />
                    </span>
                  )}
                  <span className={i === segments.length - 1 ? 'files-crumb-name' : 'files-crumb-seg'}>{seg}</span>
                </span>
              ))}
            </div>
            <div className="files-head-actions">
              <button
                type="button"
                className="sx-iconbtn"
                aria-label="path actions"
                data-tip={t('Copy path', '复制路径')}
                onClick={(e) => {
                  e.stopPropagation();
                  const b = e.currentTarget.getBoundingClientRect();
                  setPathMenu({ x: b.right, y: b.bottom + 2 });
                }}
              >
                <MoreHorizontal size={14} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="sx-iconbtn"
                aria-label="open externally"
                data-tip={t('Open externally', '外部打开')}
                onClick={openExternally}
              >
                <ExternalLink size={14} strokeWidth={1.75} />
              </button>
            </div>
          </div>
          {pathMenu !== null && load.file !== null && (
            <SessionRowMenu
              x={pathMenu.x}
              y={pathMenu.y}
              onClose={() => setPathMenu(null)}
              items={[
                {
                  id: 'copy-abs',
                  label: t('Copy absolute path', '复制绝对路径'),
                  // 复制反馈=前置复制图标换 ✓(2026-11-09 用户裁定,全局同款)
                  icon: pathCopied === 'abs' ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.75} />,
                  keepOpen: true,
                  onSelect: () => copyPath(load.file!.path, 'abs'),
                },
                {
                  id: 'copy-rel',
                  label: t('Copy relative path', '复制相对路径'),
                  // 复制反馈=前置复制图标换 ✓(2026-11-09 用户裁定,全局同款)
                  icon: pathCopied === 'rel' ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.75} />,
                  keepOpen: true,
                  onSelect: () => copyPath(relOf(), 'rel'),
                },
              ]}
            />
          )}
          {load.file.truncated === true && (
            <div className="files-truncated" role="status">
              {t('File exceeds 512 KB — preview truncated to the first 512 KB', '文件超过 512KB,已截断为首 512KB 预览')}
            </div>
          )}
          <div className="files-body" ref={bodyRef}>
          {/* G14.154 选区悬浮工具条(双动作):跟随选区上方;mousedown 保焦防先卸载 */}
          {selBar !== null && !preview && (
            <div
              className="files-selbar"
              style={{ top: selBar.top, left: Math.max(selBar.left, 8) }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <button
                type="button"
                onClick={() => {
                  // G14.211 短写插入:@文件名:L(芯片短、光标贴);全相对路径随事件入会话侧
                  // pickRelRef 账本,发送期 expandFileRefs 据此展开为完整 md 链接
                  const base = selBar.rel.split(/[\\/]/).pop() ?? selBar.rel;
                  window.dispatchEvent(new CustomEvent('sunshinex:insert-ref', { detail: { text: `@${base}:${selBar.lines}`, rel: selBar.rel } }));
                  setSelBar(null);
                }}
              >
                {t('Add to current task', '添加到当前任务')}
              </button>
              <button
                type="button"
                onClick={() => {
                  // 辅助对话无会话侧账本:保持全路径 token(路径直解析,不依赖记账)
                  onSideAsk?.(`@${selBar.rel}:${selBar.lines}`);
                  setSelBar(null);
                }}
              >
                {t('Ask in side chat', '在辅助对话中提问')}
              </button>
            </div>
          )}
          {/* G14.134 动作钮(预览切换/复制)常驻内容区右上角——不在面包屑行、不靠 hover 显形 */}
            <div className="files-actions">
              {isMd && (
                <button
                  type="button"
                  className="files-act"
                  aria-label={preview ? 'show source' : 'preview markdown'}
                  data-tip={preview ? t('Source', '源码') : t('Preview', '预览')}
                  onClick={() => setPreview((v) => !v)}
                >
                  {preview ? <CodeXml size={14} strokeWidth={1.75} /> : <Eye size={14} strokeWidth={1.75} />}
                </button>
              )}
              {!isMd && !isImage && (
                /* G14.2xx 自动换行钮(正文代码块同款):仅源码视图在场——md 预览本就纵向排布 */
                <button
                  type="button"
                  className="files-act"
                  aria-label={wrap ? 'overflow scroll' : 'toggle word wrap'}
                  data-tip={wrap ? t('Overflow scroll', '横向滚动') : t('Wrap long lines', '自动换行')}
                  onClick={() => setWrap((v) => !v)}
                >
                  <WrapText size={14} strokeWidth={1.75} className={wrap ? 'code-wrap-on' : undefined} />
                </button>
              )}
              {!isImage && (
                <button
                  type="button"
                  className="files-act"
                  aria-label={copied === 'ok' ? 'copied' : 'copy content'}
                  data-tip={copied === 'ok' ? t('Copied', '已复制') : t('Copy', '复制')}
                  onClick={copyContent}
                >
                  {/* 2026-11-06 用户裁定:复制回显与正文代码块同款——点击后图标换 ✓(1.5s 自回),不只 tooltip 变字 */}
                  {copied === 'ok' ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.75} />}
                </button>
              )}
            </div>
            {isImage ? (
              /* 2026-10-26 侧栏预览:棋盘格垫底铺满整个预览区(用户裁定,PS 画布口径),图片视口
                 双向居中其上——透明像素与图片范围由整面棋盘格衬出 */
              <div
                aria-label="file content"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  minHeight: 'calc(100vh - 200px)', padding: 12,
                  backgroundImage: 'conic-gradient(#00000016 0 25%, transparent 0 50%, #00000016 0 75%, transparent 0)',
                  backgroundSize: '16px 16px',
                }}
              >
                <img
                  src={`data:${load.file.mime};base64,${load.file.data}`}
                  alt={load.file.path}
                  loading="lazy"
                  decoding="async"
                  style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 260px)', objectFit: 'contain', display: 'block' }}
                />
              </div>
            ) : preview && isMd ? (
              /* G14.125 md 格式化渲染:mermaid/代码块/表格与正文同源;标准超链接跳内部文件标签
               * (href 相对当前 md 所在目录解析为绝对路径),web 链接新窗浏览器 */
              <div className="files-md" aria-label="file content">
                <MdImageContext.Provider value={mdImageLoader}>
                <ReactMarkdown
                  remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS}
                  urlTransform={keepUrl}
                  components={previewComponents}
                >
                  {load.file.content}
                </ReactMarkdown>
                </MdImageContext.Provider>
              </div>
            ) : (
              <div className="files-editor" aria-label="file content" onContextMenu={(e) => e.preventDefault()}>
                <Editor
                  value={load.file.content}
                  language={monacoLangOf(load.file.path)}
                  theme={theme}
                  onMount={(ed) => {
                    // G14.139/154/158 选区工具条:React 绝对定位面,跟随选区;
                    // 位置=monaco getScrolledVisiblePosition(任意行可用)+编辑器/容器 rect 差换算;
                    // mousedown preventDefault 保选区;双动作:添加到当前任务/在辅助对话中提问
                    editorRef.current = ed;
                    // 右缘缩放布局同步(2026-10-29 用户实测果冻三轮根修):
                    // ①e19e1de 的 RO+120ms 尾沿防抖:连续拖动中定时器每帧重置=拖动全程零重排,恒按
                    //   旧宽绘制(变宽右侧留白带/旧折行溢出多出纵横条/停手一次性 snap)——已出局;
                    // ②RO+rAF 中转:stale 收敛到单帧,但相位差恒在——容器边缘纯 CSS 当帧走,内容
                    //   下一帧才重排,快速拖动内容边缘拖 ~16px 弹性尾——一并出局;
                    // ③本版=RO 回调内同步 layout+强制同步渲染:RO 触发点在当帧布局后、绘制前,
                    //   layout 后再打 View.render(now=true)(_flushAccumulatedAndRenderNow)把新布局
                    //   的文字像素同帧写上 DOM——layout 只管几何,文字本走 Monaco 下一帧 rAF 渲染批
                    //   (边框到位文字晚一帧=拖尾残余),now=true 消掉它。私有路径 _modelData.view 以
                    //   可选链守卫,monaco 升级断链时静默回退渲染批(仅剩一帧拖尾不致错乱);与 monaco
                    //   内建 automaticLayout 相比多补了这刀(内建同样吃渲染批的晚一帧)。首帧即刻 layout
                    ed.layout();
                    const monoRo = new ResizeObserver(() => {
                      if (editorRef.current === null) return; // 卸载守卫(disconnect 后无迟到回调)
                      editorRef.current.layout();
                      (editorRef.current as unknown as {
                        _modelData?: { view?: { render?: (now: boolean, everything: boolean) => void } };
                      })._modelData?.view?.render?.(true, false);
                    });
                    monoRo.observe(ed.getContainerDomNode());
                    monoRoRef.current = monoRo;
                    const hide = (): void => {
                      selRef.current = null;
                      selRangeRef.current = null;
                      setSelBar(null);
                    };
                    const place = (startLine: number): void => {
                      const pos = ed.getScrolledVisiblePosition({ lineNumber: startLine, column: 1 });
                      const dom = ed.getDomNode()?.getBoundingClientRect() ?? null;
                      const body = bodyRef.current?.getBoundingClientRect() ?? null;
                      if (pos === undefined || pos === null || dom === null || body === null) return;
                      // dom/body 是视觉 px(gBCR),pos 是 monaco 本地 px——视觉差除以根放缩再与本地相加(ui-zoom.ts 契约)
                      const z = zoomScale();
                      setSelBar((b) =>
                        b !== null
                          ? { ...b, top: (dom.top - body.top) / z + pos.top - 35, left: Math.max((dom.left - body.left) / z + pos.left, 8) }
                          : b,
                      );
                    };
                    const refresh = (): void => {
                      if (selRangeRef.current === null) return;
                      place(selRangeRef.current.line);
                    };
                    ed.onDidChangeCursorSelection(() => {
                      const sel = ed.getSelection();
                      const model = ed.getModel();
                      const file = filePathRef.current;
                      if (sel === null || model === null || file === '' || !ed.hasTextFocus()) {
                        hide();
                        return;
                      }
                      const text = model.getValueInRange(sel);
                      if (text.trim() === '') {
                        hide();
                        return;
                      }
                      const s = sel.startLineNumber;
                      const e2 = sel.endLineNumber;
                      const lines = s === e2 ? `L${s}` : `L${s}-L${e2}`;
                      // 相对工作区路径(区内),区外回落绝对——与 @ 展开口径一致
                      let rel = file.replace(/\\/g, '/');
                      const rootNorm = (rootRef.current ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
                      if (rootNorm !== '' && rel.startsWith(rootNorm + '/')) rel = rel.slice(rootNorm.length + 1);
                      selRef.current = { rel, lines };
                      selRangeRef.current = { line: s };
                      setSelBar({ rel, lines, top: 0, left: 8 });
                      place(s);
                    });
                    ed.onDidScrollChange(refresh);
                    // G14.152 编辑器失焦即隐藏(点击外部/他标签不再常驻;悬浮条 mousedown 已保焦不受影响)
                    ed.onDidBlurEditorText(hide);
                  }}
                  options={{
                    readOnly: true,
                    contextmenu: false, // G14.60:禁用自带右键菜单(外层拦浏览器菜单);Ctrl+C 系统复制保留
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    lineNumbersMinChars: 3,
                    // 歧义字符横幅退役(2026-11-11 用户裁定「去掉源文件上面的提示」):中文注释即触发,纯噪音
                    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
                    ...monacoCodeFontOptions(), // 字体预设:字号/字族/行高随 --f-code(热更见上)
                    wordWrap: wrap ? 'on' : 'off', // G14.2xx 自动换行:开启即纵向排布,横向滚动条消失
                    automaticLayout: false, // 2026-10-29 改 RO 回调内同步手动 layout(onMount 内,零相位差见彼注);内建 automaticLayout 时序等同故无需开启
                    renderLineHighlight: 'none',
                    overviewRulerLanes: 0,
                    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
                  }}
                />
              </div>
            )}
          </div>
          {load.loading && <div className="files-loading" role="status">{t('Loading…', '加载中…')}</div>}
        </>
      ) : (
        /* 2026-10-30 用户裁定「目录占位提示卡卸载」:空态只余加载/错误面(目录点击已分流左侧树
         *  定位/外开,不再落此;常驻输入行同卸——注释口径「无常驻输入行/加载钮」本就如此) */
        <div className="files-empty">
          {load.loading && <div className="files-loading" role="status">{t('Loading…', '加载中…')}</div>}
          {load.error !== null && (() => {
            /* 2026-10-27 用户裁定:错误面友好化——常见状态码人话标题,原始报文退居小字详情 */
            const raw = load.error;
            const m = /-> (\d{3})\s*$/.exec(raw);
            const status = m?.[1];
            const friendly =
              status === '404' ? t('File not found — it may have been moved or deleted.', '文件不存在——可能已被移动或删除。')
              : status === '403' ? t('Read denied — the path is outside trusted directories.', '读取被拒绝——该路径不在受信任的目录内。')
              : status === '415' ? t('File too large to preview.', '文件过大，无法预览。')
              : null;
            let detail = raw;
            try {
              detail = decodeURIComponent(raw);
            } catch {
              /* 编码异常按原文显 */
            }
            return (
              <div className="files-error" role="alert">
                <p className="files-error-title">{friendly ?? raw}</p>
                {friendly !== null && <p className="files-error-detail">{detail}</p>}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

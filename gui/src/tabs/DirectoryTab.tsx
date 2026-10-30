import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, RefreshCw, ChevronsDownUp, Search, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { Connection, TreeEntry, TreeSearchHit } from '../connection';
import type { TabTypeId, TabParams } from './tab-state';
import { FileIcon } from '../file-icon';
import { t } from '../i18n';

/**
 * G8b 目录标签体(T7):会话 root 的逐层惰拉树——G14.7 对齐 VSCode 资源管理器:
 * 头行(工作区名 + 刷新/全部折叠动作)+ 文件过滤框(VSCode「搜索文件」同位)+ 行树
 * (chevron/缩进参考线,--depth 供参考线背景;目录行免图标,文件行保 vscode-icons)。
 * G14.2xx 搜索改全层级:过滤非空 = 防抖 200ms 走 conn.searchTree 服务端项目路径索引
 * (TTL 缓存,refresh=1 强制重建——刷新钮;忽略集外全层级,100 条有界,不受「已加载层」限),
 * quick-open 式面包屑命中行(相对目录段暗淡 / 分隔,文件行末段亮;目录行 chevron 标识)——
 * 文件行点击开文件标签,目录行点击回树面并逐层展开定位(原地显示到对应目录)。git 状态
 * mount/刷新钮/每次提交搜索即重拉——多层级文件状态实时渲染。目录行点击 = 惰拉
 * 单层(展开态缓存保留,错误层重拉重试,G8e-T2),拖拽 = @目录引用(同文件行私有类型);
 * 文件行点击 = openTab('file', { path })。会话切换整体重置(G8b-T7 评审 #1)。
 */

export interface DirectoryTabProps {
  readonly conn: Connection;
  /** 当前会话（:id 寻址维） */
  readonly sessionId: string;
  /** 会话工作区 root（头行工作区名显示；undefined = 不示头行） */
  readonly root?: string;
  /** 会话内开标签面(registry render props 直通 App openTabInSession——文件行跳转判重/聚焦) */
  readonly openTab: (type: TabTypeId, params?: TabParams) => void;
  /** G14.2xx 定位(Files 页目录移交):相对目录路径变更即逐层展开定位;undefined = 无定位 */
  readonly locate?: string;
}

/** 单层节点态:loading/error 行内瞬态;loaded = entries + truncated 标 */
type NodeState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'loaded'; readonly entries: readonly TreeEntry[]; readonly truncated: boolean };

/** 展开层缓存初始态:root 在途(mount 即拉);兼作会话切换重置态(模块级只读,可安全共享) */
const INITIAL_NODES: ReadonlyMap<string, NodeState> = new Map([['', { status: 'loading' }]]);

/** G14.2xx 全层级搜索态:idle=树面(renderLevel(''));loading/loaded/error=命中面(替代树面) */
type SearchState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly hits: readonly TreeSearchHit[]; readonly truncated: boolean }
  | { readonly status: 'error'; readonly message: string };

/** 展开集初始/重置态(模块级共享只读引用——mount 重置同引用 React bail out,零多余重渲染) */
const INITIAL_EXPANDED: ReadonlySet<string> = new Set([]);

/** 行缩进(深度 × 14px + 6 基距)+ --depth(缩进参考线消费) */
const indent = (depth: number): CSSProperties =>
  ({ paddingLeft: `${6 + depth * 14}px`, '--depth': depth } as CSSProperties);

/** 子层 path 拼合:root 直出名,深层 `${父}/${name}`(与 tree?path= 相对口径一致) */
const childPath = (dirPath: string, name: string): string => (dirPath === '' ? name : `${dirPath}/${name}`);

/** 祖先链拼合(相对路径 → 逐级累计 path;locate 定位与搜索命中目录行两处同构) */
const chainOf = (rel: string): string[] => {
  const parts = rel.split('/').filter(Boolean);
  const chain: string[] = [];
  for (const seg of parts) chain.push(chain.length === 0 ? seg : chain[chain.length - 1] + '/' + seg);
  return chain;
};

export function DirectoryTab({ conn, sessionId, root, openTab, locate }: DirectoryTabProps): JSX.Element {
  const [nodes, setNodes] = useState<ReadonlyMap<string, NodeState>>(INITIAL_NODES);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => INITIAL_EXPANDED);
  /** G14.7 文件过滤(VSCode「搜索文件」同位):非空 = 全层级服务端搜索(命中面替代树面) */
  const [filter, setFilter] = useState('');
  /** G14.2xx 搜索态机(见 SearchState) */
  const [search, setSearch] = useState<SearchState>({ status: 'idle' });
  /** 搜索回包乱序守卫:仅最新 seq 可落态(防抖连打,慢包不覆盖新词结果) */
  const searchSeq = useRef(0);
  /** G14.2xx 定位去重:同一路径只定位一次(重开同路径不重放) */
  const locatedRef = useRef<string | undefined>(undefined);

  const setNode = useCallback((path: string, s: NodeState): void => {
    setNodes((m) => new Map(m).set(path, s));
  }, []);

  /** G14.112 git 状态映射(path → modified/untracked/deleted/renamed/ignored):树节点着色/徽标/暗淡 */
  const [gitMap, setGitMap] = useState<Record<string, string>>({});
  /** 2026-10-24 状态新鲜度:git 状态重拉单点(mount/刷新钮/每次提交搜索顺带——多层级文件状态实时渲染面) */
  const gitRefresh = useCallback((): void => {
    (conn.gitStatus?.(sessionId) ?? Promise.resolve({ branch: '', map: {} })).then(
      (r) => setGitMap(r.map ?? {}),
      // 拉取失败回空集:未知状态不显示徽标/暗淡——保留旧值会让上一会话的 M/U 徽标跨会话脏态
      // (非权威辅助数据降级口径,不弹错误面)
      () => setGitMap({}),
    );
  }, [conn, sessionId]);

  /** root 单层拉取单点(mount/刷新钮两处同构;重置语义=恒重拉无缓存判定) */
  const fetchRoot = useCallback((): void => {
    void conn.tree(sessionId).then(
      (r) => setNode('', { status: 'loaded', entries: r.entries, truncated: r.truncated === true }),
      (err: unknown) => setNode('', { status: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  }, [conn, sessionId, setNode]);

  /** 单层拉取单点(locate/命中目录行/toggleDir 三处同构);缓存判定归一口径=「已载或在途免拉,
   *  错误层重试」(调用方判,与 toggleDir 既有口径一致——原 locate 恒重拉/命中行 loading 态重拉
   *  两种漂移口径随之收编,重复请求消失、可见结果不变) */
  const fetchLayer = useCallback(
    (dir: string): void => {
      setNode(dir, { status: 'loading' });
      void conn.tree(sessionId, dir).then(
        (r) => setNode(dir, { status: 'loaded', entries: r.entries, truncated: r.truncated === true }),
        (err: unknown) => setNode(dir, { status: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
    },
    [conn, sessionId, setNode],
  );

  /** mount/会话切换拉 root:整体重置(层缓存+展开集+过滤)再拉新会话 root */
  useEffect(() => {
    setNodes(INITIAL_NODES);
    setExpanded(INITIAL_EXPANDED);
    setFilter('');
    gitRefresh();
    fetchRoot();
  }, [conn, sessionId, setNode, gitRefresh, fetchRoot]);

  /** 搜索单点(防抖定时器/刷新钮共用):git 状态顺带重拉(文件状态实时渲染);refreshIndex=true
   *  强制服务端索引重建。seq 守卫乱序回包(慢包不覆盖新词结果)。 */
  const runSearch = useCallback(
    (q: string, refreshIndex: boolean): void => {
      const seq = ++searchSeq.current;
      setSearch({ status: 'loading' });
      gitRefresh();
      (conn.searchTree?.(sessionId, q, refreshIndex) ?? Promise.resolve({ results: [] })).then(
        (r) => {
          if (searchSeq.current === seq) setSearch({ status: 'loaded', hits: r.results ?? [], truncated: r.truncated === true });
        },
        (err: unknown) => {
          if (searchSeq.current === seq) setSearch({ status: 'error', message: err instanceof Error ? err.message : String(err) });
        },
      );
    },
    [conn, sessionId, gitRefresh],
  );

  /** 动作钮:刷新 = 整树重置重拉 + git 状态重拉;搜索在场时强制索引重建重搜(服务端 refresh=1) */
  const refresh = useCallback((): void => {
    setNodes(new Map([['', { status: 'loading' }]]));
    setExpanded(new Set());
    gitRefresh();
    fetchRoot();
    const q = filter.trim();
    if (q !== '') runSearch(q, true);
  }, [conn, sessionId, setNode, gitRefresh, fetchRoot, filter, runSearch]);

  const collapseAll = useCallback((): void => setExpanded(new Set()), []);

  /** G14.2xx 定位(Files 页目录移交):locate 相对目录变更 → 祖先链逐层展开+拉取(目标目录全可见) */
  useEffect(() => {
    if (locate === undefined || locate === '' || locatedRef.current === locate) return;
    locatedRef.current = locate;
    const rel = locate.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
    const chain = chainOf(rel);
    if (chain.length === 0) return;
    setExpanded((s) => new Set([...s, ...chain]));
    for (const dir of chain) {
      const cached = nodes.get(dir);
      if (cached !== undefined && cached.status !== 'error') continue; // 已载/在途免拉(归一口径)
      fetchLayer(dir);
    }
  }, [locate, nodes, fetchLayer]);

  /** G14.2xx 全层级搜索:filter 非空防抖 200ms → runSearch(服务端项目索引内存过滤,全层级
   *  命中,GUI 不再受「已加载层」限);空串即刻回树面。 */
  useEffect(() => {
    const q = filter.trim();
    if (q === '') {
      setSearch({ status: 'idle' });
      return;
    }
    const timer = setTimeout(() => runSearch(q, false), 200);
    return () => clearTimeout(timer);
  }, [filter, runSearch]);

  /** G14.143 目录级 git 聚合:变更文件的祖先目录标记聚合状态(modified 压过 untracked)——
   *  目录行名着色 + 右缘圆点(VSCode 同位) */
  const dirGit = useMemo(() => {
    const rank: Record<string, number> = { modified: 3, renamed: 3, deleted: 3, untracked: 1 };
    const out: Record<string, string> = {};
    for (const raw of Object.keys(gitMap)) {
      const st = gitMap[raw]!;
      if (st !== 'modified' && st !== 'renamed' && st !== 'deleted' && st !== 'untracked') continue;
      const clean = raw.replace(/\/$/, '');
      const parts = clean.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        const dir = parts.slice(0, i).join('/');
        const cur = out[dir];
        if (cur === undefined || (rank[st] ?? 0) > (rank[cur] ?? 0)) out[dir] = (rank[st] ?? 0) >= 3 ? 'modified' : 'untracked';
      }
    }
    return out;
  }, [gitMap]);

  const toggleDir = (dirPath: string): void => {
    if (expanded.has(dirPath)) {
      setExpanded((s) => {
        const next = new Set(s);
        next.delete(dirPath);
        return next;
      });
      return;
    }
    setExpanded((s) => new Set(s).add(dirPath));
    const cached = nodes.get(dirPath);
    if (cached !== undefined && cached.status !== 'error') return; // 缓存命中:收起再展开零请求
    fetchLayer(dirPath);
  };

  const openFile = (filePath: string): void => {
    openTab('file', { path: filePath });
  };

  /** G14.2xx 目录命中点击:回树面并逐层展开定位(祖先链全可见;缓存口径与 toggleDir 同源) */
  const openDirResult = (rel: string): void => {
    setFilter('');
    const chain = chainOf(rel);
    setExpanded((s) => new Set([...s, ...chain]));
    for (const dir of chain) {
      const cached = nodes.get(dir);
      if (cached !== undefined && cached.status !== 'error') continue; // 已载/在途免拉(归一口径,原 loaded 才免拉近重复请求)
      fetchLayer(dir);
    }
  };

  /** G14.2xx 命中面(VSCode quick-open 形):相对目录面包屑——目录段暗淡 / 分隔,文件行末段亮;
   *  目录行(chevron 标识)点击回树面原地逐层展开定位,文件行点击开文件页签。git 装饰同树面
   *  口径:ignored 整行灰/文件字母徽标/目录聚合圆点。 */
  const renderSearch = (): JSX.Element => {
    if (search.status === 'loading') {
      return <div className="sx-tree-row sx-tree-status">{t('Searching…', '搜索中…')}</div>;
    }
    if (search.status === 'error') {
      return <div className="sx-tree-row sx-tree-error">{search.message}</div>;
    }
    if (search.status === 'idle') return renderLevel('', 0); // 不可达(调用面 idle 才走树面)——类型收窄兜底
    if (search.hits.length === 0) {
      return <div className="sx-tree-row sx-tree-status">{t('No matches', '无匹配')}</div>;
    }
    return (
      <>
        {search.hits.map((h) => {
          const gst = gitMap[h.path];
          // 2026-10-24 用户裁定:服务端忽略标记(git check-ignore)与 gitMap ignored 双源,命中行暗淡
          const dimmed = h.ignored === true || gst === 'ignored';
          const badge = gst === 'modified' ? 'M' : gst === 'untracked' ? 'U' : gst === 'deleted' ? 'D' : gst === 'renamed' ? 'R' : null;
          const dirGitSt = h.kind === 'dir' ? (gst === 'untracked' ? 'untracked' : dirGit[h.path]) : undefined;
          const parts = h.path.split('/');
          const isFile = h.kind === 'file';
          const dirSegs = isFile ? parts.slice(0, -1) : parts; // 目录行整条都是目录段(全暗淡,同 quick-open)
          const fileName = isFile ? parts[parts.length - 1]! : null;
          return (
            <button
              key={h.path}
              type="button"
              className={`sx-tree-row sx-tree-file${dimmed ? ' sx-tree-ignored' : ''}${gst !== undefined && gst !== 'ignored' ? ` sx-tree-git-${gst}` : ''}`}
              style={indent(0)}
              data-tip={h.path}
              onClick={() => (h.kind === 'dir' ? openDirResult(h.path) : openFile(h.path))}
            >
              {h.kind === 'dir' ? (
                <ChevronRight size={16} strokeWidth={1.75} className="sx-tree-chevron" />
              ) : (
                <FileIcon path={h.name} size={16} />
              )}
              <span className="sx-tree-crumb">
                {dirSegs.map((d, i) => {
                  // 分隔符只出现在段间:目录行末段不缀尾斜杠(quick-open 同款);文件行末段是文件名,目录段全带分隔
                  const sep = isFile || i < dirSegs.length - 1;
                  return (
                    <Fragment key={`${i}:${d}`}>
                      <span className="sx-tree-crumb-dir" style={{ flexShrink: dirSegs.length - i }}>{d}</span>
                      {sep && <span className="sx-tree-crumb-sep" aria-hidden="true">/</span>}
                    </Fragment>
                  );
                })}
                {fileName !== null && <span className="sx-tree-name">{fileName}</span>}
              </span>
              {dirGitSt !== undefined ? (
                <span className={`sx-tree-dot st-${dirGitSt}`} aria-hidden="true" />
              ) : (
                badge !== null && <span className={`sx-tree-badge st-${gst}`}>{badge}</span>
              )}
            </button>
          );
        })}
        {search.truncated && <div className="sx-tree-row sx-tree-truncated">…{t('truncated', '已截断')}</div>}
      </>
    );
  };

  /** 递归渲染一层(G14.2xx 起过滤面由 renderSearch 承担,此函数恒全量渲染) */
  const renderLevel = (dirPath: string, depth: number): JSX.Element => {
    const st = nodes.get(dirPath);
    if (st === undefined) return <></>;
    if (st.status === 'loading') {
      return (
        <div className="sx-tree-row sx-tree-status" style={indent(depth)} key={`${dirPath}\u0000loading`}>
          {t('Loading…', '加载中…')}
        </div>
      );
    }
    if (st.status === 'error') {
      return (
        <div className="sx-tree-row sx-tree-error" style={indent(depth)} key={`${dirPath}\u0000error`}>
          {st.message}
        </div>
      );
    }
    const visible = st.entries;
    return (
      <Fragment key={dirPath === '' ? '\u0000root' : dirPath}>
        {/* G14.7 修复:展开子层紧跟父行(原「子层集中尾渲染」把子项顶到列表末尾——VSCode 是就地展开) */}
        {visible.map((e) => {
          const p = childPath(dirPath, e.name);
          // G14.112 git 状态(相对 root 归一后查映射):文件/折叠 ignored 目录均命中;
          // ignored → 整行暗淡;文件 → 尾缀状态徽标(M/U/D/R)
          const relNorm = p.split('\\').join('/');
          const gst = gitMap[relNorm] ?? (e.kind === 'dir' ? gitMap[relNorm + '/'] : undefined);
          const dimmed = gst === 'ignored';
          const badge = gst === 'modified' ? 'M' : gst === 'untracked' ? 'U' : gst === 'deleted' ? 'D' : gst === 'renamed' ? 'R' : null;
          // G14.143 目录级聚合状态:自身 untracked(整目录新)优先,否则取祖先聚合(modified 压 untracked)
          const dirGitSt = e.kind === 'dir' ? (gst === 'untracked' ? 'untracked' : dirGit[relNorm]) : undefined;
          return (
            <Fragment key={e.name}>
              {e.kind === 'dir' ? (
                <button
                  type="button"
                  className={`sx-tree-row sx-tree-dir${dimmed ? ' sx-tree-ignored' : ''}${dirGitSt !== undefined ? ` sx-tree-git-${dirGitSt}` : ''}`}
                  style={indent(depth)}
                  aria-expanded={expanded.has(p)}
                  onClick={() => toggleDir(p)}
                  draggable
                  onDragStart={(e) => {
                    // 拖目录名到输入框=@目录引用(与文件行同走 text/sunshinex-file;尾斜杠=内部标记,
                    // composer 落点插 @短名 无斜杠,芯片/气泡经记账标记显黄目录)
                    e.dataTransfer.setData('text/sunshinex-file', `${relNorm}/`);
                    e.dataTransfer.setData('text/plain', `${relNorm}/`);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                >
                  <ChevronRight
                    size={16}
                    strokeWidth={1.75}
                    className={`sx-tree-chevron${expanded.has(p) ? ' open' : ''}`}
                  />
                  <span className="sx-tree-name">{e.name}</span>
                  {/* G14.143 目录态=右缘圆点(VSCode 同位),不走字母徽标 */}
                  {dirGitSt !== undefined ? (
                    <span className={`sx-tree-dot st-${dirGitSt}`} aria-hidden="true" />
                  ) : (
                    badge !== null && <span className={`sx-tree-badge st-${gst}`}>{badge}</span>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  className={`sx-tree-row sx-tree-file${dimmed ? ' sx-tree-ignored' : ''}${gst !== undefined && gst !== 'ignored' ? ` sx-tree-git-${gst}` : ''}`}
                  style={indent(depth)}
                  onClick={() => openFile(p)}
                  draggable
                  onDragStart={(e) => {
                    // G14.144 拖文件名到输入框=自动 @文件(text/sunshinex-file 私有类型供 composer 接)
                    e.dataTransfer.setData('text/sunshinex-file', relNorm);
                    e.dataTransfer.setData('text/plain', relNorm);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                >
                  <FileIcon path={e.name} size={16} />
                  <span className="sx-tree-name">{e.name}</span>
                  {badge !== null && <span className={`sx-tree-badge st-${gst}`}>{badge}</span>}
                </button>
              )}
              {e.kind === 'dir' && expanded.has(p) ? renderLevel(p, depth + 1) : null}
            </Fragment>
          );
        })}
        {st.truncated && (
          <div className="sx-tree-row sx-tree-truncated" style={indent(depth)}>
            …{t('truncated', '已截断')}
          </div>
        )}
      </Fragment>
    );
  };

  const wsName = root !== undefined && root !== '' ? (root.split(/[\\/]+/).filter(Boolean).pop() ?? root) : undefined;

  return (
    <div className="sx-tree" aria-label="directory tree">
      {/* 头行(VSCode explorer 同位):工作区名 + 刷新/全部折叠 */}
      {wsName !== undefined && (
        <div className="sx-tree-head">
          <span className="sx-tree-head-name" data-tip={root}>{wsName}</span>
          <span className="sx-tree-head-actions">
            <button type="button" className="sx-iconbtn" aria-label="refresh" data-tip={t('Refresh', '刷新')} onClick={refresh}>
              <RefreshCw size={13} strokeWidth={1.75} />
            </button>
            <button type="button" className="sx-iconbtn" aria-label="collapse all" data-tip={t('Collapse All', '全部折叠')} onClick={collapseAll}>
              <ChevronsDownUp size={13} strokeWidth={1.75} />
            </button>
          </span>
        </div>
      )}
      {/* 文件过滤(VSCode「搜索文件」同位;G14.2xx 起非空即全层级服务端搜索) */}
      <div className="sx-tree-filter">
        <Search size={13} strokeWidth={1.75} aria-hidden="true" />
        <input
          aria-label="filter files"
          value={filter}
          placeholder={t('Search files…', '搜索文件…')}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter !== '' && (
          <button type="button" aria-label="clear filter" onClick={() => setFilter('')}>
            <X size={13} strokeWidth={1.75} />
          </button>
        )}
      </div>
      {search.status === 'idle' ? renderLevel('', 0) : renderSearch()}
    </div>
  );
}

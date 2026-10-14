import { Fragment, useCallback, useEffect, useState } from 'react';
import { ChevronRight, RefreshCw, ChevronsDownUp, Search, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { Connection, TreeEntry } from '../connection';
import type { TabTypeId, TabParams } from './tab-state';
import { FileIcon } from '../file-icon';
import { t } from '../i18n';

/**
 * G8b 目录标签体(T7):会话 root 的逐层惰拉树——G14.7 对齐 VSCode 资源管理器:
 * 头行(工作区名 + 刷新/全部折叠动作)+ 文件过滤框(VSCode「搜索文件」同位)+ 行树
 * (chevron/vscode-icons/缩进参考线,--depth 供参考线背景)。过滤非空:已加载层内按名
 * 包含匹配,命中文件自动可见(父层恒显)。目录行点击 = 惰拉单层(展开态缓存保留,错误层
 * 重拉重试,G8e-T2);文件行点击 = openTab('file', { path })。会话切换整体重置(G8b-T7 评审 #1)。
 */

export interface DirectoryTabProps {
  readonly conn: Connection;
  /** 当前会话（:id 寻址维） */
  readonly sessionId: string;
  /** 会话工作区 root（头行工作区名显示；undefined = 不示头行） */
  readonly root?: string;
  /** 会话内开标签面(registry render props 直通 App openTabInSession——文件行跳转判重/聚焦) */
  readonly openTab: (type: TabTypeId, params?: TabParams) => void;
}

/** 单层节点态:loading/error 行内瞬态;loaded = entries + truncated 标 */
type NodeState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'loaded'; readonly entries: readonly TreeEntry[]; readonly truncated: boolean };

/** 展开层缓存初始态:root 在途(mount 即拉);兼作会话切换重置态(模块级只读,可安全共享) */
const INITIAL_NODES: ReadonlyMap<string, NodeState> = new Map([['', { status: 'loading' }]]);

/** 展开集初始/重置态(模块级共享只读引用——mount 重置同引用 React bail out,零多余重渲染) */
const INITIAL_EXPANDED: ReadonlySet<string> = new Set([]);

/** 行缩进(深度 × 14px + 6 基距)+ --depth(缩进参考线消费) */
const indent = (depth: number): CSSProperties =>
  ({ paddingLeft: `${6 + depth * 14}px`, '--depth': depth } as CSSProperties);

/** 子层 path 拼合:root 直出名,深层 `${父}/${name}`(与 tree?path= 相对口径一致) */
const childPath = (dirPath: string, name: string): string => (dirPath === '' ? name : `${dirPath}/${name}`);

export function DirectoryTab({ conn, sessionId, root, openTab }: DirectoryTabProps): JSX.Element {
  const [nodes, setNodes] = useState<ReadonlyMap<string, NodeState>>(INITIAL_NODES);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => INITIAL_EXPANDED);
  /** G14.7 文件过滤(VSCode「搜索文件」同位):非空 = 已加载层内按名包含匹配 */
  const [filter, setFilter] = useState('');

  const setNode = useCallback((path: string, s: NodeState): void => {
    setNodes((m) => new Map(m).set(path, s));
  }, []);

  /** mount/会话切换拉 root:整体重置(层缓存+展开集+过滤)再拉新会话 root */
  useEffect(() => {
    setNodes(INITIAL_NODES);
    setExpanded(INITIAL_EXPANDED);
    setFilter('');
    void conn.tree(sessionId).then(
      (r) => setNode('', { status: 'loaded', entries: r.entries, truncated: r.truncated === true }),
      (err: unknown) => setNode('', { status: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  }, [conn, sessionId, setNode]);

  /** 动作钮:刷新 = 整树重置重拉;全部折叠 = 清展开集(缓存保留) */
  const refresh = useCallback((): void => {
    setNodes(new Map([['', { status: 'loading' }]]));
    setExpanded(new Set());
    void conn.tree(sessionId).then(
      (r) => setNode('', { status: 'loaded', entries: r.entries, truncated: r.truncated === true }),
      (err: unknown) => setNode('', { status: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  }, [conn, sessionId, setNode]);

  const collapseAll = useCallback((): void => setExpanded(new Set()), []);

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
    setNode(dirPath, { status: 'loading' });
    void conn.tree(sessionId, dirPath).then(
      (r) => setNode(dirPath, { status: 'loaded', entries: r.entries, truncated: r.truncated === true }),
      (err: unknown) => setNode(dirPath, { status: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  };

  const openFile = (filePath: string): void => {
    openTab('file', { path: filePath });
  };

  /** 过滤匹配(G14.7):名包含(大小写不敏感);空串 = 全显 */
  const matches = (name: string): boolean => {
    const f = filter.trim().toLowerCase();
    return f === '' || name.toLowerCase().includes(f);
  };

  /** 递归渲染一层;过滤非空时未命中条目隐藏(命中文件照常可点) */
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
    const visible = st.entries.filter((e) => matches(e.name));
    return (
      <Fragment key={dirPath === '' ? '\u0000root' : dirPath}>
        {/* G14.7 修复:展开子层紧跟父行(原「子层集中尾渲染」把子项顶到列表末尾——VSCode 是就地展开) */}
        {visible.map((e) => {
          const p = childPath(dirPath, e.name);
          return (
            <Fragment key={e.name}>
              {e.kind === 'dir' ? (
                <button
                  type="button"
                  className="sx-tree-row sx-tree-dir"
                  style={indent(depth)}
                  aria-expanded={expanded.has(p)}
                  onClick={() => toggleDir(p)}
                >
                  <ChevronRight
                    size={14}
                    strokeWidth={1.75}
                    className={`sx-tree-chevron${expanded.has(p) ? ' open' : ''}`}
                  />
                  <FileIcon path={e.name} folder open={expanded.has(p)} />
                  <span className="sx-tree-name">{e.name}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="sx-tree-row sx-tree-file"
                  style={indent(depth)}
                  onClick={() => openFile(p)}
                >
                  <FileIcon path={e.name} />
                  <span className="sx-tree-name">{e.name}</span>
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
          <span className="sx-tree-head-name" title={root}>{wsName}</span>
          <span className="sx-tree-head-actions">
            <button type="button" className="sx-iconbtn" aria-label="refresh" title={t('Refresh', '刷新')} onClick={refresh}>
              <RefreshCw size={13} strokeWidth={1.75} />
            </button>
            <button type="button" className="sx-iconbtn" aria-label="collapse all" title={t('Collapse All', '全部折叠')} onClick={collapseAll}>
              <ChevronsDownUp size={13} strokeWidth={1.75} />
            </button>
          </span>
        </div>
      )}
      {/* 文件过滤(VSCode「搜索文件」同位) */}
      <div className="sx-tree-filter">
        <Search size={12} strokeWidth={1.75} aria-hidden="true" />
        <input
          aria-label="filter files"
          value={filter}
          placeholder={t('Search files…', '搜索文件…')}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter !== '' && (
          <button type="button" aria-label="clear filter" onClick={() => setFilter('')}>
            <X size={12} strokeWidth={1.75} />
          </button>
        )}
      </div>
      {renderLevel('', 0)}
    </div>
  );
}

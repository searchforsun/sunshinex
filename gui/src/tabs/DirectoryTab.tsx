import { Fragment, useCallback, useEffect, useState } from 'react';
import { ChevronRight, Folder, FileText } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { Connection, TreeEntry } from '../connection';
import type { TabTypeId, TabParams } from './tab-state';

/**
 * G8b 目录标签体(T7):会话 root 的逐层惰拉树。mount 拉 root(tree(sessionId),path 缺省 '')
 * → 行列表(目录行 = ChevronRight 旋态 + Folder + 名;文件行 = FileText + 名);目录行点击 =
 * 惰拉单层(展开态 Map<path, NodeState> 缓存),再点收起——**缓存保留**(再展开不再拉);文件行
 * 点击 = openTab('file', { path })(相对路径以 root 起,判界一致性由服务端保证)。子层 path 拼合:
 * 父 path ? `${父}/${name}` : name。truncated → 行层尾「…已截断」标记;加载/错误行内态。
 * 状态生命周期随组件挂载(切标签卸毁即失——重挂重拉 root,与 Files/TerminalTab 同口径);
 * 单例跨会话不重挂(uid 恒 'directory:',tabbody key 不变而 sessionId prop 变)——sessionId
 * 变更即整体重置层缓存+展开集再重拉 root(跨会话陈旧层/陈旧展开根除,G8b-T7 评审 #1 修);
 * sx-tree-* 伴生样式归 G8b-e(app.css 冻结),缩进以行内 paddingLeft 表达(深度 × 14)。
 */

export interface DirectoryTabProps {
  readonly conn: Connection;
  /** 当前会话(:id 寻址维) */
  readonly sessionId: string;
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
const INITIAL_EXPANDED: ReadonlySet<string> = new Set();

/** 行缩进(深度 × 14px + 6 基距)——树形视觉面,样式冻结期的行内表达 */
const indent = (depth: number): CSSProperties => ({ paddingLeft: `${6 + depth * 14}px` });

/** 子层 path 拼合:root 直出名,深层 `${父}/${name}`(与 tree?path= 相对口径一致) */
const childPath = (dirPath: string, name: string): string => (dirPath === '' ? name : `${dirPath}/${name}`);

export function DirectoryTab({ conn, sessionId, openTab }: DirectoryTabProps): JSX.Element {
  /** 层缓存:path(''=root)→ NodeState;收起不清缓存(再展开命中,不再拉) */
  const [nodes, setNodes] = useState<ReadonlyMap<string, NodeState>>(INITIAL_NODES);
  /** 展开集合:目录行点击切换;收起只摘集合不动缓存 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => INITIAL_EXPANDED);

  /** 层缓存单点写入(不可变拷——tabbody 同树位重渲染口径) */
  const setNode = useCallback((path: string, s: NodeState): void => {
    setNodes((m) => new Map(m).set(path, s));
  }, []);

  /** mount/会话切换拉 root:sessionId 变更即整体重置层缓存+展开集(单例跨会话不重挂——旧会话
   *  层缓存命中会渲染他会话子层,必清)再拉新会话 root;mount 时重置同引用 bail out 零成本
   *  (卸载后迟到应答落态无的放矢——React 18 静默,无泄漏面) */
  useEffect(() => {
    setNodes(INITIAL_NODES);
    setExpanded(INITIAL_EXPANDED);
    void conn.tree(sessionId).then(
      (r) => setNode('', { status: 'loaded', entries: r.entries, truncated: r.truncated === true }),
      (err: unknown) => setNode('', { status: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  }, [conn, sessionId, setNode]);

  /** 目录行点击:已展开 → 收起(缓存保留);未展开 → 展开 + 未缓存才惰拉单层 */
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
    if (nodes.has(dirPath)) return; // 缓存命中:收起再展开零请求
    setNode(dirPath, { status: 'loading' });
    void conn.tree(sessionId, dirPath).then(
      (r) => setNode(dirPath, { status: 'loaded', entries: r.entries, truncated: r.truncated === true }),
      (err: unknown) => setNode(dirPath, { status: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  };

  /** 文件行点击:openTab('file', { path })(判重聚焦经 tab-state——同文件重开=聚焦既有) */
  const openFile = (filePath: string): void => {
    openTab('file', { path: filePath });
  };

  /** 递归渲染一层:未拉的层不渲染(展开才惰拉);目录行下依展开集合嵌子层 */
  const renderLevel = (dirPath: string, depth: number): JSX.Element => {
    const st = nodes.get(dirPath);
    if (st === undefined) return <></>;
    if (st.status === 'loading') {
      return (
        <div className="sx-tree-row sx-tree-status" style={indent(depth)} key={`${dirPath}\u0000loading`}>
          加载中…
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
    return (
      <Fragment key={dirPath === '' ? '\u0000root' : dirPath}>
        {st.entries.map((e) => {
          const p = childPath(dirPath, e.name);
          return e.kind === 'dir' ? (
            <button
              key={e.name}
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
              <Folder size={14} strokeWidth={1.75} />
              <span className="sx-tree-name">{e.name}</span>
            </button>
          ) : (
            <button
              key={e.name}
              type="button"
              className="sx-tree-row sx-tree-file"
              style={indent(depth)}
              onClick={() => openFile(p)}
            >
              <FileText size={14} strokeWidth={1.75} />
              <span className="sx-tree-name">{e.name}</span>
            </button>
          );
        })}
        {st.truncated && (
          <div className="sx-tree-row sx-tree-truncated" style={indent(depth)}>
            …已截断
          </div>
        )}
        {st.entries
          .filter((e) => e.kind === 'dir')
          .map((e) => (expanded.has(childPath(dirPath, e.name)) ? renderLevel(childPath(dirPath, e.name), depth + 1) : null))}
      </Fragment>
    );
  };

  return (
    <div className="sx-tree" aria-label="directory tree">
      {renderLevel('', 0)}
    </div>
  );
}

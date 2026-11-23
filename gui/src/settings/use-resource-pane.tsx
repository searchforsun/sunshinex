import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { errText } from '../ui-util';
import { ScopeSelect, SearchBar, defaultScopeOptions } from './components';
import type { SettingsScope, ScopeOption } from './components';
import { t } from '../i18n';

/**
 * settings 资源面骨架单点（D91 收敛，Agents/Teams/Mcp/Plugins 四 Pane 同构族）：作用域裁定
 * （myScope/fetchRoot——壳下发优先，缺省按 root 推断；project 作用域带 root、global 省参）+
 * 读面（fetch 单发成功走 onData+清 loadError，失败落 loadError errText）+load+refreshTick 重拉
 * effect（config-changed 订阅消费面，零轮询）+runOp 写回收口（saving 门→put→成功重拉，失败
 * saving 复位+actionError errText 行内）。
 *
 * fetch/onData/put 经最新引用（latest-ref）进 load/runOp 闭包——Pane 内联闭包零 memo 负担，
 * load 身份只随 fetchRoot 变（重拉 effect 门槛与迁移前 [conn,fetchRoot] 等效：conn 壳级稳定）。
 * 表单校验/抽屉面差异留各 Pane（D91 判定：四面抽屉形态真异，硬套即失真）；saving 门以
 * setSaving 交还 Pane 共用（抽屉提交/开关流同门）。
 */

/** 卡可写判据单点（Agents/Teams/Mcp 同款三处）：project 卡=project 作用域且有 root；global 卡=
 *  global 作用域（被遮蔽卡只出现在 project 视图，天然不可写）。 */
export function canWriteInScope(myScope: SettingsScope, root: string, source: 'project' | 'global'): boolean {
  return source === 'project' ? myScope === 'project' && root !== '' : myScope === 'global';
}

/** 资源面工具栏三件套单点（ScopeSelect 目标选择器+SearchBar+新增钮；Plugins 无新增入口
 *  =onNew 缺省不渲染钮）。scopeOptions 缺省回落 defaultScopeOptions(root)。 */
export function ResourceToolbar({ root, myScope, scopeOptions, onScopeChange, query, onQueryChange, searchPlaceholder, onNew, newLabel }: {
  /** 壳下发 targetRoot（ScopeSelect 值与缺省选项面共源） */
  readonly root: string;
  readonly myScope: SettingsScope;
  readonly scopeOptions?: readonly ScopeOption[];
  readonly onScopeChange?: (targetRoot: string) => void;
  readonly query: string;
  readonly onQueryChange: (q: string) => void;
  readonly searchPlaceholder: string;
  /** 新增钮回调（缺省=本面无新增入口，不渲染钮） */
  readonly onNew?: () => void;
  /** 新增钮文案（缺省「+ 新增」；MCP 面用「+ 添加」） */
  readonly newLabel?: string;
}): JSX.Element {
  return (
    <div className="sx-res-toolbar">
      <ScopeSelect value={myScope === 'project' ? root : ''} options={scopeOptions ?? defaultScopeOptions(root)} onChange={(v) => onScopeChange?.(v)} />
      <SearchBar value={query} onChange={onQueryChange} placeholder={searchPlaceholder} />
      {onNew !== undefined && (
        <button type="button" className="sx-add-button" onClick={onNew}>
          {newLabel ?? t('+ New', '+ 新增')}
        </button>
      )}
    </div>
  );
}

export function useResourcePane<TData, TOp>(opts: {
  /** 壳下发 targetRoot——下拉选哪个项目即锚哪个；'' = 全局作用域 */
  readonly root: string;
  /** 作用域（壳下发优先，缺省按 root 推断——无 root 强制 global） */
  readonly scope?: SettingsScope;
  /** config-changed 订阅 tick——变化即重拉（外部改动信号，零轮询） */
  readonly refreshTick?: number;
  /** 读面单发（fetchRoot 已按作用域裁定注入）；多读面 Pane（teams 成员源）在闭包内并发自理 */
  readonly fetch: (fetchRoot: string | undefined) => Promise<TData>;
  /** 读面落位（Pane 自持 data 真值） */
  readonly onData: (data: TData) => void;
  /** op 写面单发（putXxxOp）；runOp 的回收口本体 */
  readonly put: (input: TOp) => Promise<void>;
}): {
  /** 作用域裁定结果（工具栏 ScopeSelect 值/卡可写判据共用） */
  readonly myScope: SettingsScope;
  /** 读面取参：project 作用域带 root（两级清单），global 作用域省参（仅全局清单） */
  readonly fetchRoot: string | undefined;
  /** 手动重拉口（写面成功/外部触发面） */
  readonly load: () => void;
  readonly loadError: string;
  readonly actionError: string;
  /** op 写面失败条 setter（bespoke 异步写流——如 MCP 逐工具开关读改写链——复用 actionError 位） */
  readonly setActionError: Dispatch<SetStateAction<string>>;
  /** 写面在途门（runOp 内单点起落；抽屉提交等 Pane 自管写共用此门） */
  readonly saving: boolean;
  readonly setSaving: Dispatch<SetStateAction<boolean>>;
  /** op 写回收口：saving 门 → put → 成功重拉（失败 saving 复位+actionError errText 行内） */
  readonly runOp: (input: TOp) => void;
} {
  const { root, scope, refreshTick } = opts;
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  /** 作用域裁定：壳下发优先，缺省按 root 推断（壳缺省同款——无 root 强制 global） */
  const myScope: SettingsScope = scope ?? (root === '' ? 'global' : 'project');
  /** 读面取参：project 作用域带 root（两级清单），global 作用域省参（仅全局清单） */
  const fetchRoot = myScope === 'project' && root !== '' ? root : undefined;

  // 最新引用进闭包：Pane 内联 fetch/onData/put 零 memo 负担，load 身份只随 fetchRoot 变
  const fetchRef = useRef(opts.fetch);
  fetchRef.current = opts.fetch;
  const onDataRef = useRef(opts.onData);
  onDataRef.current = opts.onData;
  const putRef = useRef(opts.put);
  putRef.current = opts.put;

  const load = useCallback((): void => {
    fetchRef.current(fetchRoot).then(
      (v) => {
        onDataRef.current(v);
        setLoadError('');
      },
      (err: unknown) => setLoadError(errText(err)),
    );
  }, [fetchRoot]);

  useEffect(() => {
    load();
  }, [load, refreshTick]); // refreshTick 变化=外部改动信号 → 重拉（config-changed 订阅消费面）

  /** op 写回收口：saving 门 → put → 成功重拉（失败 saving 复位+行内错误条；409 hint 由
   *  errText 呈现 status 行） */
  const runOp = (input: TOp): void => {
    if (saving) return;
    setSaving(true);
    setActionError('');
    putRef
      .current(input)
      .then(() => {
        setSaving(false);
        load();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setActionError(errText(err));
      });
  };

  return { myScope, fetchRoot, load, loadError, actionError, setActionError, saving, setSaving, runOp };
}

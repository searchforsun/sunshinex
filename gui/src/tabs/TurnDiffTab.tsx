import { useCallback, useEffect, useRef, useState } from 'react';
import { Undo2, FileText } from 'lucide-react';
import { pathBasename, withMinSpin } from '../ui-util';
import { DiffLines } from '../diff-lines';
import { FileIcon } from '../file-icon';
import { t } from '../i18n';
import { notifyGitChanged } from '../pages/chat/use-live-changes';import type { Connection } from '../connection';
import type { TabParams } from './tab-state';

/**
 * 本轮改动页签(2026-11-10 用户裁定「每轮精确看到自己的改动」):单文件 diff,内容随轮冻结——
 * run+path 寻址读 runmeta.turn 前像/后像 blob(后续轮次再改同文件,页签内容不漂移;区别于审查页
 * 的 git 现值口径);callId+path 寻址(主对话 write/edit 工具行跳转,与轮 diff 复用同一页签)走
 * 既有 /diff 端点(write 前像 vs 现盘)。撤销=checkpoint 回写(前像 blob 落盘),staleness 闸门
 * (当前磁盘 ≠ 轮末后像 → 409 stale 拒绝)在服务端,此处只呈现结果。
 */

interface DiffContent {
  oldContent?: string;
  newContent: string;
  truncated?: boolean;
  deleted?: boolean;
}

export interface TurnDiffTabProps {
  readonly conn: Connection;
  readonly sessionId: string;
  readonly params: TabParams;
  /** 点击文件名 → 打开 file 标签预览(App 注入 openTabInSession('file')) */
  readonly onOpenFile?: (path: string) => void;
}

export function TurnDiffTab({ conn, sessionId, params, onOpenFile }: TurnDiffTabProps): JSX.Element {
  const { run, callId, path } = params;
  const [content, setContent] = useState<DiffContent | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 撤销二次确认:首击武装(转红),3s 内再击执行 */
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  /** 撤销后结果面:stale=后续又改过(置灰不可撤),ok=已回写(内容面刷新为「已撤销」态) */
  const [stale, setStale] = useState(false);
  const [restored, setRestored] = useState(false);

  const rel = path ?? '';
  const load = useCallback((): void => {
    if (rel === '') {
      setLoadErr(t('Nothing to show', '没有可展示的内容'));
      return;
    }
    // run 缺场+callId 空=path-only 兜底(2026-11-11):旧装配回退/参数残缺页签不再死面——服务端
    // /diff 放行空 callId+path 走 journal 末次前像
    withMinSpin(
      run !== undefined
        ? conn.turnDiff(sessionId, run, rel)
        : conn.fetchDiff(sessionId, callId ?? '', rel),
    ).then(
      (c) => {
        setContent(c);
        setLoadErr(null);
      },
      (err: unknown) => {
        setContent(null);
        setLoadErr(err instanceof Error ? err.message : String(err));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, sessionId, run, callId, rel]);

  useEffect(() => {
    load();
  }, [load]);

  const norm = rel.replaceAll('\\', '/');
  const base = pathBasename(norm);
  const dir = norm.slice(0, norm.length - base.length);

  const undo = (): void => {
    if (busy || run === undefined || stale || restored) return;
    window.clearTimeout(timer.current);
    if (!armed) {
      setArmed(true);
      timer.current = window.setTimeout(() => setArmed(false), 3000);
      return;
    }
    setArmed(false);
    setBusy(true);
    conn.turnRestore(sessionId, run, [rel]).then(
      (r) => {
        setBusy(false);
        const row = r.results.find((x) => x.path === rel || x.path.replaceAll('\\', '/') === norm);
        if (row !== undefined && row.stale === true) setStale(true);
        else if (row !== undefined && row.ok) {
          setRestored(true);
          notifyGitChanged();
        } else setLoadErr(t('Revert failed', '撤销失败'));
      },
      (err: unknown) => {
        setBusy(false);
        setLoadErr(err instanceof Error ? err.message : String(err));
      },
    );
  };

  return (
    <div className="sx-diff-tab sx-turn-diff" aria-label="turn diff tab">
      <div className="sx-changes-bar sx-turn-diff-head">
        <FileIcon path={norm} />
        {/* 2026-11-11 用户裁定:文件路径正常展示(与文件页签同语言,相对路径自然序 dir+base),
            路径后跟「回到源文件」钮——点击只开源文件页签;diff 细节落在本页签体内,不再有公共「本轮」页签面 */}
        <span className="sx-change-name">{dir !== '' ? `${dir}${base}` : base}</span>
        <span className="sx-changes-bar-actions">
          <button
            type="button"
            className="sx-changes-act"
            aria-label={t('Back to source file', '回到源文件')}
            data-tip={t('Back to source file', '回到源文件')}
            onClick={() => onOpenFile?.(norm)}
          >
            <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {run !== undefined && (
            <button
              type="button"
              className={`sx-changes-act${armed ? ' arm' : ''}`}
              aria-label={t('Revert this file', '撤销此文件')}
              data-tip={
                restored
                  ? t('Reverted', '已撤销')
                  : stale
                    ? t('Changed by a later turn — revert disabled', '后续轮次已再次修改此文件，已停用撤销')
                    : armed
                      ? t('Click again to confirm', '再次点击确认')
                      : t('Revert this file to its state before this turn', '撤销本轮改动(恢复到本轮之前)')
              }
              disabled={busy || stale || restored}
              onClick={undo}
            >
              <Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </span>
      </div>
      {loadErr !== null && <div className="sx-changes-result err">{loadErr}</div>}
      {restored && <div className="sx-changes-result ok" role="status">{t('Reverted to the state before this turn.', '已恢复到本轮之前的状态。')}</div>}
      {content !== null && (
        <div className="sx-change-body sx-turn-diff-body">
          {/* 每刀截断面(2026-11-11「不可展开,直接截断,和审查区分开」):折叠可展开退役 */}
          <DiffLines oldStr={content.oldContent ?? ''} newStr={content.newContent} path={norm} variant="flat" hunksOnly />
        </div>
      )}
    </div>
  );
}

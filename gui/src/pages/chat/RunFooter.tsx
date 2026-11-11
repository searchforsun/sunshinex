import { useState, useRef } from 'react';
import type { ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, GitFork } from 'lucide-react';
import { t } from '../../i18n';
import { fmtTokens, pathBasename } from '../../ui-util';
import { messageTimeMs } from '../../ui-util';
import { useCopyFeedback } from '../../use-copy-feedback';
import type { ChatEntry } from '../../chat-reducer';
import type { TurnFileChange } from '../../../../src/types';
import { FileIcon } from '../../file-icon';
import { ChangeStat, changeCounts } from '../../change-stat';
import { useTurnLatest } from './use-live-changes';
import { useUiMode } from '../../ui-mode';

/** run 尾部操作条与变更汇总（D32 批C-1 拆分自 Chat.tsx）：Worked for 时长/复制/分叉钮与
 *  本轮改动文件变更条——纯渲染件，props 注入。行为零变化（Chat.test 为锚）。
 */

/** run 尾部操作条(G11 §6,对标 Codex 回复工具行):复制该条 md/fork 新会话 + 封段统计
 *  (steps·tokens·HH:mm,数据缺省逐项省略)。常显淡灰(截图裁定),钮 hover 提亮。
 *  onFork 收 run 条目键(2026-11-04 用户裁定「fork 显示点击点之上所有记录」):宿主按 run
 *  在转录中的序位换算轮次,分档切在该轮之前——点哪轮,fork 上面的所有记录 */
export function RunFooter({ text, run, onFork }: { text: string; run: ChatEntry | undefined; onFork?: (runKey: string) => void }): JSX.Element {
  const { status, copy } = useCopyFeedback();
  const time = run?.endedTs !== undefined ? messageTimeMs(run.endedTs) : undefined;
  return (
    <div className="run-footer">
      <TipButton
        tip={status === 'ok' ? t('Copied', '已复制') : t('Copy', '复制')}
        label="copy reply"
        icon={status === 'ok' ? <Check size={14} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
        onClick={() => copy(text)}
      />
      {onFork !== undefined && run !== undefined && <TipButton tip={t('Fork', '分叉')} label="fork session" icon={<GitFork size={14} strokeWidth={1.75} aria-hidden="true" />} onClick={() => onFork(run.key)} />}
      {(run?.steps !== undefined || run?.tokens !== undefined) && (
        <span className="run-stats">
          {run?.steps !== undefined && <span>{t(`${run.steps} steps`, `${run.steps} 步`)}</span>}
          {run?.tokens !== undefined && <span>{fmtTokens(run.tokens)}</span>}
          {time !== undefined && <span>{time}</span>}
        </span>
      )}
    </div>
  );
}

/** G14.100 轮尾变动汇总条(对标 Codex):「N 个文件已更改 +X -Y」折叠条+右侧撤销(整轮);
 *  展开逐文件(图标+名称+目录+±+行尾撤销)。
 *  2026-11-11 用户裁定「每轮修改产生快照写死,快照互不影响,只是当时的快照」冻结渲染:
 *  行=本轮落档记录、行数=冻结 blob 统计(轮内提交不吞、后续轮次不改写)——2026-11-07 的
 *  「∩ 当前 git 变动」动态渲染退役(提交吞数字/跨轮互染两个 bug 的根因);「已撤销」本地退场。
 *  可撤销=有前像且本轮是该文件最后一个改它的轮(后续覆盖=只能看不能撤,服务端 staleness 兜底);
 *  旧档无 checkpoint 数据回退 git restore(HEAD 口径)。撤销二次确认(首击武装 3s) */
export function RunChangesBar({
  changes,
  run,
  onOpenDiff,
  onRestore,
  onOpenTurn,
  onTurnRestore,
}: {
  changes: ReadonlyArray<{ path: string; status: string; added: number | null; deleted: number | null; newLines?: number }>;
  /** 所属 run 条(本轮 diff 寻址/撤销寻址;缺省=旧装配回退 git 语义) */
  run?: Pick<ChatEntry, 'runSeq' | 'turn'>;
  onOpenDiff?: (path: string) => void;
  onRestore?: (path: string) => void;
  /** checkpoint 通道(2026-11-10):开本轮单文件 diff 页签 / 前像回写撤销(staleness 结果逐路径回传) */
  onOpenTurn?: (run: number, path: string) => void;
  onTurnRestore?: (run: number, paths: string[]) => Promise<Array<{ path: string; ok: boolean; stale?: boolean; noCheckpoint?: boolean }>>;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [restored, setRestored] = useState<ReadonlySet<string>>(new Set());
  const [stale, setStale] = useState<ReadonlySet<string>>(new Set());
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<number | undefined>(undefined);
  const office = useUiMode() === 'office';
  const visible = changes.filter((c) => !restored.has(c.path));
  const add = visible.reduce((n, c) => n + changeCounts(c).add, 0);
  const del = visible.reduce((n, c) => n + changeCounts(c).del, 0);
  const runSeq = run?.runSeq;
  const turnOf = (path: string): TurnFileChange | undefined => run?.turn?.find((x) => x.path.replaceAll('\\', '/') === path.replaceAll('\\', '/'));
  // 可撤销=有前像 且 本轮是该文件最后一个改它的轮(后续轮次覆盖=只能看不能撤;TurnLatestContext
  // 由全 entries 汇总,服务端 staleness 闸门兜底)
  const latestByPath = useTurnLatest();
  const undoable = (path: string): boolean => {
    const norm = path.replaceAll('\\', '/');
    const c = turnOf(norm);
    const latest = latestByPath.get(norm);
    return runSeq !== undefined && c !== undefined && (c.before !== undefined || c.beforeDeleted === true) && (latest === undefined || latest === runSeq);
  };
  /** 二次确认武装键:首击武装,3s 内再击执行(审查页 useArm 同款口径) */
  const arm = (key: string, action: () => void): void => {
    window.clearTimeout(armTimer.current);
    if (armed === key) {
      setArmed(null);
      action();
      return;
    }
    setArmed(key);
    armTimer.current = window.setTimeout(() => setArmed(null), 3000);
  };
  const restore = (path: string): void => {
    if (runSeq !== undefined && undoable(path) && onTurnRestore !== undefined) {
      void onTurnRestore(runSeq, [path]).then((results) => {
        const row = results.find((x) => x.path.replaceAll('\\', '/') === path.replaceAll('\\', '/'));
        if (row !== undefined && row.stale === true) setStale((s) => new Set(s).add(path));
        else if (row === undefined || row.ok) setRestored((s) => new Set(s).add(path));
      });
      return;
    }
    onRestore?.(path); // 旧档回退:git restore(HEAD 口径)
    setRestored((s) => new Set(s).add(path));
  };
  const restoreAll = (key: string): void => {
    arm(key, () => {
      if (runSeq !== undefined && onTurnRestore !== undefined) {
        const checkpointPaths = visible.filter((c) => undoable(c.path)).map((c) => c.path);
        const legacyPaths = visible.filter((c) => !undoable(c.path)).map((c) => c.path);
        if (checkpointPaths.length > 0) {
          void onTurnRestore(runSeq, checkpointPaths).then((results) => {
            const okSet = new Set<string>();
            const staleSet = new Set<string>();
            for (const r of results) {
              const norm = r.path.replaceAll('\\', '/');
              if (r.stale === true) staleSet.add(norm);
              else if (r.ok) okSet.add(norm);
            }
            setStale((s) => new Set([...s, ...staleSet]));
            setRestored((s) => new Set([...s, ...okSet]));
          });
        }
        for (const p of legacyPaths) {
          onRestore?.(p);
          setRestored((s) => new Set(s).add(p));
        }
        return;
      }
      visible.forEach((c) => restore(c.path));
    });
  };
  const openDiff = (path: string): void => {
    if (runSeq !== undefined && onOpenTurn !== undefined) onOpenTurn(runSeq, path);
    else onOpenDiff?.(path); // 旧装配/旧档回退审查页
  };
  if (office || visible.length === 0) return null; // 办公模式不显示代码变动(ui-mode.ts)
  return (
    <div className="run-changes" aria-label={t('run changes', '本轮改动')}>
      <div className="run-changes-head">
        <button type="button" className="run-changes-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />}
          <span>
            {t(`${visible.length} files changed`, `${visible.length} 个文件已更改`)}
          </span>
          <span className="run-changes-stat">
            <ChangeStat add={add} del={del} />
          </span>
        </button>
        <button
          type="button"
          className={`run-changes-undo${armed === 'all' ? ' arm' : ''}`}
          data-tip={armed === 'all' ? t('Click again to confirm', '再次点击确认') : t('Revert all changes in this turn', '撤销本轮全部变动')}
          onClick={() => restoreAll('all')}
        >
          {t('Undo', '撤销')}
        </button>
      </div>
      {open && (
        <div className="run-changes-list">
          {visible.map((c) => {
            const norm = c.path.replaceAll('\\', '/');
            const base = pathBasename(norm);
            const dir = norm.slice(0, norm.length - base.length);
            const isStale = stale.has(c.path);
            // 被后续轮次覆盖=只能看不能撤(2026-11-11 用户裁定):仅限有前像的 checkpoint 行——
            // 无前像旧档行(bash 改动)不受影响,照走 git restore 回退
            const superseded = (() => {
              const c = turnOf(norm);
              return c !== undefined && (c.before !== undefined || c.beforeDeleted === true) && !undoable(norm);
            })();
            const armKey = `row:${c.path}`;
            const isArmed = armed === armKey;
            return (
              <div key={c.path} className="run-changes-row">
                <FileIcon path={c.path} />
                <button type="button" className="run-changes-name" onClick={() => openDiff(c.path)}>
                  {base}
                </button>
                <span className="run-changes-dir">{dir}</span>
                <span className="run-changes-stat">
                  <ChangeStat {...changeCounts(c)} />
                </span>
                <button
                  type="button"
                  className={`run-changes-undo-row${isArmed ? ' arm' : ''}`}
                  disabled={isStale || superseded}
                  data-tip={
                    isStale || superseded
                      ? t('Overwritten by a later turn — view only', '后续轮次已覆盖，只能查看')
                      : isArmed
                        ? t('Click again to confirm', '再次点击确认')
                        : t('Revert this file', '撤销此文件')
                  }
                  onClick={() => arm(armKey, () => restore(c.path))}
                >
                  {t('Undo', '撤销')}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}/** 统一图标钮(G11 §8):纯图标 + data-tip Tooltip(视觉层)+ aria-label(可达性/查询锚)。
 *  不用原生 title;复制成功反馈由调用面换 icon/tip,本组件无状态 */
export function TipButton({ tip, label, icon, onClick, className }: { tip: string; label: string; icon: ReactNode; onClick?: () => void; className?: string }): JSX.Element {
  return (
    <button
      type="button"
      className={className !== undefined ? `sx-tip ${className}` : 'sx-tip'}
      aria-label={label}
      data-tip={tip}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}



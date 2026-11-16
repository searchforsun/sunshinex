import { useCallback, useEffect, useState } from 'react';
import { CircleHelp, RefreshCw } from 'lucide-react';
import { SunxIcon } from '../sunx-icon';
import { t } from '../i18n';
import type { Connection, SessionRow } from '../connection';
import { SESSION_KIND_SUNX } from '../connection';
import { relTime, withMinSpin } from '../ui-util';
import { wsName } from '../sidebar/project-menu-util';
import { NewSunxDialog } from '../welcome/NewSunxDialog';
import { aggregateSunxCards, assembleSunxCards, sunxSectionsOf, sunxSnapOf, type SunxCard, type SunxSnapSlice } from './sunx-board';

/**
 * SUNX 总览页(sunx P2 Task 8,spec §17.3 裁定形态):单例 `sunxboard` 页签——应用级(不绑会话,
 * 欢迎页座同渲染)。顶部全局聚合条(运行中实例 n/进行中任务 n/等待确认 n,卡片数据前端推导;2026-11-16 用户裁定「在飞/待裁决」黑话换人话)+
 * 卡片网格(按工作区分节 R10):每实例卡=姓名+状态点+任务进度(进行中/完成计数)+最近活动一行+
 * 等待确认徽标;点卡片 onOpenInstance 上抛(attach 两步/openSession 归 App——spec「点卡片进实例」);
 * 「新建 Sunx」入口卡复用 NewSunxDialog(P1 组件,侧栏接线同款 props 形态)。
 *
 * 数据语义(controller ruling 2,懒快照视图):打开/刷新各拉一次全量(GET /sunx/sessions 域容器
 * 全域枚举——sunx P3 Task 3 数据源改向,逐工作区 sessionsOf+kind 过滤+workspaces 三拉退役)+
 * 逐 live 行 sessionSnapshot bumpSeq:false 只读通道——防抬基线,connection.ts 先例),快照权威
 * 整替(agents 页签刷新先例);不订阅 WS 实时——「打开即所见,刷新即新」。
 * 未挂载行(无 liveSessionId 标注,daemon 只标注运行中)零快照降级:计数归零、待裁决退行级
 * awaiting 布尔;快照拉取失败同降级不炸(行仍在卡)。
 */

export interface SunxBoardTabProps {
  readonly conn: Connection;
  /** App panelRefreshNonce(打开即刷一次;REFRESHABLE_TAB_TYPES 同款) */
  readonly refreshNonce?: number;
  /** 进实例/建会话成功上抛(journalId=attachSunx 直寻址重开;sessionId=新建裸 openSession;App 注入) */
  readonly onOpenInstance?: (target: { journalId?: string; sessionId?: string; root: string }) => void;
}

/** 全量拉取编排:GET /sunx/sessions 单点→live 行双拉(任务账本 sessionTasks+快照 bumpSeq:false)
 *  →卡片;账本/快照任一失败该行降级(null)——不击穿整页。账本=后台任务页签同源(2026-11-16
 *  用户实测「数据不对」根修:委派投影缺后台任务终态,计数恒 0),快照出团队板任务+挂起段 */
async function loadBoard(conn: Connection): Promise<{ cards: SunxCard[] }> {
  const list = await conn.sunxSessions().catch(() => [] as SessionRow[]); // 拉取失败按空清单降级(空态呈现,不炸整页)
  const rows = list.map((x) => ({ ...x, root: x.root ?? '', slug: x.root ?? '' })); // 分节键=工作区根(wsName 显示走 root basename)
  const snaps = new Map<string, SunxSnapSlice>();
  await Promise.all(
    rows
      .filter((x): x is typeof x & { liveSessionId: string } => x.kind === SESSION_KIND_SUNX && x.liveSessionId !== undefined)
      .map(async (x) => {
        const liveId = x.liveSessionId; // 谓词收窄(2026-11-16 技术债补审 I3:替两处 as string)
        const [ledger, snap] = await Promise.all([
          conn.sessionTasks(liveId).catch(() => []), // 账本(后台任务同源;失败=空账本降级)
          conn.sessionSnapshot(liveId, undefined, { bumpSeq: false }).catch(() => null), // 只读通道:防抬 seq 基线;失败该行降级
        ]);
        snaps.set(
          liveId,
          snap !== null
            ? sunxSnapOf(snap, ledger)
            : { ledger, boardTasks: [], pendingCount: 0, awaitingKnown: false }, // 快照缺席:账本计数照用,等待确认退行级 awaitingRow
        );
      }),
  );
  return { cards: assembleSunxCards(rows, (liveId) => snaps.get(liveId) ?? null) };
}

export function SunxBoardTab({ conn, refreshNonce, onOpenInstance }: SunxBoardTabProps): JSX.Element {
  const [cards, setCards] = useState<SunxCard[] | null>(null);
  const [error, setError] = useState('');
  const [fetching, setFetching] = useState(true);
  const [tick, setTick] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const reload = useCallback(() => setTick((v) => v + 1), []);
  useEffect(() => {
    let alive = true;
    setFetching(true);
    withMinSpin(loadBoard(conn)).then(
      (r) => {
        if (alive) {
          setCards(r.cards);
          setError('');
          setFetching(false);
        }
      },
      (e: unknown) => {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setFetching(false);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [conn, tick, refreshNonce]);
  const agg = aggregateSunxCards(cards ?? []);
  const sections = sunxSectionsOf(cards ?? []);
  return (
    <div className="insight-tab sx-sunxboard">
      <div className="insight-bar">
        {/* 顶部全局聚合条(spec §17.3):卡片数据前端推导,零新增后端 */}
        <span className="sx-sunxboard-stats" role="status" aria-label="sunx board aggregate">
          {/* 状态词汇/图标对齐既有体系(2026-11-16 用户裁定):.tb-status-dot 家族=智能体团队板
              同件同尺寸(6px 态点/12px running 转动环);等待确认=CircleHelp(侧栏会话行同件);
              零计数 chip 不显(聚合条降噪) */}
          <span className="sx-sunxboard-stat">
            <span className={`tb-status-dot${agg.running > 0 ? ' task-status-running' : ''}`} aria-hidden="true" />
            {t('Running', '运行中')} {agg.running}
          </span>
          {agg.tasks.running > 0 && (
            <span className="sx-sunxboard-stat">
              <span className="tb-status-dot task-status-running" aria-hidden="true" />
              {t('Active tasks', '进行中任务')} {agg.tasks.running}
            </span>
          )}
          {agg.tasks.pending > 0 && (
            <span className="sx-sunxboard-stat">
              <span className="tb-status-dot task-status-pending" aria-hidden="true" />
              {t('Waiting', '等待')} {agg.tasks.pending}
            </span>
          )}
          {agg.tasks.done > 0 && (
            <span className="sx-sunxboard-stat">
              <span className="tb-status-dot task-status-success" aria-hidden="true" />
              {t('Done', '完成')} {agg.tasks.done}
            </span>
          )}
          {agg.tasks.failed > 0 && (
            <span className="sx-sunxboard-stat">
              <span className="tb-status-dot task-status-failed" aria-hidden="true" />
              {t('Failed', '失败')} {agg.tasks.failed}
            </span>
          )}
          {agg.tasks.cancelled > 0 && (
            <span className="sx-sunxboard-stat">
              <span className="tb-status-dot task-status-cancelled" aria-hidden="true" />
              {t('Cancelled', '已取消')} {agg.tasks.cancelled}
            </span>
          )}
          {agg.awaiting > 0 && (
            <span className="sx-sunxboard-stat">
              <CircleHelp size={14} strokeWidth={1.75} aria-hidden="true" />
              {t('Awaiting input', '等待确认')} {agg.awaiting}
            </span>
          )}
        </span>
        <button type="button" className="sx-changes-act" aria-label="refresh" data-tip={t('Refresh', '刷新')} onClick={reload}>
          <RefreshCw size={14} strokeWidth={1.75} className={fetching ? 'sx-fetching' : undefined} />
        </button>
      </div>
      {error !== '' && <p className="home-error" role="alert">{error}</p>}
      {cards !== null && cards.length === 0 && (
        <div className="board-empty-state" role="status">
          <p className="board-empty-title">{t('No Sunx instances yet', '还没有 Sunx 实例')}</p>
          <p className="board-empty-hint">{t('Sunx instances you create will appear here.', '创建的 Sunx 实例会显示在这里。')}</p>
        </div>
      )}
      {sections.map((sec) => (
        <section key={sec.slug} className="sx-sunxboard-sec" aria-label={`sunx workspace ${wsName({ root: sec.root, slug: sec.slug })}`}>
          {/* 工作区小节头(R10):目录名 basename(wsName 单点,侧栏 SUNX 组同款) */}
          <div className="sx-sunxboard-ws">{wsName({ root: sec.root, slug: sec.slug })}</div>
          <div className="sx-sunxboard-grid">
            {sec.cards.map((c) => {
              const badge = c.awaitingKnown ? c.awaiting > 0 : c.awaitingRow; // 快照缺席退行级 awaitingRow(徽标无数)
              // 任务五态 chips(2026-11-16 用户裁定:图标/大小=团队板 .tb-status-dot 同件;词汇对齐
              // 后台任务语义:stopped=已取消;零计数不显)
              const chips: Array<{ cls: string; label: string; n: number }> = [
                { cls: 'task-status-running', label: t('Active', '进行中'), n: c.tasks.running },
                { cls: 'task-status-pending', label: t('Waiting', '等待'), n: c.tasks.pending },
                { cls: 'task-status-success', label: t('Done', '完成'), n: c.tasks.done },
                { cls: 'task-status-failed', label: t('Failed', '失败'), n: c.tasks.failed },
                { cls: 'task-status-cancelled', label: t('Cancelled', '已取消'), n: c.tasks.cancelled },
              ];
              return (
                <button
                  key={c.journalId}
                  type="button"
                  className="sx-sunxboard-card"
                  onClick={() => onOpenInstance?.({ journalId: c.journalId, root: c.root })}
                >
                  <span className="sx-sunxboard-cardline">
                    <span className={`tb-status-dot${c.live ? ' task-status-running' : ''}`} aria-hidden="true" />
                    <span className="sx-sunxboard-name">{c.name === '' ? t('Untitled Sunx', '未命名 Sunx') : c.name}</span>
                    {badge && (
                      <span className="sx-sunx-badge">
                        {c.awaitingKnown && c.awaiting > 0 ? `${t('Awaiting input', '等待确认')} ${c.awaiting}` : t('Awaiting input', '等待确认')}
                      </span>
                    )}
                  </span>
                  <span className="sx-sunxboard-progress">
                    {chips.filter((x) => x.n > 0).length === 0 ? (
                      t('No tasks', '暂无任务')
                    ) : (
                      chips.filter((x) => x.n > 0).map((x) => (
                        <span key={x.cls} className="sx-sunxboard-chip">
                          <span className={`tb-status-dot ${x.cls}`} aria-hidden="true" />
                          {x.label} {x.n}
                        </span>
                      ))
                    )}
                  </span>
                  <span className="sx-sunxboard-activity">
                    {c.lastActivity.label !== '' ? `${c.lastActivity.label} · ` : ''}
                    {relTime(c.lastActivity.ts)}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {/* 「新建 Sunx」入口卡(spec §17.3:与实例卡同网格语义;复用 P1 弹窗,props 形态=侧栏接线同款) */}
      <button type="button" className="sx-sunxboard-entry" aria-label="new sunx" onClick={() => setDialogOpen(true)}>
        <SunxIcon size={14} strokeWidth={1.75} aria-hidden="true" />
        {t('New Sunx', '新建 Sunx')}
      </button>
      {dialogOpen && (
        <NewSunxDialog
          open
          onClose={() => setDialogOpen(false)}
          conn={conn}
          onOpenSession={(sessionId, root) => onOpenInstance?.({ sessionId, root })} // 新建=canonical,裸 openSession
        />
      )}
    </div>
  );
}

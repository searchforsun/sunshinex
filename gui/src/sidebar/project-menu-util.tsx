import { useEffect, useState } from 'react';
import type { WorkspaceRow } from '../connection';
import { loadStoredMap, pathBasename, persistCappedMap, relTime, shortLocalTime } from '../ui-util';
import { t } from '../i18n';
import { zoomScale } from '../ui-zoom';
import { Archive, Clock, GitBranch, Layers, Pin } from 'lucide-react';

/** ProjectMenu 纯助手层（D32 中口径件批 PM-1 平移源,行为零变化）:
 *  模糊匹配/添加工作区图标/已读持久化/显示名与统计行/工作区可见性。 */

/** G14.75 模糊匹配:大小写不敏感子序列(字符依次命中即过);空查询恒真 */
export function fuzzyHit(text: string, query: string): boolean {
  if (query.trim() === '') return true;
  let i = 0;
  const t = text.toLowerCase();
  for (const ch of query.trim().toLowerCase()) {
    i = t.indexOf(ch, i);
    if (i < 0) return false;
    i += 1;
  }
  return true;
}

/** 添加工作区图标(2026-10-22 用户裁定定稿):正常文件夹(带页耳)右上角截断,+ 填充缺口,
 *  + 上侧与文件夹图标上侧(页耳顶 y=3)齐平 */
export function FolderAddIcon({ size = 16, strokeWidth = 1.75 }: { size?: number; strokeWidth?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 10.5V18a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.89L10.25 5.5a2 2 0 0 0 1.66.9H13" />
      <path d="M18.75 1.5v5.5" />
      <path d="M15.5 4.25h6.5" />
    </svg>
  );
}

/** 附加面板 + 钮图标(2026-10-23 用户裁定:沿用新建项目图标同款笔形——圆帽粗描 SVG,
 *  退役文本字符「+」;居中十字,stroke 2 与 FolderAddIcon 同语言) */
export function PlusAddIcon({ size = 16, strokeWidth = 2 }: { size?: number; strokeWidth?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5.5v13" />
      <path d="M5.5 12h13" />
    </svg>
  );
}

/** G14.195 已读会话持久化(localStorage `sunshinex.seen-sessions`):id → 最近已读 updatedAt。
 *  刷新不再全员亮蓝点(原内存 Set「本次运行内」即清空);行 updatedAt 新于已读时刻即重新视为
 *  未读(真·未读)。容量封顶 200(超出丢最旧),存储满/禁用静默。 */
const SEEN_KEY = 'sunshinex.seen-sessions';
export type SeenMap = Record<string, number>;
export function loadSeenMap(): SeenMap {
  return loadStoredMap<number>(SEEN_KEY);
}
export function persistSeenMap(m: SeenMap): void {
  persistCappedMap(SEEN_KEY, m, 200, (v) => v);
}

/** 已读戳单点(2026-10-23 落底层):localStorage 即时 + /app/seen 服务端双写(断链/旧 daemon 静默)。
 *  返回落库 promise——联动上抛须待其落定,否则侧栏重拉读到旧档(竞态同 pin)。
 *  conn 取结构性子集(测试桩/旧连接缺 saveAppSeen 即跳过远端,探活口径同 sessionTasks) */
export function stampSeen(
  conn: { saveAppSeen?: (m: Record<string, number>) => Promise<void> },
  journalId: string,
  at: number,
): Promise<void> {
  const seen = loadSeenMap();
  seen[journalId] = at;
  persistSeenMap(seen);
  if (typeof conn.saveAppSeen !== 'function') return Promise.resolve();
  return conn.saveAppSeen(seen).then(() => undefined, () => undefined);
}

/** 遗留档(无 root)显示名:去尾部 hash、dash→空格——slug 是给机器的,人读的是路径词 */
function legacyName(slug: string): string {
  return slug.replace(/-[0-9a-f]{8}$/i, '').replace(/-/g, ' ');
}

/** G14.115 RECENTS 分页显形:默认 10 条(约近 3 天窗),「显示更多」步进 10,上限=全量;收起复位 */
export const RECENT_VISIBLE_DEFAULT = 10;
export const RECENT_VISIBLE_STEP = 10;

/** 会话统计行(G14.17 回溯面):旁车 meta 有几段拼几段——轮/步/建档时刻;RECENTS 与搜索行
 *  tooltip 消费,空 meta 返回 ''(行 tooltip 退化为标题+id)。结构面签名(轮/步/建档时刻,
 *  本地时区单点——项目组行原 UTC 切片分叉已收编) */
export function sessionMetaLine(r: { runs?: number; steps?: number; createdAt?: string }, branch?: string): string {
  // G14.106 会话行 tooltip 收敛两行:会话名称(调用方拼)+「N 轮 M 步 · 创建于 时间」——
  // tokens/缓存/上文/模型/孤立 id 等全家桶退役。2026-10-24 用户裁定:前插分支信息(如 dev1,有则显)
  const parts: string[] = [];
  if (branch) parts.push(branch);
  if (r.runs !== undefined) parts.push(t(`${r.runs} run${r.runs === 1 ? '' : 's'}`, `${r.runs} 轮`));
  if (r.steps !== undefined) parts.push(t(`${r.steps} step${r.steps === 1 ? '' : 's'}`, `${r.steps} 步`));
  if (r.createdAt !== undefined) parts.push(t(`created ${shortLocalTime(r.createdAt)}`, `创建于 ${shortLocalTime(r.createdAt)}`));
  return parts.join(' · ');
}

/** 行内「归档」确认 morph 钮(确认态=红确认钮,常态=归档图标钮;点外取消由宿主
 *  useConfirmOutsideCancel 承载)——项目组行/最近会话行/置顶行三面同款(D41 G6a 收敛;
 *  确认态悬浮提示为三面统一补齐——图标钮场景按 §13.1 规则 4 应有提示) */
export function ArchiveConfirmButton(props: {
  readonly active: boolean;
  readonly rowId: string;
  readonly onArm: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  return props.active ? (
    <button
      type="button"
      className="sx-archive-confirm"
      aria-label={`${t('Confirm archive', '确认归档')} ${props.rowId}`}
      data-tip={t('Confirm archive', '确认归档')}
      onClick={(e) => {
        e.stopPropagation();
        props.onConfirm();
      }}
    >
      {t('Confirm', '确认')}
    </button>
  ) : (
    <button
      type="button"
      className="sx-iconbtn"
      data-tip={t('Archive', '归档')}
      aria-label={`${t('Archive', '归档')} ${props.rowId}`}
      onClick={(e) => {
        e.stopPropagation();
        props.onArm();
      }}
    >
      <Archive size={13} strokeWidth={1.75} />
    </button>
  );
}

/** 会话行悬浮卡数据(2026-10-26 用户裁定四段制):完整会话名/分支/轮次步数/建档时刻;
 *  2026-10-27 增补:rootPath=所属项目根路径(名下细分割线后换行展示) */
export interface SessionRowInfo {
  readonly branch?: string;
  readonly runs?: number;
  readonly steps?: number;
  readonly createdAt?: string;
  readonly rootPath?: string;
}

/** 会话行悬浮卡(2026-10-26 用户裁定,文本 data-tip 退役):固定宽 280,仅应用宽度不够时收缩
 *  (min 160);四段信息——①会话名占一到多行(换行不省略)②分支图标+分支名③图标+轮次·步数
 *  ④时钟图标+建档时刻,②③④各占一行,宽度不够尾部省略。fixed 定位贴侧栏右缘,行垂直居中;
 *  视觉测量写入本地样式按 D50 契约 /zoomScale() 归一 */
function SessionHoverCard(props: {
  readonly label: string;
  readonly info: SessionRowInfo;
  /** 锚点视觉坐标(summary 中心)与侧栏右缘(视觉 px) */
  readonly anchor: { top: number; height: number; menuRight: number };
}): JSX.Element {
  const z = zoomScale();
  // 低应用宽度不越视口:余量不足时收缩,下限 120(2026-10-27 用户裁定「不要超出视口」)
  const avail = (window.innerWidth - props.anchor.menuRight - 12) / z;
  const width = Math.max(120, Math.min(280, avail));
  const { branch, runs, steps, createdAt, rootPath } = props.info;
  const stats: string[] = [];
  if (runs !== undefined) stats.push(t(`${runs} run${runs === 1 ? '' : 's'}`, `${runs} 轮`));
  if (steps !== undefined) stats.push(t(`${steps} step${steps === 1 ? '' : 's'}`, `${steps} 步`));
  return (
    <div
      className="sx-sess-card"
      style={{ left: (props.anchor.menuRight + 4) / z, top: (props.anchor.top + props.anchor.height / 2) / z, width }}
    >
      <div className="sx-sess-card-name">{props.label}</div>
      {/* 2026-10-27 用户裁定:名下细分割线+所属项目根路径(换行不省略,越视口由宽度钳制兜底) */}
      {rootPath !== undefined && rootPath !== '' && (
        <>
          <div className="sx-sess-card-divider" role="separator" />
          <div className="sx-sess-card-path" title={rootPath}>
            {rootPath}
          </div>
        </>
      )}
      {branch !== undefined && branch !== '' && (
        <div className="sx-sess-card-row">
          <GitBranch size={12} strokeWidth={1.75} />
          <span>{branch}</span>
        </div>
      )}
      {stats.length > 0 && (
        <div className="sx-sess-card-row">
          <Layers size={12} strokeWidth={1.75} />
          <span>{stats.join(' · ')}</span>
        </div>
      )}
      {createdAt !== undefined && (
        <div className="sx-sess-card-row">
          <Clock size={12} strokeWidth={1.75} />
          <span>{t(`created ${shortLocalTime(createdAt)}`, `创建于 ${shortLocalTime(createdAt)}`)}</span>
        </div>
      )}
    </div>
  );
}

/** 会话行（项目组行/最近会话行两组共用，D41 G6b 收敛；DOM 以 RECENTS 形为准——projects 行
 *  注释自称「与最近会话行同款」而 tooltip 落点漂在整行，归一到标题 span）：置顶钮（pin 未传
 *  =不渲染）+运行/未读状态点+标题（悬浮卡贴标题）+相对时间+归档确认 morph。open 已在
 *  调用方闭包好各自寻址形（组行 3 参/recents 2 参）与 root 缺省守卫 */
export function SessionRow(props: {
  readonly rowId: string;
  readonly label: string;
  readonly info: SessionRowInfo;
  readonly updatedAt: number;
  readonly active: boolean;
  readonly running: boolean;
  readonly unseen: boolean;
  readonly busy: boolean;
  readonly onOpen: () => void;
  readonly pin?: { onPin: () => void };
  readonly confirmId: string;
  readonly onArm: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  const dot =
    props.running ? (
      <span className="sx-session-dot running" />
    ) : props.unseen ? (
      <span className="sx-session-dot unseen" />
    ) : null;
  // 悬浮卡显隐(2026-10-26 四段卡替代文本 tip):enter 锚 summary 量位,leave/行点击即收
  const [hover, setHover] = useState<{ top: number; height: number; menuRight: number } | null>(null);
  return (
    <li
      data-row-id={props.rowId}
      className={`session-row sx-session-row${props.active ? ' active' : ''}`}
      data-session-row="1"
      onClick={() => {
        setHover(null);
        if (props.busy) return;
        props.onOpen();
      }}
    >
      {props.pin !== undefined && (
        <button type="button" className="sx-pin-btn" data-tip={t('Pin', '置顶')}
          aria-label={`${t('Pin', '置顶')} ${props.rowId}`}
          onClick={(e) => {
            e.stopPropagation();
            props.pin?.onPin();
          }}
        >
          <Pin size={16} strokeWidth={1.75} />
        </button>
      )}
      {dot}
      <span className="session-summary" data-id={props.rowId}
        onMouseEnter={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const menu = e.currentTarget.closest('.sx-menu');
          setHover({ top: r.top, height: r.height, menuRight: menu !== null ? menu.getBoundingClientRect().right : r.right });
        }}
        onMouseLeave={() => setHover(null)}
      >
        {props.label}
      </span>
      {hover !== null && <SessionHoverCard label={props.label} info={props.info} anchor={hover} />}
      <span className="session-meta">{relTime(props.updatedAt)}</span>
      <span className="session-row-actions">
        <ArchiveConfirmButton
          active={props.confirmId === props.rowId}
          rowId={props.rowId}
          onArm={props.onArm}
          onConfirm={props.onConfirm}
        />
      </span>
    </li>
  );
}

/** 工作区显示名:真实项目目录名(basename),路径 slug 仅兜底/悬浮(2026-10-08 可读性裁定:
 *  路径 slug「D-project-bi-mammoth-internal-410e80d4」换行破碎不可读——目录名才是用户心智的项目名) */
/** default 锚点唯一化(G14.10):临时锚 <tmp>/sunshinex-default 在场时,旧仓库内 default
 *  工作区行隐藏(目录与历史会话保留,RECENTS/搜索仍可达)——两个「default」行只示其一 */
export function visibleWorkspaces(rows: WorkspaceRow[]): WorkspaceRow[] {
  // G14.34:默认锚点工作区(sunshinex-default,非项目会话的落点)不再入 PROJECTS 列表——
  // 其会话仍经 RECENTS 可达(attach 只需 root/slug,与工作区行在场与否无关)
  return rows.filter((r) => {
    if (r.root === undefined) return true;
    if (pathBasename(r.root) === 'sunshinex-default') return false; // G14.34:默认锚点不入 PROJECTS(会话走 RECENTS)
    return true;
  });
}

export function wsName(row: { root?: string; slug: string }): string {
  if (row.root !== undefined && row.root !== '') {
    const base = pathBasename(row.root);
    if (base !== '') return base;
  }
  return legacyName(row.slug);
}

/** 行内「确认」morph 点外部取消(2026-10-21 用户裁定:归档/删除二次确认,点击其他地方即取消):
 *  confirmId 非空时挂 document mousedown——点击落在确认行(data-row-id=confirmId)外即清;
   mousedown 先于 click,点他行「归档/删除」时先取消旧再入列新,时序自洽。三面共用
   (归档层删除/项目组行归档/最近会话行归档) */
export function useConfirmOutsideCancel(confirmId: string, cancel: () => void): void {
  useEffect(() => {
    if (confirmId === '') return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target instanceof Element ? e.target.closest(`[data-row-id="${confirmId}"]`) : null;
      if (target !== null) return; // 确认行内点击(含「确认」钮本体)不取消
      cancel();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [confirmId, cancel]);
}

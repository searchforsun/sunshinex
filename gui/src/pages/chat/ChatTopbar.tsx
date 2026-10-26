import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, PanelLeft } from 'lucide-react';
import { t } from '../../i18n';
import type { Connection } from '../../connection';
import type { NavControls } from '../../nav-history';
import { NavButtons } from '../../NavButtons';
import { SessionRowMenu } from '../../sidebar/session-row-menu';
import { loadSeenMap, persistSeenMap, stampSeen } from '../../sidebar/project-menu-util';

/** 会话顶栏(D32 第六批批F-3 自 Chat.tsx 平移,行为零变化):标题(空/改/显三态,点击重命名)
 *  + 动态计数钮(待办/任务板)+ 侧栏展开钮。标题编辑态与草稿留宿主。
 *  批F-7d:ChatDynButtons 自宿主整迁本文件(唯一消费方,值回引环消解)。 */

/** G14.177 顶栏动态计数按钮(待办/任务/后台任务):转圈图标+数量;点击开对应页签。
 *  G14.213 原子化三改:①仅运行中显示(轮次收束即隐,待办是否完结无关);②侧栏展开不再隐藏
 *  (挂载点去掉 collapsed 门);③幽灵钮化——无底色。
 *  G14.2xx 用户裁定:常显(旧「顶栏 hover 浮现」退役);三钮图标统一灰色转圈(待办钮的绿对号
 *  退役——对号读作「已完成数」与计数语义相反;todoActive 本就是 in_progress+pending 之和) */
export function ChatDynButtons({ todoActive, taskActive, running, conn, sessionId, onOpenTab }: {
  todoActive: number;
  taskActive: number;
  running: boolean;
  conn: Connection;
  sessionId: string;
  onOpenTab?: (type: 'tasks' | 'agents' | 'bgtasks') => void;
}): JSX.Element | null {
  const [bgRunning, setBgRunning] = useState(0);
  useEffect(() => {
    // 测试桩/旧连接可能未实现 sessionTasks——探活失败静默零计数(按钮全隐,不炸树)
    if (typeof conn.sessionTasks !== 'function') return;
    let alive = true;
    const poll = (): void => {
      Promise.resolve()
        .then(() => conn.sessionTasks(sessionId))
        .then(
          (rows) => {
            if (alive) setBgRunning(rows.filter((r) => r.status === 'running').length);
          },
          () => undefined,
        )
          // 轮询失败按计数保持降级(顶栏徽标非权威数据,下一拍重拉)
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [conn, sessionId]);
  // G14.213 轮次收束即隐:running 熄灭按钮组整体不显(待办/任务是否完结无关)
  if (!running || (todoActive === 0 && taskActive === 0 && bgRunning === 0)) return null;

  return (
    <div className="chat-dyn-buttons" role="group" aria-label="live counters">
      {todoActive > 0 && (
        <button type="button" className="chat-dyn-btn todo" data-tip={t('Open todos', '打开待办')} onClick={() => onOpenTab?.('tasks')}>
          <span className="run-spinner" aria-hidden="true" />
          {t(`${todoActive} todos`, `${todoActive} 待办`)}
        </button>
      )}
      {taskActive > 0 && (
        <button type="button" className="chat-dyn-btn" data-tip={t('Open task board', '打开任务板')} onClick={() => onOpenTab?.('agents')}>
          <span className="run-spinner" aria-hidden="true" />
          {t(`${taskActive} tasks`, `${taskActive} 任务`)}
        </button>
      )}
      {bgRunning > 0 && (
        <button type="button" className="chat-dyn-btn" data-tip={t('Open background tasks', '打开后台任务')} onClick={() => onOpenTab?.('bgtasks')}>
          <span className="run-spinner" aria-hidden="true" />
          {t(`${bgRunning} background`, `${bgRunning} 后台任务`)}
        </button>
      )}
    </div>
  );
}
export interface ChatTopbarProps {
  readonly fixedTitle: string | undefined;
  readonly titleEditing: boolean;
  readonly titleDraft: string;
  readonly setTitleDraft: (v: string) => void;
  readonly commitTitle: () => void;
  readonly setTitleEditing: (v: boolean) => void;
  readonly displayTitle: string;
  readonly sessionId: string;
  readonly tokens: number;
  readonly steps: number;
  readonly running: boolean;
  readonly todoActive: number;
  readonly taskActive: number;
  readonly conn: Connection;
  readonly onOpenTab?: ((type: 'tasks' | 'agents' | 'bgtasks') => void);
  /** 归档态(2026-10-21):快照播种对齐——true 显徽标+撤销钮,false 显归档钮(确认 morph) */
  readonly archived: boolean;
  /** 归档/撤销归档上抛(落 conn.archiveSession;本地 archived 同步归宿主 Chat) */
  readonly onArchive: (archived: boolean) => void;
  /** 会话档身份(置顶档寻址——journalId 跨重启稳定) */
  readonly journalId?: string;
  /** 会话工作区根(置顶条目快照字段) */
  readonly root?: string;
  /** 会话数据变更上抛(置顶/归档/标记未读后,宿主 bump 侧栏联动刷新) */
  readonly onSessionsMutated?: () => void;
  /** 2026-10-24 用户裁定:[|] 切换钮=菜单关闭态显示在会话名左(呼出);菜单开着时收起钮在菜单头右上(不双显) */
  readonly menuClosed?: boolean;
  readonly onToggleMenu?: () => void;
  /** 2026-10-25 应用级导航(前进/后退)控制面(App 壳持历史);缺场不渲染钮对(旁路 Chat 免配) */
  readonly nav?: NavControls;
  /** 2026-10-27 电脑控制指示:控制类 computer-use 工具条在跑(use-chat-derived 派生)——顶栏会话名行右亮「正在控制」边框徽标 */
  readonly computerUseActive?: boolean;
}

export function ChatTopbar(props: ChatTopbarProps): JSX.Element {
  const { fixedTitle, titleEditing, titleDraft, setTitleDraft, commitTitle, setTitleEditing, displayTitle, sessionId, running, todoActive, taskActive, computerUseActive, conn, onOpenTab, archived, onArchive, journalId, root, onSessionsMutated, menuClosed, onToggleMenu, nav } = props;
  // ⋯ 会话操作菜单(2026-10-22 用户裁定:归档直连钮收敛为 ⋯ 弹窗——置顶⇄/归档⇄,运行中禁用)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 归档二次弹窗确认(2026-10-23 用户裁定):菜单点「归档会话」不直执行,先弹 确认归档|取消
  const [askArchive, setAskArchive] = useState<{ x: number; y: number } | null>(null);
  // 2026-10-24 用户裁定「能显示全就显示全」:标题隐现 mask 仅在真溢出时挂(RO 判 scrollWidth)
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const [titleClipped, setTitleClipped] = useState(false);
  useEffect(() => {
    const el = titleRef.current;
    if (el === null) return;
    const judge = (): void => setTitleClipped(el.scrollWidth > el.clientWidth + 1);
    judge();
    const ro = new ResizeObserver(judge);
    ro.observe(el);
    return () => ro.disconnect();
  }, [displayTitle]);
  const [pinned, setPinned] = useState(false);
  const loadPinned = (): void => {
    if (journalId === undefined) return;
    conn.appPins().then(
      (r) => setPinned(r.pins.some((p) => p.id === journalId)),
      () => undefined,
    );
  };
  /** 已读面压制到 at(stampSeen 单点:localStorage 即时+服务端双写)——置顶时与钉档时间戳对齐用 */
  const touchSeen = (at: number): Promise<void> =>
    journalId === undefined ? Promise.resolve() : stampSeen(conn, journalId, at);
  const togglePin = (): void => {
    if (journalId === undefined) return;
    conn.appPins().then(
      (r) => {
        // 以服务端现态为准取反(组件态可能过期——过期态定向翻转即「反了」)
        const isPinned = r.pins.some((p) => p.id === journalId);
        const now = Date.now();
        const rest = r.pins.filter((p) => p.id !== journalId);
        const next = isPinned ? rest : [...rest, { id: journalId, root: root ?? '', title: displayTitle, updatedAt: now }];
        setPinned(!isPinned);
        const settle = (): void => {
          // 置顶即正在看:已读戳压到与钉档同一时刻——钉组按钉档时刻判未读,不同刻恒亮蓝点(用户实测病);
          // 双写都落库后再联动,联动 GET 读到的才是新档
          const chain = isPinned ? Promise.resolve() : touchSeen(now);
          void chain.then(onSessionsMutated, onSessionsMutated);
        };
        void conn.saveAppPins(next).then(settle, settle);
      },
      () => undefined,
    );
  };
  const copyText = (text: string): void => {
    void navigator.clipboard?.writeText(text).then(() => undefined, () => undefined);
  };
  const markUnread = (): void => {
    if (journalId === undefined) return;
    const seen = loadSeenMap();
    delete seen[journalId];
    persistSeenMap(seen); // 本地标记已即时生效——联动成败都上抛(旧 daemon PUT 404 不吞联动)
    if (typeof conn.saveAppSeen !== 'function') {
      onSessionsMutated?.();
      return;
    }
    void conn.saveAppSeen(seen).then(onSessionsMutated, onSessionsMutated);
  };
  const menuItems = [
    {
      id: 'pin',
      label: pinned ? t('Unpin session', '取消置顶会话') : t('Pin session', '置顶会话'),
      // 已归档冻结置顶态(2026-10-22 用户裁定):取消归档后才可调节
      disabled: running || archived,
      onSelect: () => {
        // 只调 togglePin——它按服务端现态取反且落库后才上抛联动;此处再 loadPinned()
        // 会 GET 到 PUT 落库前的旧档,把刚置的状态打回去(「第一次无效、后续反向」元凶)
        togglePin();
      },
    },
    {
      id: 'archive',
      label: archived ? t('Unarchive session', '取消归档会话') : t('Archive session', '归档会话'),
      disabled: running,
      onSelect: () => {
        if (archived) onArchive(false);
        else setAskArchive(menu); // 二次确认弹窗(坐标沿用菜单锚点;菜单项回调里 menu 必非空)
      },
    },
    { id: 'divider-1', divider: true, label: '', onSelect: () => undefined },
    {
      id: 'rename',
      label: t('Rename session', '重命名会话'),
      onSelect: () => {
        setTitleDraft(displayTitle);
        setTitleEditing(true);
      },
    },
    {
      id: 'mark-unread',
      label: t('Mark as unread', '标记为未读'),
      onSelect: () => {
        markUnread(); // 联动已内含(落库后上抛)
      },
    },
    { id: 'divider-2', divider: true, label: '', onSelect: () => undefined },
    {
      id: 'copy-id',
      label: t('Copy session ID', '复制会话 ID'),
      onSelect: () => copyText(sessionId),
    },
    {
      id: 'copy-path',
      label: t('Copy path', '复制路径'),
      onSelect: () => copyText(root ?? ''),
    },
  ];
  return (
    <header className="chat-topbar">
        {/* 2026-10-25 应用级导航(前进/后退):菜单关闭态才驻顶栏最左——菜单开着时由菜单头承载
            (2026-10-25 用户裁定「菜单存在显示在菜单里,收起才显示在当前位置」,单点不双显) */}
        {nav !== undefined && menuClosed === true && <NavButtons nav={nav} />}
        {/* 2026-10-24 用户裁定(二轮修正):[|] 仅菜单关闭态显示在会话名左(呼出);菜单开着时收起钮
            在菜单头右上,不双显。会话名不点击改名(⋯ 菜单→弹窗),长度随主栏 flex 收放 */}
        {menuClosed === true && (
          <button
            type="button"
            className="sx-winbtn sx-menu-toggle"
            aria-label="toggle menu"
            data-tip={t('Open menu', '打开菜单')}
            onClick={onToggleMenu}
          >
            <PanelLeft size={16} strokeWidth={1.75} />
          </button>
        )}
        {fixedTitle === '' ? (
          // G14.32 辅助对话:顶栏无标题(标签页已具名,双显冗余)
          <span className="chat-title" />
        ) : titleEditing ? (
          /* 2026-10-24 用户裁定:改名=弹窗(⋯ 菜单「重命名会话」触发),内联输入退役 */
          <div className="modal-overlay" onClick={() => setTitleEditing(false)}>
            <div className="modal-body rename-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="dirpicker-head">{t('Rename session', '重命名会话')}</div>
              <input
                className="chat-title-input"
                value={titleDraft}
                maxLength={40}
                autoFocus
                aria-label={t('Session title', '会话标题')}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitTitle();
                  if (e.key === 'Escape') setTitleEditing(false);
                }}
              />
              <div className="dirpicker-foot">
                <button onClick={() => setTitleEditing(false)}>{t('Cancel', '取消')}</button>
                <button className="primary" onClick={commitTitle}>{t('Confirm', '确认')}</button>
              </div>
            </div>
          </div>
        ) : (
          <span className="chat-title" data-tip={displayTitle} /* 2026-10-25 用户裁定:hover 只显完整会话名,不缀 sessionId/tokens/steps */
            data-session-id={sessionId} /* 机器可读面(e2e openSessionId 解析锚点,视觉零影响) */>
            <span className="chat-title-btn">
              <span className={`chat-title-text${titleClipped ? ' clipped' : ''}`} ref={titleRef}>{displayTitle}</span>
            </span>
            {/* G14.52:运行态圆点迁侧栏会话行左缘(顶栏不再双显) */}
          </span>
        )}
        {/* ⋯ 会话操作钮(2026-10-22 用户裁定:归档直连钮收敛为 ⋯ 弹窗——置顶⇄/归档⇄,运行中禁用)。
            辅助对话不渲染(2026-10-23 用户裁定:fixedTitle==='' 即辅助会话,无会话级操作面)。
            2026-10-24 用户裁定:紧跟标题左聚(不再被计数钮的 auto 边距推到最右),计数钮居其右 */}
        {fixedTitle !== '' && (
          <button type="button" className="sx-iconbtn" data-tip={t('Session actions', '会话操作')}
            aria-label={t('Session actions', '会话操作')}
            onMouseDown={(e) => e.stopPropagation()} // 锚钮自身不触发 document 外点收(toggle 不被击穿)
            onClick={(e) => {
              e.stopPropagation();
              setAskArchive(null); // 重开菜单时收掉残留确认弹窗
              loadPinned();
              if (menu !== null) { setMenu(null); return; } // toggle:再点 ⋯ 收起
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: Math.round(r.right), y: Math.round(r.bottom) });
            }}
          >
            <MoreHorizontal size={16} strokeWidth={1.75} />
          </button>
        )}
        <ChatDynButtons todoActive={todoActive} taskActive={taskActive} running={running} conn={conn} sessionId={sessionId} onOpenTab={onOpenTab} />
        {/* 2026-10-27 用户裁定:电脑控制期间会话名行右亮「正在控制」边框徽标(控制类 computer-use
            工具在跑,use-chat-derived 派生,轮收束即隐) */}
        {computerUseActive === true && (
          <span className="sx-controlling-badge" role="status">
            {t('Sunshinex is controlling your computer', 'Sunshinex 正在控制你的电脑')}
          </span>
        )}
        {archived && <span className="sx-archived-badge">{t('Archived', '已归档')}</span>}
        {/* 2026-10-24 拖拽重构:顶栏窗拖拽单点落本空白带(顶栏左聚布局,钮全在带左,带吸右侧余量)——
            旧「容器 drag+按钮挖孔」在 CSS zoom 下拖拽位图挖孔坐标错位,抽屉态窗控簇([|]−□×)真实
            按下被吞(用户实测「抽屉态 [|] 点不动」根因);空白带与一切按钮几何互斥,无孔可挖 */}
        <div className="sx-topbar-drag" aria-hidden="true" />
        {menu !== null && fixedTitle !== '' && (
          <SessionRowMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems} />
        )}
        {askArchive !== null && fixedTitle !== '' && (
          // 归档二次确认弹窗(同款弹层件;外点/Esc 即取消)
          <SessionRowMenu
            x={askArchive.x}
            y={askArchive.y}
            onClose={() => setAskArchive(null)}
            items={[
              { id: 'confirm', label: t('Confirm archive', '确认归档'), onSelect: () => onArchive(true) },
              { id: 'cancel', label: t('Cancel', '取消'), onSelect: () => undefined },
            ]}
          />
        )}
        {/* [|] 侧栏开关退役(2026-10-23 用户裁定):全局唯一切换钮=右上窗控簇(桌面)/固定右上钮(web) */}
    </header>
  );
}

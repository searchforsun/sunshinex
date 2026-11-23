import { memo, useMemo, useState } from 'react';
import { Archive, ChevronRight, Settings } from 'lucide-react';
import { t, useLanguage } from '../i18n';
import { SessionRow as SessionRowView, useConfirmOutsideCancel } from './project-menu-util';
import { platformMeta } from './use-menu-channels';
import type { ChannelSessionRow } from './use-menu-channels';

/**
 * 侧栏「通道」分组(channels Task 13,spec §9.1;2026-11-22 用户裁定「整体布局对齐项目——一个
 * 应用通道相当于一个项目,下面展开才显示某个会话,同样支持归档等能力,复用已有的布局,不要自己
 * 造」):ProjectsSection 同构克隆——分区头(「通道」可折叠+数量 chip)+通道组行(workspace-row
 * 族:平台图标占目录位+应用名称+计数 chip,点击展开/收起)+组内会话行=标准 SessionRowView
 * (右对齐相对时间/运行·待问·未读圆点/悬浮信息卡/行内归档两段确认,与项目会话行同件)。
 *  - 分组键=SessionRow.channel(通道配置 id);组名=应用名称(channelName)回退通道 id。
 *  - 归档行滤除主列表(archive 后由 /sessions/archived 通道域随列进「归档会话」层,撤销/删除
 *    走宿主既有 archive 链——daemon 兜底三扫 projects/sunx/channels,2026-11-22 同裁定)。
 *  - 点击会话行 → attach(root, journalId) 直寻址重开(sunxAttach 同语义)。
 * 纯渲染件:数据/动作 props 注入,分区折叠/组开合/归档确认态本组件自持。
 */
interface ChannelsSectionProps {
  /** 通道域聚合行(跨域;null=装载中);空列=组整块不渲染 */
  readonly rows: ChannelSessionRow[] | null;
  readonly activeSessionId: string;
  readonly runningIds: ReadonlySet<string>;
  readonly journalOfSession: ReadonlyMap<string, string>;
  readonly isUnseen: (id: string, updatedAt: number) => boolean;
  readonly busy: boolean;
  /** 条目点击链:宿主注入 attachJournal(root, journalId) 两步链(行 root=域目录直寻址) */
  readonly onAttach: (root: string, journalId: string, journalUpdatedAt?: number) => void;
  /** 行内归档(ProjectsSection T6 同款:宿主落库+宿主重拉;确认 morph 由本组件 confirmId 承载) */
  readonly onArchiveRow: (id: string, archived: boolean) => void;
  /** 归档通道层入口(2026-11-22 用户裁定「通道归档和 sunx 一样单独归档」:组头归档箱钮→宿主
   *  开 archiveScope='channel' 专域;可选——未配时钮不渲染,旧测试桩零牵连) */
  readonly onOpenArchive?: () => void;
  /** 通道配置页跳转(2026-11-22 用户裁定「具体应用最右侧增加配置图标,跳转对应设置页」) */
  readonly onOpenSettings?: () => void;
}

/** 域目录 → 聊天工作区完整路径（2026-11-22 用户裁定「悬浮卡既要显示会话 id,也要显示工作目录」）:
 *  `<域目录>/workspace`（channelChatWorkspaceRoot 铸造面;分隔符随行 root 形态）——仅悬浮卡展示,
 *  行 attach 寻址仍用域目录(root,resolveDataDir 归约回 <域>/data)。空根守卫=undefined(工作区行缺席) */
const workspaceOf = (domainDir: string | undefined): string | undefined => {
  if (domainDir === undefined || domainDir === '') return undefined;
  const sep = domainDir.includes('\\') ? '\\' : '/';
  return domainDir.endsWith('\\') || domainDir.endsWith('/') ? `${domainDir}workspace` : `${domainDir}${sep}workspace`;
};

export const ChannelsSection = memo(function ChannelsSection(props: ChannelsSectionProps): JSX.Element | null {
  useLanguage(); // memo 响应面:语言同步(en→zh)强制重渲染,区块头标签随 t() 调用时求值归位
  const { rows, activeSessionId, runningIds, journalOfSession, isUnseen, busy, onAttach, onArchiveRow, onOpenArchive, onOpenSettings } = props;
  /** 分区折叠(本组件自持) */
  const [open, setOpen] = useState(true);
  /** 通道组开合(2026-11-22 项目式布局:缺省全展开,收起集自持——与项目 openSlugs 缺省收起刻意
   *  分叉:通道数少且 IM 会话常以最新一条为关注点,展开态免一次点击) */
  const [closedKeys, setClosedKeys] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = (key: string): void => {
    setClosedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  /** T6 行内归档确认 morph:存确认中的行 id(''=无;行级单份,他行点击即换位) */
  const [confirmId, setConfirmId] = useState('');
  useConfirmOutsideCancel(confirmId, () => setConfirmId('')); // 点外部取消归档确认(用户裁定)
  /** 通道分组(纯派生):归档行滤除→按通道配置 id 聚组→组内/组间 updatedAt 降序 */
  const groups = useMemo(() => {
    if (rows === null) return null;
    const byKey = new Map<string, { key: string; name: string; platform?: ChannelSessionRow['platform']; sessions: ChannelSessionRow[] }>();
    for (const r of rows) {
      if (r.archived === true) continue; // 归档行进归档层(见组件注),组列表滤除
      const key = r.channel !== undefined && r.channel !== '' ? r.channel : r.channelLabel;
      const g = byKey.get(key) ?? { key, name: r.channelLabel, platform: r.platform, sessions: [] };
      if (r.channelName !== undefined) g.name = r.channelName;
      if (r.platform !== undefined) g.platform = r.platform;
      g.sessions.push(r);
      byKey.set(key, g);
    }
    const list = [...byKey.values()];
    for (const g of list) g.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    list.sort((a, b) => Math.max(...b.sessions.map((s) => s.updatedAt)) - Math.max(...a.sessions.map((s) => s.updatedAt)));
    return list;
  }, [rows]);
  // 空容器不渲染组(channels Task 13 裁定③;装载中 null 同口径整块不渲染——通道域按需出现,
  // 零通道零噪音,与 SUNX「常驻+空态行」是刻意分叉)
  if (groups === null || groups.length === 0) return null;
  return (
    <>
      <div
        className="sx-side-head sx-side-head-row sx-side-head-btn"
        role="button"
        aria-expanded={open}
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span>{t('Channels', '通道')}</span>
        <ChevronRight size={14} strokeWidth={2} aria-hidden="true" className={`sx-side-chev${open ? ' open' : ''}`} />
        <span className="sx-side-head-actions">
          {/* 计数 chip 在图标钮**左**(2026-11-22 用户裁定「数字显示在行图标按钮前面,和其他保持一致」) */}
          <span className="sx-sunx-count" aria-label="channel count">{groups.length}</span>
          {/* 归档通道层入口(项目组头归档箱钮同款;2026-11-22 用户裁定「通道归档单独成域」) */}
          {onOpenArchive !== undefined && (
            <button type="button" className="sx-iconbtn" data-tip={t('Archived channels', '归档通道')}
              aria-label="archived channels"
              onClick={(e) => { e.stopPropagation(); onOpenArchive(); }}>
              <Archive size={14} strokeWidth={1.75} />
            </button>
          )}
        </span>
      </div>
      <div className={`sx-collapse sx-collapse-sunx${open ? ' open' : ''}`}>
        <ul className="workspace-list sx-groups" aria-label="channel groups">
          {groups.map((g) => {
            const meta = platformMeta(g.platform);
            const PlatformIcon = meta.Icon;
            const gOpen = !closedKeys.has(g.key);
            return (
              <li key={g.key} className="workspace-item" style={{ position: 'relative' }}>
                <div className="workspace-row" style={{ display: 'flex', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="workspace-toggle sx-group-head"
                    aria-expanded={gOpen}
                    onClick={() => toggleGroup(g.key)}
                  >
                    <span className="sx-ws-folder" aria-hidden="true" data-tip={t(meta.en, meta.zh)}>
                      <PlatformIcon size={16} strokeWidth={1.75} />
                    </span>
                    <span className="ws-slug sx-ws-name">{g.name}</span>
                  </button>
                  {/* 行尾簇(2026-11-22 用户裁定:计数在图标钮左,最右=通道配置跳转钮) */}
                  <span className="ws-row-actions">
                    <button
                      type="button"
                      className="ws-count sx-count"
                      aria-label={`${t('Sessions', '会话数')} ${g.sessions.length}`}
                      onClick={() => toggleGroup(g.key)}
                    >
                      {g.sessions.length}
                    </button>
                    {onOpenSettings !== undefined && (
                      <button
                        type="button"
                        aria-label={`${t('Channel settings', '通道设置')} ${g.key}`}
                        className="sx-iconbtn"
                        data-tip={t('Channel settings', '通道设置')}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenSettings();
                        }}
                      >
                        <Settings size={14} strokeWidth={1.75} />
                      </button>
                    )}
                  </span>
                </div>
                <div className={`sx-collapse${gOpen ? ' open' : ''}`}>
                  <ul className="session-list" aria-label="channel sessions">
                    {g.sessions.map((sr) => {
                      // G14.2xx running 身份按会话记(与项目组行同口径)
                      const active =
                        activeSessionId !== '' &&
                        (sr.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === sr.id);
                      const running = active
                        ? runningIds.has(activeSessionId)
                        : sr.liveSessionId !== undefined && sr.liveSessionId !== activeSessionId;
                      const label = sr.title ?? sr.firstUser ?? t('New session', '新会话');
                      return (
                        <SessionRowView
                          key={sr.id}
                          rowId={sr.id}
                          label={label}
                          info={{
                            runs: sr.runs,
                            steps: sr.steps,
                            createdAt: sr.createdAt,
                            chatId: sr.chatId, // 平台聊天会话标识(悬浮卡显示+复制)
                            rootPath: workspaceOf(sr.root), // 悬浮卡工作区行=完整 workspace 目录(2026-11-22 裁定;attach 仍走 sr.root 域目录)
                          }}
                          updatedAt={sr.updatedAt}
                          active={active}
                          running={running}
                          awaiting={sr.awaiting === true}
                          unseen={isUnseen(sr.id, sr.updatedAt)}
                          busy={busy}
                          onOpen={() => {
                            if (busy) return;
                            onAttach(sr.root, sr.id, sr.updatedAt); // 条目点击=attach(root, journalId) 直寻址链
                          }}
                          confirmId={confirmId}
                          onArm={() => setConfirmId(sr.id)}
                          onConfirm={() => { setConfirmId(''); onArchiveRow(sr.id, true); }}
                        />
                      );
                    })}
                  </ul>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
});

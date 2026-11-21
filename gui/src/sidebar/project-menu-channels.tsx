import { memo, useMemo, useState } from 'react';
import { CircleHelp, ChevronRight } from 'lucide-react';
import { t, useLanguage } from '../i18n';
import { relTime } from '../ui-util';
import { platformMeta } from './use-menu-channels';
import type { ChannelSessionRow } from './use-menu-channels';

/**
 * 侧栏「通道」分组(channels Task 13,spec §9.1;project-menu-sunx.tsx 平移先例):通道域容器
 * 会话聚合组——独立容器专属枚举面(GET /channels/sessions)的呈现层。行=平台图标(平台名
 * data-tip 权威,行面保持紧凑)+聊天标识(通道配置 id/domainSlug 兜底)+会话标题;点击 →
 * attach(row.root, journalId) 直寻址重开(sunxAttach 同语义——宿主注入既有 attachJournal 两步
 * 链:newSession(root) 装壳落在行 root 域 + attach journalId 播种)。平铺单列(recent-list 行族
 * 同款);空容器/装载中整块不渲染组(与 SUNX 常驻组刻意分叉——通道域按需出现)。组头=「通道」
 * 标题(可折叠)+数量 chip;无组头动作簇(spec §9.1 未定义通道组看板/归档/新建面,最小呈现)。
 * 纯渲染件:数据/动作 props 注入,折叠态本组件自持。
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
}

export const ChannelsSection = memo(function ChannelsSection(props: ChannelsSectionProps): JSX.Element | null {
  useLanguage(); // memo 响应面:语言同步(en→zh)强制重渲染,区块头标签随 t() 调用时求值归位
  const { rows, activeSessionId, runningIds, journalOfSession, isUnseen, busy, onAttach } = props;
  /** 分区折叠(本组件自持——宿主只管 Projects/Recents 折叠与归档层,过滤组内聚) */
  const [open, setOpen] = useState(true);
  const sorted = useMemo(() => {
    if (rows === null) return null;
    const list = [...rows];
    list.sort((a, b) => b.updatedAt - a.updatedAt); // 更新时间新→旧(sunx 默认序同款)
    return list;
  }, [rows]);
  // 空容器不渲染组(channels Task 13 裁定③;装载中 null 同口径整块不渲染——通道域按需出现,
  // 零通道零噪音,与 SUNX「常驻+空态行」是刻意分叉)
  if (sorted === null || sorted.length === 0) return null;
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
          {/* 数量值:通道行数计数 chip(与 SUNX 组头同款) */}
          <span className="sx-sunx-count" aria-label="channel count">{sorted.length}</span>
        </span>
      </div>
      <div className={`sx-collapse sx-collapse-sunx${open ? ' open' : ''}`}>
        <ul className="recent-list" aria-label="channel sessions">
          {sorted.map((sr) => {
            const active =
              activeSessionId !== '' &&
              (sr.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === sr.id);
            const running = active
              ? runningIds.has(activeSessionId)
              : sr.liveSessionId !== undefined && sr.liveSessionId !== activeSessionId;
            const label = sr.title ?? sr.firstUser ?? t('New session', '新会话');
            const meta = platformMeta(sr.platform);
            const PlatformIcon = meta.Icon;
            return (
              <li
                key={sr.id}
                data-row-id={sr.id}
                className={`session-row${active ? ' active' : ''}`}
                onClick={() => {
                  if (busy) return;
                  onAttach(sr.root, sr.id, sr.updatedAt); // 条目点击=attach(root, journalId) 直寻址链
                }}
              >
                {sr.awaiting === true ? (
                  <span className="sx-session-dot asking">
                    <CircleHelp size={16} strokeWidth={1.75} />
                  </span>
                ) : running ? (
                  <span className="sx-session-dot running" />
                ) : isUnseen(sr.id, sr.updatedAt) && !active ? (
                  <span className="sx-session-dot unseen" />
                ) : null}
                <span className="session-summary" data-id={sr.id}>
                  {/* 平台图标位(平台名 data-tip 权威;行面紧凑——图标+聊天标识+标题三段) */}
                  <span className="sx-channel-plt" data-tip={meta.zh}>
                    <PlatformIcon size={14} strokeWidth={1.75} aria-hidden="true" />
                  </span>
                  <span className="sx-channel-tag">{sr.channelLabel}</span>
                  <span>{label}</span>
                </span>
                <span className="session-meta">{relTime(sr.updatedAt)}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
});

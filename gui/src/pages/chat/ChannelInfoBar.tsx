import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { pathBasename, relTime } from '../../ui-util';
import { platformMeta } from '../../sidebar/use-menu-channels';
import type { ChannelBindingMsg, ChannelConfigMsg } from '../../connection-api';
import type { WorkspaceRow } from '../../connection';

/**
 * Chat 聊天信息条(channels Task 13,spec §9.3):激活会话属通道域(journalId 命中
 * channelBindings() 某行)时渲染在 Chat 头部区——只读:平台(图标+名)/通道实例名/聊天 id
 * (+单聊群聊标,chatKind 随 binding 透出即显,wire 未透出不臆测)/锁定用户(first-user)/
 * 绑定时间/**工作区归属三态**「沙箱域」/「沙箱域 · 下次 /new 将切至 <目标>」/「真实项目:
 * <path>」(沙箱判据=通道配置 root==='auto' 聊天专属域缺省形态;rootOverride 在场未生效=
 * 待生效态并列)。可编辑两项:①绑定工作区下拉(聊天专属域(当前)/注册项目)→
 * putChannelBinding(key,{rootOverride}) 写面——**下次 /new(或解绑重聊)生效,当前会话不动**
 * 文案常驻提示;②解绑按钮(确认 morph)→ deleteChannelBinding(key),下一条 IM 消息起全新
 * 会话(等价 IM 侧 /new),解除即隐。非通道会话不渲染(journalId 不命中/缺席=整块 null;
 * 会话级 mode/model 复用 Chat 顶部既有控件不另造,spec §9.3)。
 */

/** 信息条连接面(结构满足即收;App 实传整只 Connection 运行时满足)。全可选声明(ChatTopbar
 *  editorsList 同款守卫先例):旧测试桩/旁路 conn 缺名=不订阅不渲染,零牵连 */
export interface ChannelInfoBarConn {
  channelBindings?(): Promise<{ bindings: ChannelBindingMsg[] }>;
  settingsChannels?(): Promise<{ channels: ChannelConfigMsg[]; warnings: string[] }>;
  workspaces?(): Promise<WorkspaceRow[]>;
  putChannelBinding?(key: string, patch: { rootOverride?: string | null }): Promise<{ ok: true }>;
  deleteChannelBinding?(key: string): Promise<{ ok: true }>;
}

/** 绑定键拆解单点:key=`channelId:chatId`,channelId 惯例不含 ':'(engine/router 裁定)——
 *  首 ':' 切分,chatId 段保留其余(含 ':' 等保留字) */
function splitBindingKey(key: string): { channelId: string; chatId: string } {
  const i = key.indexOf(':');
  return i < 0 ? { channelId: key, chatId: '' } : { channelId: key.slice(0, i), chatId: key.slice(i + 1) };
}

interface ChannelInfoBarProps {
  readonly conn: ChannelInfoBarConn;
  /** 激活会话 journal 档案 id(命中绑定档 journalId 才渲染;缺席=非通道面整块 null) */
  readonly journalId?: string;
}

export function ChannelInfoBar(props: ChannelInfoBarProps): JSX.Element | null {
  const { conn, journalId } = props;
  const [binding, setBinding] = useState<ChannelBindingMsg | null>(null);
  const [cfg, setCfg] = useState<ChannelConfigMsg | undefined>(undefined);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** 绑定档/通道配置/注册项目三源并行装载:journalId 换会话即重查(命中才落 binding——
   *  非通道会话 binding 恒 null=不渲染);配置读面失败降级(归属态按缺省「auto 沙箱」呈现) */
  useEffect(() => {
    setBinding(null);
    setCfg(undefined);
    setConfirmOpen(false);
    if (journalId === undefined || journalId === '') return;
    // 旧测试桩/旁路 conn 缺名守卫(ChatTopbar editorsList 同款):不订阅不渲染,零牵连
    if (typeof conn.channelBindings !== 'function') return;
    let alive = true;
    void Promise.all([
      conn.channelBindings(),
      typeof conn.settingsChannels === 'function'
        ? conn.settingsChannels().catch(() => ({ channels: [], warnings: [] }))
        : Promise.resolve({ channels: [], warnings: [] }),
      typeof conn.workspaces === 'function' ? conn.workspaces().catch(() => []) : Promise.resolve([]),
    ])
      .then(([b, cfgs, ws]) => {
        if (!alive) return;
        const hit = b.bindings.find((x) => x.journalId === journalId);
        if (hit === undefined) {
          setBinding(null);
          return;
        }
        setBinding(hit);
        setCfg(cfgs.channels.find((c) => c.id === splitBindingKey(hit.key).channelId));
        setWorkspaces(ws);
      })
      .catch(() => {
        if (alive) setBinding(null);
      });
    return () => {
      alive = false;
    };
  }, [conn, journalId]);
  if (binding === null) return null;
  const { channelId, chatId } = splitBindingKey(binding.key);
  const meta = platformMeta(cfg?.platform);
  const PlatformIcon = meta.Icon;
  /** 工作区归属三态(spec §9.3):cfg 缺席按缺省「auto=聊天专属沙箱域」口径;rootOverride
   *  在场=待生效态并列(下次 /new /解绑重聊才切,当前会话不动) */
  const override = binding.rootOverride;
  const base = cfg === undefined || cfg.root === 'auto' ? t('Sandbox domain', '沙箱域') : `${t('Real project', '真实项目')}: ${cfg.root}`;
  const ownership =
    override !== undefined && override !== ''
      ? `${base} · ${t(`Switches to ${override} on next /new`, `下次 /new 将切至 ${override}`)}`
      : base;
  /** rootOverride 下拉改值:写 putChannelBinding 全量定态(null=清除切回聊天专属域)+本地
   *  乐观回显(服务端落盘后档面 updatedAt 变,本条下次挂载自然对齐) */
  const changeOverride = (v: string): void => {
    if (typeof conn.putChannelBinding !== 'function') return; // 旧桩缺写面:本地态照更,零往返
    const next = v === '' ? null : v;
    setBinding((prev) => (prev === null ? prev : { ...prev, rootOverride: next === null ? undefined : next }));
    void conn.putChannelBinding(binding.key, { rootOverride: next });
  };
  /** 解绑(确认 morph 后):deleteChannelBinding → 下一条 IM 消息起全新会话(等价 IM 侧 /new);
   *  成功/失败都收条(失败下次挂载自然回显,不阻塞用户当前会话) */
  const confirmUnbind = (): void => {
    if (typeof conn.deleteChannelBinding !== 'function') {
      setBinding(null); // 旧桩缺写面:解除即隐(与成功同拍,不打扰当前会话)
      return;
    }
    void conn.deleteChannelBinding(binding.key).then(() => setBinding(null), () => setBinding(null));
  };
  const chatKindLabel =
    binding.chatKind === 'group' ? t('group', '群聊') : binding.chatKind === 'direct' ? t('direct', '单聊') : '';
  return (
    <div className="channel-info-bar" role="status" data-channel-key={binding.key}>
      {/* 平台(图标+名)/通道实例名/聊天 id(+单聊群聊标) */}
      <span className="channel-info-plt">
        <PlatformIcon size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>{meta.zh}</span>
      </span>
      <span className="channel-info-item" data-tip={t('Channel instance', '通道实例')}>{channelId}</span>
      <span className="channel-info-item" data-tip={t('Chat ID', '聊天 ID')}>
        {t('Chat', '聊天')} {chatId}
        {chatKindLabel !== '' && <span className="channel-info-chip">{chatKindLabel}</span>}
      </span>
      {/* 锁定用户(first-user 模式;缺席不渲染) */}
      {binding.lockedUserId !== undefined && binding.lockedUserId !== '' && (
        <span className="channel-info-item" data-tip={t('Locked user (first-user)', '锁定用户(first-user)')}>
          {t('Locked', '锁定')} {binding.lockedUserId}
        </span>
      )}
      {/* 绑定时间 */}
      <span className="channel-info-item" data-tip={t('Bound at', '绑定时间')}>
        {t('Bound', '绑定于')} {relTime(binding.updatedAt)}
      </span>
      {/* 工作区归属三态(只读) */}
      <span className="channel-info-item channel-info-own" data-tip={t('Workspace attribution', '工作区归属')}>
        {ownership}
      </span>
      {/* 可编辑①:绑定工作区切换(聊天专属域(当前)/注册项目)——下次 /new 生效,当前会话不动 */}
      <select
        className="channel-ws-select"
        aria-label={t('Binding workspace', '绑定工作区')}
        value={binding.rootOverride ?? ''}
        onChange={(e) => changeOverride(e.target.value)}
      >
        <option value="">{t('Chat-owned domain (current)', '聊天专属域(当前)')}</option>
        {workspaces
          .filter((w) => w.root !== undefined && w.root !== '')
          .map((w) => (
            <option key={w.root} value={w.root}>{pathBasename(w.root ?? '')}</option>
          ))}
      </select>
      <span className="channel-info-hint">{t('Applies on next /new — current session unchanged', '下次 /new 生效,当前会话不动')}</span>
      {/* 可编辑②:解绑(确认 morph;下一条 IM 消息起全新会话,等价 IM 侧 /new) */}
      {confirmOpen ? (
        <span className="channel-unbind-confirm">
          <span className="channel-info-hint">{t('Next IM message starts a fresh session', '下一条 IM 消息起全新会话')}</span>
          <button type="button" className="channel-unbind-btn" onClick={confirmUnbind}>
            {t('Confirm unbind', '确认解绑')}
          </button>
          <button type="button" className="channel-unbind-cancel" onClick={() => setConfirmOpen(false)}>
            {t('Cancel', '取消')}
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="channel-unbind-btn"
          aria-label={t('Unbind', '解绑')}
          data-tip={t('Unbind — next IM message starts a fresh session', '解绑——下一条 IM 消息起全新会话')}
          onClick={() => setConfirmOpen(true)}
        >
          {t('Unbind', '解绑')}
        </button>
      )}
    </div>
  );
}

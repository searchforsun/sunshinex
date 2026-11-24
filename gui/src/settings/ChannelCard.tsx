import { Pencil, PlugZap, Trash2 } from 'lucide-react';
import { t } from '../i18n';
import { Switch } from './components';
import { allowLabel, displayNameOf, modeLabel, platformLabel } from './channel-drafts';
import type { ChannelDraft } from './channel-drafts';
import type { ChannelHealthRowMsg } from '../connection-api';

/**
 * 通道卡片件（D112 拆分件三，自 ChannelsPane 平迁）：ProvidersPane sx-rc 克隆形——
 * 状态点(健康轮询 connected)+应用名称(显示名单点)+平台副标+操作簇(删除/试连/编辑/
 * 启用 Switch)+信息体(App ID/工作区/权限模式/准入)。
 * 删除=单击开**确认弹窗**（2026-11-23 用户裁定「删除增加弹窗确认,不是原地二次确认」——
 * 真删除该应用+相关会话记录+数据目录,弹窗文案明示不可恢复）。
 */
export function ChannelCard({ d, healthRow, busy, onDelete, onTest, onEdit, onToggle }: {
  readonly d: ChannelDraft;
  /** 健康轮询行(状态点数据源;缺行=未连接态) */
  readonly healthRow: ChannelHealthRowMsg | undefined;
  /** 写面在途门(单通道在途:保存/删除/试连/Switch 共用——禁再发) */
  readonly busy: boolean;
  /** 删除钮(单击=宿主开确认弹窗,非原地确认) */
  readonly onDelete: () => void;
  readonly onTest: () => void;
  readonly onEdit: () => void;
  readonly onToggle: () => void;
}): JSX.Element {
  return (
    <li className="sx-rc">
      <div className="sx-rc-head">
        <span className={`sx-api-dot ${healthRow?.connected ? 'present' : 'missing'}`} data-tip={healthRow?.detail ?? ''} aria-hidden="true" />
        <span className="sx-rc-title">{displayNameOf(d)}</span>
        <span className="sx-rc-subtitle">{platformLabel(d.platform)}</span>
        <span className="sx-rc-head-acts">
          {/* 裸图标按钮必带 hover 提示(2026-11-22 全局规范,见 CLAUDE.md);单击开删除确认弹窗 */}
          <button
            type="button"
            className="sx-iconbtn sx-del-iconbtn"
            aria-label={`${t('Delete', '删除')} ${d.id}`}
            data-tip={t('Delete', '删除')}
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="sx-iconbtn"
            aria-label={`${t('Test connection', '测试连接')} ${d.id}`}
            data-tip={t('Test connection', '测试连接')}
            disabled={busy}
            onClick={onTest}
          >
            <PlugZap size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="sx-iconbtn"
            aria-label={`${t('Edit', '编辑')} ${d.id}`}
            data-tip={t('Edit', '编辑')}
            disabled={busy}
            onClick={onEdit}
          >
            <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <Switch on={d.enabled} onToggle={onToggle} ariaLabel={`${t('Enable', '启用')} ${d.id}`} disabled={busy} />
        </span>
      </div>
      {/* 卡片信息体(2026-11-22 用户裁定:创建后显示较大的信息卡,非单独一行) */}
      <div className="sx-rc-info">
        {d.platform === 'feishu' && d.appId !== '' && (
          <div className="sx-rc-info-row"><span>{t('App ID', 'App ID')}</span><span>{d.appId}</span></div>
        )}
        <div className="sx-rc-info-row">
          <span>{t('Workspace', '工作区')}</span>
          <span>{d.rootText === '' ? t('Default workspace', '默认工作区') : d.rootText}</span>
        </div>
        <div className="sx-rc-info-row"><span>{t('Access mode', '权限模式')}</span><span>{modeLabel(d.mode)}</span></div>
        <div className="sx-rc-info-row"><span>{t('Admission', '准入')}</span><span>{allowLabel(d)}</span></div>
      </div>
    </li>
  );
}

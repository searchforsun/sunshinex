import { FolderOpen } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { t } from '../i18n';
import { CHANNEL_PLATFORMS } from '../sidebar/use-menu-channels';
import { ErrorBanner, ModalField } from './components';
import { MultiSelect, SecretInput, Select } from './controls';
import { COMMAND_OPTIONS, NAME_MAX, NAME_PLACEHOLDERS, platformLabel } from './channel-drafts';
import type { AllowKind, ChannelForm, ChannelModal, ModeValue } from './channel-drafts';

/**
 * 通道弹窗表单件（D112 拆分件二，自 ChannelsPane 平迁零行为变化）：EditorModal 的字段面——
 * 平台(新增可选/编辑锁定)/应用名称/按平台凭证(飞书 App ID+App Secret;Telegram Bot Token,均
 * SecretInput 回显)/工作区(文本框+pickFolder 钮,空=聊天专属)/权限模式(full-access 红字警示)/
 * 准入(list 展开 userIds textarea,all 红字警示)/聊天命令(MultiSelect)。表单真值经 setForm
 * 上抛（Pane 自持），校验错误行内（formError）。
 */
export function ChannelModalForm({ modal, form, setForm, formError, onPickFolder }: {
  readonly modal: ChannelModal;
  readonly form: ChannelForm;
  readonly setForm: Dispatch<SetStateAction<ChannelForm>>;
  readonly formError: string;
  /** 工作区文件夹选择(路径与执行环境页同款):window.sunshinex.pickFolder */
  readonly onPickFolder: () => void;
}): JSX.Element {
  return (
    <>
      <ModalField label={t('Platform', '平台')}>
        {modal.mode === 'add' ? (
          <Select
            ariaLabel={t('Platform', '平台')}
            value={form.platform}
            placeholder={t('Choose a platform…', '选择平台…')}
            options={CHANNEL_PLATFORMS.filter((p) => p.supports).map((p) => ({ v: p.v, l: t(p.en, p.zh) }))}
            onChange={(v: string) => setForm({ ...form, platform: v })}
          />
        ) : (
          <Select
            ariaLabel={t('Platform', '平台')}
            value={form.platform}
            disabled
            options={[{ v: form.platform, l: platformLabel(form.platform) }]}
            onChange={() => undefined}
          />
        )}
      </ModalField>
      <ModalField label={t('App name', '应用名称')}>
        <input
          className="sx-setting-input"
          aria-label={t('App name', '应用名称')}
          value={form.name}
          maxLength={NAME_MAX}
          placeholder={t(NAME_PLACEHOLDERS[form.platform]?.en ?? 'My bot', NAME_PLACEHOLDERS[form.platform]?.zh ?? '我的机器人')}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          spellCheck={false}
        />
      </ModalField>
      {/* 凭证区(按平台;密钥内联回显——2026-11-22 裁定;SecretInput 眼睛显隐切换) */}
      {form.platform === 'feishu' && (
        <>
          <ModalField label={t('App ID', 'App ID')}>
            <input
              className="sx-setting-input"
              aria-label={t('App ID', 'App ID')}
              value={form.appId}
              placeholder="cli_aaaa0000bbbb1111"
              onChange={(e) => setForm({ ...form, appId: e.target.value })}
              spellCheck={false}
            />
          </ModalField>
          <ModalField label={t('App secret', 'App Secret')}>
            <SecretInput ariaLabel={t('App secret', 'App Secret')} value={form.secret} onChange={(v) => setForm({ ...form, secret: v })} />
          </ModalField>
        </>
      )}
      {form.platform === 'telegram' && (
        <ModalField label={t('Bot Token', 'Bot Token')} hint={t('Get it from @BotFather on Telegram', '在 Telegram 向 @BotFather 获取')}>
          <SecretInput
            ariaLabel={t('Bot Token', 'Bot Token')}
            value={form.secret}
            autoComplete="new-password"
            onChange={(v) => setForm({ ...form, secret: v })}
          />
        </ModalField>
      )}
      <ModalField label={t('Workspace', '工作区')}>
        <div className="sx-setting-path">
          <input
            type="text"
            className="sx-setting-input"
            aria-label={t('Workspace', '工作区')}
            value={form.rootText}
            placeholder={t('Default workspace', '默认工作区')}
            onChange={(e) => setForm({ ...form, rootText: e.target.value })}
            spellCheck={false}
          />
          <button
            type="button"
            className="sx-setting-path-btn"
            aria-label={`${t('Browse', '浏览')} ${t('Workspace', '工作区')}`}
            onClick={onPickFolder}
          >
            <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </ModalField>
      <ModalField label={t('Access mode', '权限模式')}>
        <Select
          ariaLabel={t('Access mode', '权限模式')}
          value={form.mode}
          options={[
            { v: 'read-only', l: t('Read-only', '只读') },
            { v: 'acceptEdits', l: t('Accept edits', '接受编辑') },
            { v: 'full-access', l: t('Full access', '完全访问') },
          ]}
          onChange={(v) => setForm({ ...form, mode: v as ModeValue })}
        />
        {form.mode === 'full-access' && (
          <p className="sx-provider-warn" role="alert">
            {t(
              'Full access lets chat run commands and write files in this workspace — only for channels you personally use.',
              '完全访问允许聊天在该工作区执行命令与写盘——仅建议用于本人使用的通道。',
            )}
          </p>
        )}
      </ModalField>
      <ModalField label={t('Admission', '准入')}>
        <Select
          ariaLabel={t('Admission', '准入')}
          value={form.allowKind}
          options={[
            { v: 'first-user', l: t('First respondent only', '仅首次对话用户') },
            { v: 'list', l: t('Custom allow-list', '自定义白名单') },
            { v: 'all', l: t('Open to everyone', '不限') },
          ]}
          onChange={(v) => setForm({ ...form, allowKind: v as AllowKind })}
        />
        {form.allowKind === 'list' && (
          <textarea
            className="sx-setting-input"
            aria-label={t('Allowed user IDs', '白名单 userIds')}
            rows={3}
            value={form.userIdsText}
            placeholder={t('User ids separated by spaces, commas or newlines', '空格/逗号/换行分隔的 userId')}
            spellCheck={false}
            onChange={(e) => setForm({ ...form, userIdsText: e.target.value })}
          />
        )}
        {form.allowKind === 'all' && (
          <p className="sx-provider-warn" role="alert">
            {t(
              'Anyone who finds the bot can start sessions — strongly discouraged for public bots.',
              '任何发现该机器人的用户都能开启会话——公开机器人强烈不建议。',
            )}
          </p>
        )}
      </ModalField>
      <ModalField label={t('Chat commands', '聊天命令')} hint={t('Choose which commands work in the chat.', '选择聊天里可以使用的命令。')}>
        <MultiSelect
          ariaLabel={t('Chat commands', '聊天命令')}
          values={form.commands}
          options={COMMAND_OPTIONS.map((o) => ({ v: o.v, l: t(o.en, o.zh) }))}
          allLabel={{ en: 'All commands', zh: '全部命令' }}
          noneLabel={{ en: 'None', zh: '不开启' }}
          onChange={(next) => setForm({ ...form, commands: next })}
        />
      </ModalField>
      {formError !== '' && <ErrorBanner text={formError} />}
    </>
  );
}

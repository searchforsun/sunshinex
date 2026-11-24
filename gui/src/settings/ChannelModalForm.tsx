import { FolderOpen } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { t } from '../i18n';
import { CHANNEL_PLATFORMS } from '../sidebar/use-menu-channels';
import { ErrorBanner, ModalField } from './components';
import { MultiSelect, SecretInput, Select } from './controls';

/** 思考强度档(2026-11-23 用户裁定「可以选择默认的模型和强度」):EFFORT_ORDER 子集(滑杆同款
 *  六档,标签复用 effortLabel);'' =跟随全局默认(选项前置) */
const EFFORT_OPTIONS: ReadonlyArray<{ v: string }> = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ v }));
import { COMMAND_OPTIONS, NAME_MAX, NAME_PLACEHOLDERS, platformLabel } from './channel-drafts';
import { effortLabel } from '../effort-slider';
import type { AllowKind, ChannelForm, ChannelModal, ModeValue } from './channel-drafts';
import type { SunxTemplateEntry } from '../connection-types';

/**
 * 通道弹窗表单件（D112 拆分件二，自 ChannelsPane 平迁零行为变化）：EditorModal 的字段面——
 * 平台(新增可选/编辑锁定)/应用名称/按平台凭证(飞书 App ID+App Secret;Telegram Bot Token,均
 * SecretInput 回显)/工作区(文本框+pickFolder 钮,空=聊天专属)/会话模式(普通会话|Sunx 编排,
 * 2026-11-24 用户裁定——Sunx 展开品性模板下拉+品性 textarea,/new 仅品性复用)/权限模式
 * (full-access 红字警示)/准入(list 展开 userIds textarea,all 红字警示)/聊天命令(MultiSelect)。
 * 表单真值经 setForm 上抛（Pane 自持），校验错误行内（formError）。
 */
export function ChannelModalForm({ modal, form, setForm, formError, onPickFolder, modelChoices, sunxTemplates }: {
  readonly modal: ChannelModal;
  readonly form: ChannelForm;
  readonly setForm: Dispatch<SetStateAction<ChannelForm>>;
  readonly formError: string;
  /** 工作区文件夹选择(路径与执行环境页同款):window.sunshinex.pickFolder */
  readonly onPickFolder: () => void;
  /** 全局模型清单(2026-11-23 用户裁定「可以选择默认的模型和强度」):GET /models choices */
  readonly modelChoices: ReadonlyArray<{ id: string; model: string }>;
  /** 品性模板清单(GET /settings/sunx-templates 未遮蔽行,Pane 弹窗开启时拉取):选中即全文回填
   *  品性 textarea(可改)——GUI 新建 Sunx 弹窗同款挑选交互(2026-11-24 用户裁定通道支持 Sunx 模式) */
  readonly sunxTemplates: ReadonlyArray<SunxTemplateEntry>;
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
      {/* 会话模式(2026-11-24 用户裁定「创建通道时支持选择模式:普通会话还是 Sunx」):Sunx=各聊天
          建 Sunx 编排会话(品性冻结层,/new 重建仅品性复用——会话级,全异步驱动);展开品性模板下拉+
          textarea,模板选中即全文回填可改(GUI 新建 Sunx 同款交互) */}
      <ModalField label={t('Session mode', '会话模式')}>
        <Select
          ariaLabel={t('Session mode', '会话模式')}
          value={form.sessionKind}
          options={[
            { v: 'standard', l: t('Standard chat', '普通会话') },
            { v: 'sunx', l: t('Sunx orchestration', 'Sunx 编排') },
          ]}
          onChange={(v) => setForm({ ...form, sessionKind: v as ChannelForm['sessionKind'] })}
        />
        {form.sessionKind === 'sunx' && (
          <>
            {sunxTemplates.length > 0 && (
              <Select
                ariaLabel={t('Charter template', '品性模板')}
                value=""
                placeholder={t('Pick a template…', '从模板选择…')}
                options={sunxTemplates.map((tp) => ({ v: tp.id, l: tp.description !== undefined ? `${tp.name} — ${tp.description}` : tp.name }))}
                onChange={(id) => {
                  const tp = sunxTemplates.find((x) => x.id === id);
                  if (tp !== undefined) setForm({ ...form, charter: tp.charter });
                }}
              />
            )}
            <textarea
              className="sx-charter-area"
              aria-label={t('Charter', '品性')}
              rows={6}
              value={form.charter}
              placeholder={t('Charter text applied to every new Sunx in this channel.', '品性章程原文——此通道每个新 Sunx 沿用。')}
              spellCheck={false}
              onChange={(e) => setForm({ ...form, charter: e.target.value })}
            />
          </>
        )}
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
      {/* 字段说明退役(2026-11-24 用户裁定「不要加多余的解释」):默认模型/思考强度/聊天命令的
          hint 与标签同义反复,全部摘除;Bot Token 获取途径与两类红字警示是有用信息,保留 */}
      <ModalField label={t('Default model', '默认模型')}>
        <Select
          ariaLabel={t('Default model', '默认模型')}
          value={form.model}
          options={[
            { v: '', l: t('Follow global default', '跟随全局默认') },
            ...modelChoices.map((m) => ({ v: m.id, l: m.model })),
          ]}
          onChange={(v) => setForm({ ...form, model: v })}
        />
      </ModalField>
      <ModalField label={t('Reasoning effort', '思考强度')}>
        <Select
          ariaLabel={t('Reasoning effort', '思考强度')}
          value={form.effort}
          options={[
            { v: '', l: t('Follow global default', '跟随全局默认') },
            ...EFFORT_OPTIONS.map((o) => ({ v: o.v, l: effortLabel(o.v) })),
          ]}
          onChange={(v) => setForm({ ...form, effort: v })}
        />
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
      <ModalField label={t('Chat commands', '聊天命令')}>
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import { ConfirmDeleteButton, EmptyState, ErrorBanner, ResourceCard, scopeTargetLabel } from './components';
import type { ChannelConfigMsg, ChannelHealthRowMsg } from '../connection-api';
import type { WorkspaceRow } from '../connection';

/**
 * ChannelsPane(channels Task 12,spec §8 GUI 面):通道设置页——每通道一张 ResourceCard 配置组。
 *
 * 全局形态裁定:通道是 daemon 主动外连的执行面,channels 键为全局豁免单档(config/channels.ts
 * 「项目档 channels 键整键忽略」同源裁定)——本页无 root/scope 目标选择器,壳层 ProvidersPane
 * 分支同款先例(SettingsShell.renderPane case 'providers')。
 *
 * 读面裁定:conn 六方法无通道配置读端点(Task 11 交付面只有健康快照 channelsView)——卡草稿按
 * 健康行播种(id/platform/enabled 为真值,root/mode/model/allow 等细粒度字段取写面缺省);
 * putChannels 全表读改写为唯一写面。已有通道手调过的细粒度字段读不回,保存整表时按草稿缺省
 * 归一——接口现状限制(Task 12 报告注明),非本页裁断。
 *
 * 凭证降级裁定(spec §8.2):ProvidersPane 密钥行写机制 = putProviderOp op:'setKey'(providers
 * 专属键存端点),通道无同型端点,且键内零密钥(D6「设置与凭据分离」——serve/channels engine
 * resolveChannelSecret 恒读 env 槽)。GUI 不 import src/serve(G14 house 规矩),槽名派生规则本地
 * 镜像:凭证行只读展示槽名 SUNSHINEX_CHANNEL_SECRET_<ID> + 复制按钮 + 「settings.json env 块或
 * 真实环境变量配置」提示;telegram 引导 @BotFather 创建 Token;mock 免密无凭证组;
 * feishu/dingtalk/wecom 添加选项在场但 disabled 标「即将支持」(引擎适配器未实装,占位可见)。
 *
 * 保存裁定(spec §8.3):卡内「保存」→ putChannels(全表读改写,引擎热生效)→ 成功自动
 * testChannel 一次;「测试连接」亦可手动单发(dry-run 独立起停适配器不动在座表;失败即结果
 * 非错误码——mcp probe 同裁定),结果横幅 role=status 行内呈现。
 *
 * 健康徽标:channelsView 5s 轮询一次(brief §12),connected 徽标 + detail 悬浮(data-tip);
 * 停止条件=组件卸载 clearInterval。
 *
 * 模型下拉裁定:conn 无全局模型清单方法(sessionModel 需会话 id,不适用)——只保留
 * 「跟随全局默认」缺省项(Task 12 报告注明);后续接线模型清单时在此扩 options。
 *
 * 搜索行锚:逐字段 data-setting-key=`channels.<id>.<field>`;稳定锚 channels.add(工具栏)与
 * channels.secret(凭证说明行)由 settings-search 注册——逐通道 id 运行期生成,索引期不可枚举。
 */

/** 通道页连接面(Task 11 六方法子集,结构满足即收,App 传整只 Connection) */
export interface ChannelsPaneConn {
  channelsView(): Promise<{ channels: ChannelHealthRowMsg[] }>;
  putChannels(channels: ChannelConfigMsg[]): Promise<{ ok: true; warnings: string[] }>;
  testChannel(id: string): Promise<{ ok: boolean; botId?: string; error?: string }>;
  channelBindings(): Promise<{ bindings: import('../connection-api').ChannelBindingMsg[] }>;
  deleteChannelBinding(key: string): Promise<{ ok: true }>;
  workspaces(): Promise<WorkspaceRow[]>;
}

/** 平台目录(spec §8.2:telegram/mock 可添加;feishu/dingtalk/wecom 在场 disabled 标「即将支持」) */
const PLATFORMS = [
  { v: 'telegram', en: 'Telegram', zh: 'Telegram', supports: true },
  { v: 'mock', en: 'Mock (test)', zh: 'Mock(测试)', supports: true },
  { v: 'feishu', en: 'Feishu', zh: '飞书', supports: false },
  { v: 'dingtalk', en: 'DingTalk', zh: '钉钉', supports: false },
  { v: 'wecom', en: 'WeCom', zh: '企业微信', supports: false },
] as const;

type PlatformValue = ChannelConfigMsg['platform'];
type ModeValue = ChannelConfigMsg['mode'];
type AllowKind = ChannelConfigMsg['allow']['kind'];

/** 健康徽标轮询窗(毫秒;brief §12 裁定 5s 一次) */
const HEALTH_POLL_MS = 5_000;

/** 凭证槽名派生(serve/channels/model.ts channelSecretEnv 本地镜像,GUI 不 import src/serve):
 *  SUNSHINEX_CHANNEL_SECRET_<大写 id,非字母数字段折叠 '_'> */
const secretSlot = (id: string): string => 'SUNSHINEX_CHANNEL_SECRET_' + id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/** 卡草稿(编辑真值;id 运行期自动生成 platform-<序>,不暴露手填) */
interface ChannelDraft {
  readonly id: string;
  platform: PlatformValue;
  enabled: boolean;
  /** 'auto' = 聊天专属工作区(缺省);其余 = 已注册项目 root */
  root: string;
  mode: ModeValue;
  /** '' = 跟随全局默认 */
  model: string;
  allowKind: AllowKind;
  /** 白名单粘贴原文(空格/逗号/分号/换行分隔),提交时切分去重 */
  userIdsText: string;
}

/** 健康行 → 卡草稿播种(id/platform/enabled 取真值,其余字段取写面缺省——读面裁定见头注) */
const seedDraft = (row: ChannelHealthRowMsg): ChannelDraft => ({
  id: row.id,
  platform: row.platform as PlatformValue,
  enabled: row.enabled,
  root: 'auto',
  mode: 'read-only',
  model: '',
  allowKind: 'first-user',
  userIdsText: '',
});

/** 本地草稿并入健康清单单点:本地草稿为编辑真值保持不动,健康新现 id 追加播种;
 *  removed=本会话已删 id 墓碑——健康快照晚到/轮询窗口内仍报该行时不复活已删卡
 *  (daemon 真值要等 putChannels 写盘后下轮健康快照才消失,GUI 侧本地墓碑先行) */
function mergeDrafts(prev: ChannelDraft[], rows: ChannelHealthRowMsg[], removed: ReadonlySet<string>): ChannelDraft[] {
  const have = new Set(prev.map((d) => d.id));
  return [...prev, ...rows.filter((r) => !have.has(r.id) && !removed.has(r.id)).map(seedDraft)];
}

/** userIds 粘贴文本切分单点:空白/逗号/分号(含全角)分隔,trim 去空去重保首现 */
function splitUserIds(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;，；]+/)) {
    const id = raw.trim();
    if (id !== '' && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 草稿 → ChannelConfigMsg(全表写行):model 空=跟随全局省键;allow list 携切分 userIds,
 *  其余 kind 无附加键 */
const toMsg = (d: ChannelDraft): ChannelConfigMsg => ({
  id: d.id,
  platform: d.platform,
  enabled: d.enabled,
  root: d.root,
  mode: d.mode,
  ...(d.model !== '' ? { model: d.model } : {}),
  allow: d.allowKind === 'list' ? { kind: 'list', userIds: splitUserIds(d.userIdsText) } : { kind: d.allowKind },
});

/** 新卡 id 序号单点:platform-<序>,取既有同前缀最大序 +1 */
function nextSeq(platform: string, drafts: ChannelDraft[]): number {
  const re = new RegExp(`^${platform}-(\\d+)$`);
  let max = 0;
  for (const d of drafts) {
    const m = re.exec(d.id);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

interface ChannelsPaneProps {
  readonly conn: ChannelsPaneConn;
}

export function ChannelsPane({ conn }: ChannelsPaneProps): JSX.Element {
  const [drafts, setDrafts] = useState<ChannelDraft[] | null>(null);
  const [health, setHealth] = useState<ChannelHealthRowMsg[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  /** 写面在途门(单卡在途:保存/删除/手动测试共用——禁再发) */
  const [savingId, setSavingId] = useState('');
  /** 试连结果横幅(id → 结果;保存成功自动试连与手动测试同槽) */
  const [testMap, setTestMap] = useState<Record<string, { ok: boolean; detail: string }>>({});
  /** 添加通道平台选择面开合 */
  const [addOpen, setAddOpen] = useState(false);
  /** 已复制回显(复制按钮 3s 自隐) */
  const [copiedId, setCopiedId] = useState('');
  /** 本会话已删通道 id 墓碑(mergeDrafts 防复活面,见函数注;ref 持有免 useCallback 依赖抖动) */
  const removedRef = useRef<Set<string>>(new Set());
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
  }, []);

  /** 读面装载:健康快照 → 健康徽标源 + 草稿并入播种(本地草稿真值不覆盖) */
  const load = useCallback((): void => {
    conn.channelsView().then(
      (v) => {
        setHealth(v.channels);
        setDrafts((prev) => mergeDrafts(prev ?? [], v.channels, removedRef.current));
        setLoadError('');
      },
      (err: unknown) => setLoadError(errText(err)),
    );
  }, [conn]);

  useEffect(() => {
    load();
  }, [load]);

  /** 5s 健康轮询(brief §12):只刷健康徽标,不扰编辑草稿;卸载 clearInterval */
  useEffect(() => {
    const timer = setInterval(() => {
      conn.channelsView().then((v) => setHealth(v.channels), () => {});
    }, HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, [conn]);

  /** 工作区注册表一次性装载(工作区下拉选项面;读失败静默降级=仅「聊天专属工作区(自动)」) */
  useEffect(() => {
    let alive = true;
    conn.workspaces().then(
      (rows) => {
        if (!alive) return;
        setWorkspaces(rows.filter((r) => r.root !== undefined && r.root !== ''));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [conn]);

  const platformLabel = (v: string): string => {
    const p = PLATFORMS.find((x) => x.v === v);
    return p === undefined ? v : t(p.en, p.zh);
  };

  /** 添加通道:平台下拉选定即建卡(id 自动 platform-<序>;disabled 平台选项不可选到) */
  const pickPlatform = (v: string): void => {
    setAddOpen(false);
    const p = PLATFORMS.find((x) => x.v === v);
    if (p === undefined || !p.supports) return;
    setDrafts((prev) => {
      const base = prev ?? [];
      return [...base, { id: `${p.v}-${nextSeq(p.v, base)}`, platform: p.v as PlatformValue, enabled: true, root: 'auto', mode: 'read-only', model: '', allowKind: 'first-user', userIdsText: '' }];
    });
  };

  /** 草稿字段改写单点(受控行回写) */
  const patchDraft = (id: string, patch: Partial<ChannelDraft>): void => {
    setDrafts((prev) => (prev ?? []).map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  /** 复制槽名(剪贴板不可用面[老 WebView/jsdom]退化:槽名行内可见,手选复制;回显照常) */
  const copySlot = (id: string): void => {
    const done = (): void => {
      setCopiedId(id);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedId(''), 3_000);
    };
    try {
      const clip = navigator.clipboard;
      if (clip !== undefined) {
        clip.writeText(secretSlot(id)).then(done, done);
        return;
      }
    } catch {
      /* 剪贴板面不可用——退化为行内可见手选复制 */
    }
    done();
  };

  /** 试连结果落槽单点(手动测试与保存后自动试连同路径) */
  const recordTest = (id: string, r: { ok: boolean; botId?: string; error?: string }): void => {
    setTestMap((m) => ({ ...m, [id]: { ok: r.ok, detail: r.ok ? r.botId ?? '' : r.error ?? '' } }));
  };

  /** 手动测试连接(dry-run,不动在座表) */
  const testOnly = (id: string): void => {
    if (savingId !== '') return;
    setSavingId(id);
    setActionError('');
    conn
      .testChannel(id)
      .then((r) => {
        setSavingId('');
        recordTest(id, r);
      })
      .catch((err: unknown) => {
        setSavingId('');
        recordTest(id, { ok: false, error: errText(err) });
      });
  };

  /** 卡保存(spec §8.3):putChannels(全表读改写)→ 成功自动 testChannel 一次。
   *  白名单准入且 userIds 切分后为空 = 本地拦(daemon 写面 400 同裁定,前端预守卫) */
  const saveCard = (id: string): void => {
    if (savingId !== '' || drafts === null) return;
    const d = drafts.find((x) => x.id === id);
    if (d === undefined) return;
    if (d.allowKind === 'list' && splitUserIds(d.userIdsText).length === 0) {
      setActionError(t('Allow-list needs at least one user id', '白名单准入至少需要一个 userId'));
      return;
    }
    setSavingId(id);
    setActionError('');
    conn
      .putChannels(drafts.map(toMsg))
      .then(() => conn.testChannel(id))
      .then((r) => {
        setSavingId('');
        recordTest(id, r);
        load();
      })
      .catch((err: unknown) => {
        setSavingId('');
        setActionError(errText(err));
      });
  };

  /** 删卡(两段确认后):本地摘卡 + id 落墓碑(防健康快照轮询复活)→ putChannels 全表读改写
   *  少一条 → 成功重拉健康面 */
  const removeCard = (id: string): void => {
    if (savingId !== '' || drafts === null) return;
    const next = drafts.filter((d) => d.id !== id);
    removedRef.current.add(id);
    setDrafts(next);
    setSavingId(id);
    setActionError('');
    conn
      .putChannels(next.map(toMsg))
      .then(() => {
        setSavingId('');
        load();
      })
      .catch((err: unknown) => {
        setSavingId('');
        setActionError(errText(err));
      });
  };

  const healthRowOf = (id: string): ChannelHealthRowMsg | undefined => health.find((r) => r.id === id);

  /** 卡头健康徽标(channelsView;detail 悬浮 data-tip;无行=引擎尚未装载,不渲染徽标) */
  const healthChip = (id: string): JSX.Element | null => {
    const row = healthRowOf(id);
    if (row === undefined) return null;
    return (
      <span className={row.connected ? 'sx-chip' : 'sx-chip sx-chip-missing'} data-tip={row.detail ?? ''}>
        {row.connected ? t('Connected', '已连接') : t('Disconnected', '未连接')}
      </span>
    );
  };

  return (
    <section className="sx-settings-form" aria-label="settings pane channels">
      <h2>{t('Channels', '通道')}</h2>
      {/* 添加通道工具栏(稳定搜索锚 channels.add):按钮 → 平台下拉选定即建卡 */}
      <div className="sx-res-toolbar" data-setting-key="channels.add">
        {addOpen ? (
          <>
            <select className="sx-setting-input" aria-label={t('Platform', '平台')} value="" onChange={(e) => pickPlatform(e.target.value)}>
              <option value="" disabled>
                {t('Choose a platform…', '选择平台…')}
              </option>
              {PLATFORMS.filter((p) => p.supports).map((p) => (
                <option key={p.v} value={p.v}>
                  {t(p.en, p.zh)}
                </option>
              ))}
              <optgroup label={t('Coming soon', '即将支持')}>
                {PLATFORMS.filter((p) => !p.supports).map((p) => (
                  <option key={p.v} value={p.v} disabled>
                    {t(p.en, p.zh)}
                  </option>
                ))}
              </optgroup>
            </select>
            <button type="button" onClick={() => setAddOpen(false)}>
              {t('Cancel', '取消')}
            </button>
          </>
        ) : (
          <button type="button" className="sx-add-button" onClick={() => setAddOpen(true)}>
            {t('+ Add channel', '+ 添加通道')}
          </button>
        )}
      </div>
      {/* 凭证说明行(稳定搜索锚 channels.secret;头注降级裁定同源) */}
      <p className="sx-provider-hint" data-setting-key="channels.secret">
        {t(
          'Channel secrets never live in config (D6): each channel reads the SUNSHINEX_CHANNEL_SECRET_<ID> env slot — set it in the settings.json env block or a real environment variable.',
          '通道密钥不进配置(D6):每通道按 id 读取 env 槽 SUNSHINEX_CHANNEL_SECRET_<ID>——在 settings.json 的 env 块或真实环境变量配置。',
        )}
      </p>
      {loadError !== '' && <ErrorBanner text={loadError} />}
      {actionError !== '' && <ErrorBanner text={actionError} />}
      {drafts === null && loadError === '' && <EmptyState text={t('Loading channels…', '加载通道…')} />}
      {drafts !== null && drafts.length === 0 && <EmptyState text={t('No channels yet.', '暂无通道。')} />}
      <ul className="sx-rc-list">
        {(drafts ?? []).map((d) => (
          <ResourceCard
            key={d.id}
            title={`${platformLabel(d.platform)} · ${d.id}`}
            chips={healthChip(d.id)}
            enabled={d.enabled}
            onToggle={() => patchDraft(d.id, { enabled: !d.enabled })}
            actions={
              <>
                <button type="button" disabled={savingId !== ''} onClick={() => testOnly(d.id)}>
                  {t('Test connection', '测试连接')}
                </button>
                <ConfirmDeleteButton
                  ariaLabel={`${t('Delete', '删除')} ${d.id}`}
                  disabled={savingId !== ''}
                  onConfirm={() => removeCard(d.id)}
                />
              </>
            }
            body={
              <>
                {/* 通用组(spec §8.1,全下拉/开关):工作区/权限模式/模型/准入 */}
                <div className="sx-modal-field" data-setting-key={`channels.${d.id}.root`}>
                  <div className="sx-modal-field-label">
                    <span className="sx-modal-field-name">{t('Workspace', '工作区')}</span>
                    <span className="sx-modal-field-hint">{t('Chat-only workspace by default; binding a registered project is for advanced use', '缺省聊天专属工作区;绑定真实项目为高级用法')}</span>
                  </div>
                  <select
                    className="sx-setting-input"
                    aria-label={t('Workspace', '工作区')}
                    value={d.root}
                    onChange={(e) => patchDraft(d.id, { root: e.target.value })}
                  >
                    <option value="auto">{t('Chat-only workspace (auto)', '聊天专属工作区(自动)')}</option>
                    {workspaces.map((w) => (
                      <option key={w.root} value={w.root}>
                        {scopeTargetLabel(w.root!)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sx-modal-field" data-setting-key={`channels.${d.id}.mode`}>
                  <div className="sx-modal-field-label">
                    <span className="sx-modal-field-name">{t('Access mode', '权限模式')}</span>
                    <span className="sx-modal-field-hint">{t('full-access is flagged in red below', 'full-access 选项红字警示')}</span>
                  </div>
                  <select
                    className="sx-setting-input"
                    aria-label={t('Access mode', '权限模式')}
                    value={d.mode}
                    onChange={(e) => patchDraft(d.id, { mode: e.target.value as ModeValue })}
                  >
                    <option value="read-only">{t('Read-only', '只读')}</option>
                    <option value="acceptEdits">{t('Accept edits', '接受编辑')}</option>
                    <option value="full-access">{t('Full access', '完全访问')}</option>
                  </select>
                  {d.mode === 'full-access' && (
                    <p className="sx-provider-warn" role="alert">
                      {t(
                        'Full access lets chat run commands and write files in this workspace — only for channels you personally use.',
                        '完全访问允许聊天在该工作区执行命令与写盘——仅建议用于本人使用的通道。',
                      )}
                    </p>
                  )}
                </div>
                <div className="sx-modal-field" data-setting-key={`channels.${d.id}.model`}>
                  <div className="sx-modal-field-label">
                    <span className="sx-modal-field-name">{t('Model', '模型')}</span>
                    <span className="sx-modal-field-hint">{t('Follow the global default for now', '暂跟随全局默认')}</span>
                  </div>
                  <select
                    className="sx-setting-input"
                    aria-label={t('Model', '模型')}
                    value={d.model}
                    onChange={(e) => patchDraft(d.id, { model: e.target.value })}
                  >
                    <option value="">{t('Follow global default', '跟随全局默认')}</option>
                  </select>
                </div>
                <div className="sx-modal-field" data-setting-key={`channels.${d.id}.allow`}>
                  <div className="sx-modal-field-label">
                    <span className="sx-modal-field-name">{t('Admission', '准入')}</span>
                  </div>
                  <select
                    className="sx-setting-input"
                    aria-label={t('Admission', '准入')}
                    value={d.allowKind}
                    onChange={(e) => patchDraft(d.id, { allowKind: e.target.value as AllowKind })}
                  >
                    <option value="first-user">{t('First respondent only', '仅首次对话用户')}</option>
                    <option value="list">{t('Custom allow-list', '自定义白名单')}</option>
                    <option value="all">{t('Open to everyone', '不限')}</option>
                  </select>
                  {d.allowKind === 'list' && (
                    <textarea
                      className="sx-setting-input"
                      aria-label={t('Allowed user IDs', '白名单 userIds')}
                      rows={3}
                      value={d.userIdsText}
                      placeholder={t('User ids separated by spaces, commas or newlines', '空格/逗号/换行分隔的 userId')}
                      spellCheck={false}
                      onChange={(e) => patchDraft(d.id, { userIdsText: e.target.value })}
                    />
                  )}
                  {d.allowKind === 'all' && (
                    <p className="sx-provider-warn" role="alert">
                      {t(
                        'Anyone who finds the bot can start sessions — strongly discouraged for public bots.',
                        '任何发现该机器人的用户都能开启会话——公开机器人强烈不建议。',
                      )}
                    </p>
                  )}
                </div>
                {/* 凭证组(spec §8.2):telegram 单平台——降级裁定见头注(槽名只读+复制+env 块指引);
                    mock 免密无凭证组;disabled 平台无卡(添加面已挡) */}
                {d.platform === 'telegram' && (
                  <div className="sx-modal-field" data-setting-key={`channels.${d.id}.secret`}>
                    <div className="sx-modal-field-label">
                      <span className="sx-modal-field-name">{t('Bot token (credential)', 'Bot Token(凭证)')}</span>
                      <span className="sx-modal-field-hint">{t('Create it with @BotFather on Telegram', '在 Telegram 找 @BotFather 创建')}</span>
                    </div>
                    <div className="sx-card-actions">
                      <code className="sx-channel-secret-slot">{secretSlot(d.id)}</code>
                      <button type="button" aria-label={`${t('Copy', '复制')} ${secretSlot(d.id)}`} onClick={() => copySlot(d.id)}>
                        {copiedId === d.id ? t('Copied', '已复制') : t('Copy', '复制')}
                      </button>
                    </div>
                    <p className="sx-provider-hint">
                      {t(
                        'Read-only slot name — configure the token in the settings.json env block or a real environment variable; it is never written into this config.',
                        '只读槽名——请在 settings.json 的 env 块或真实环境变量配置 Token;凭证不写入本配置。',
                      )}
                    </p>
                  </div>
                )}
                {/* 试连结果横幅(保存后自动试连与手动测试共用;role=status) */}
                {testMap[d.id] !== undefined && (
                  <p role="status" className={testMap[d.id]!.ok ? 'sx-provider-hint' : 'sx-provider-warn'}>
                    {testMap[d.id]!.ok
                      ? `${t('Test passed', '测试通过')}${testMap[d.id]!.detail !== '' ? ` · ${testMap[d.id]!.detail}` : ''}`
                      : `${t('Test failed', '测试失败')}: ${testMap[d.id]!.detail}`}
                  </p>
                )}
                <div className="sx-card-actions">
                  <button type="button" className="sx-add-button" disabled={savingId !== ''} onClick={() => saveCard(d.id)}>
                    {savingId === d.id ? t('Saving…', '保存中…') : t('Save', '保存')}
                  </button>
                </div>
                <p className="sx-provider-hint">{t('Changes apply on save (engine hot-reload).', '改动经「保存」生效(引擎热生效)。')}</p>
              </>
            }
          />
        ))}
      </ul>
    </section>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import { useAutoToast } from '../use-auto-toast';
import { CHANNEL_PLATFORMS } from '../sidebar/use-menu-channels';
import { EditorModal, EmptyState, ErrorBanner, ModalShell } from './components';
import { ChannelCard } from './ChannelCard';
import { ChannelModalForm } from './ChannelModalForm';
import { displayNameOf, identityOf, EMPTY_FORM, mergeDrafts, newChannelId, splitUserIds, toMsg } from './channel-drafts';
import type { ChannelDraft, ChannelForm, ChannelModal } from './channel-drafts';
import type { ChannelConfigMsg, ChannelHealthRowMsg } from '../connection-api';
import type { SunxTemplateEntry } from '../connection-types';
import type { WorkspaceRow } from '../connection';

/**
 * ChannelsPane(channels Task 15 第三版重做,**2026-11-22 终形态用户裁定**:保留多实例 + ProvidersPane
 * 形态克隆 + 2026-11-22 追加裁定:弃原生 select 改共享 Select 弹层控件、工作区改文件夹选择(空=聊天
 * 专属工作区)、文案只留简短主要作用、密钥内联可回显(推翻 D6)、飞书首发可测)。本件=装配与编排
 * (D112 拆分后壳):草稿引擎在 channel-drafts.ts、弹窗字段面在 ChannelModalForm.tsx、卡片簇在
 * ChannelCard.tsx。
 *
 * 页面结构:节头「通道」+ 一句简介 + 「+ 新增通道」工具栏(搜索锚 channels.add)+ 每通道一张卡片
 * (状态点+应用名称+平台副标+操作簇,ChannelCard)。卡片无内嵌表单——全部编辑走弹窗
 * (EditorModal+ChannelModalForm 字段面)。保存 → putChannels 全表(secret 随条目内联,2026-11-22
 * 裁定)→ 成功自动 testChannel。
 *
 * 读面/回填:挂载时 channelsView(健康)+ settingsChannels(配置)双源并行 mergeDrafts——配置行逐字段
 * 回填弹窗草稿真值,dirty 卡不覆盖,removed 墓碑防轮询复活;健康 5s 轮询只刷状态点。
 * id 自动生成(platform-<随机后缀>);启用 Switch/删除即改即写;写面在途单门(savingId)。
 */

/** 通道页连接面(Task 11/12/15 面,结构满足即收,App 传整只 Connection) */
export interface ChannelsPaneConn {
  channelsView(): Promise<{ channels: ChannelHealthRowMsg[] }>;
  /** GET /settings/channels:全局档 channels 配置读端点——已有通道弹窗回填真值的数据源 */
  settingsChannels(): Promise<{ channels: ChannelConfigMsg[]; warnings: string[] }>;
  putChannels(channels: ChannelConfigMsg[]): Promise<{ ok: true; warnings: string[] }>;
  testChannel(id: string): Promise<{ ok: boolean; botId?: string; error?: string }>;
  /** DELETE /channels/:id(2026-11-23 用户裁定「真正的删除各种配置和目录」):条目移除+解绑+聊天域目录真删 */
  deleteChannel(id: string): Promise<{ ok: true }>;
  /** GET /models:全局模型清单(2026-11-23 用户裁定「可以选择默认的模型和强度」)——弹窗缺省档数据源 */
  models(): Promise<{ choices: Array<{ id: string; model: string }> }>;
  /** GET /settings/sunx-templates(2026-11-24 用户裁定通道支持 Sunx 模式):品性模板清单,弹窗
   *  模式=Sunx 时挑选数据源;可选——旧桩缺省时模板下拉隐藏,textarea 直填不受影响 */
  sunxTemplates?(): Promise<{ entries: SunxTemplateEntry[]; warnings: string[] }>;
  workspaces(): Promise<WorkspaceRow[]>;
}

/** 健康徽标轮询窗(毫秒;brief §12 裁定 5s 一次) */
const HEALTH_POLL_MS = 5_000;

/** 应用名称长度上限(spec §8 终形态:1..80,trim) */
const NAME_MAX = 80;

interface ChannelsPaneProps {
  readonly conn: ChannelsPaneConn;
}

export function ChannelsPane({ conn }: ChannelsPaneProps): JSX.Element {
  const [drafts, setDrafts] = useState<ChannelDraft[] | null>(null);
  const [health, setHealth] = useState<ChannelHealthRowMsg[]>([]);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  /** 写面在途门(单通道在途:保存/删除/试连/Switch 共用——禁再发) */
  const [savingId, setSavingId] = useState('');
  /** 测试结果 toast(2026-11-22 用户裁定:居中 toast 3s 自隐;四档色——成功绿/异常红,四档
   *  提示色规范见 CLAUDE.md;useAutoToast 单点,D113——原手写 timer 克隆退役) */
  const { toast: testToast, showToast } = useAutoToast<{ tone: 'ok' | 'warn' | 'err'; text: string }>();
  const [modal, setModal] = useState<ChannelModal | null>(null);
  const [form, setForm] = useState<ChannelForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  /** 本会话已删通道 id 墓碑(mergeDrafts 防复活面) */
  const removedRef = useRef<Set<string>>(new Set());
  /** 配置读面双源 ref(两响应到达次序不定——各落 ref 后 applySources 单点重算草稿) */
  const healthRef = useRef<ChannelHealthRowMsg[]>([]);
  const cfgRef = useRef<ChannelConfigMsg[]>([]);
  /** 配置读面 warnings(读面宽容语义:warning 跳过不致命——行内提示,不阻断编辑) */
  const [cfgWarnings, setCfgWarnings] = useState<string[]>([]);
  /** 全局模型清单(2026-11-23 用户裁定「可以选择默认的模型和强度」):弹窗模型下拉数据源;
   *  拉取失败静默=空列(强度档静态不受影响) */
  const [modelChoices, setModelChoices] = useState<Array<{ id: string; model: string }>>([]);
  /** 品性模板清单(2026-11-24 通道 Sunx 模式;弹窗开启时拉取一次,连接面缺席=空列下拉隐藏) */
  const [sunxTemplates, setSunxTemplates] = useState<SunxTemplateEntry[]>([]);
  const applySources = useCallback((): void => {
    setHealth(healthRef.current);
    setDrafts((prev) => mergeDrafts(prev ?? [], healthRef.current, cfgRef.current, removedRef.current));
  }, []);

  /** 读面装载:健康快照 + 配置读面双源并行,各自先落 ref 再统一 applySources 重算草稿 */
  const load = useCallback((): void => {
    conn.channelsView().then(
      (v) => {
        healthRef.current = v.channels;
        applySources();
        setLoadError('');
      },
      (err: unknown) => setLoadError(errText(err)),
    );
    conn.settingsChannels().then(
      (v) => {
        cfgRef.current = v.channels;
        setCfgWarnings(v.warnings);
        applySources();
      },
      () => {
        /* 配置读面缺位/失败:草稿维持健康缺省播种,不打断编辑主流程 */
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, applySources]);

  useEffect(() => {
    load();
    conn.models().then(
      (v) => setModelChoices(v.choices),
      () => setModelChoices([]),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn]);

  /** 5s 健康轮询:只刷状态点,不扰弹窗草稿;卸载 clearInterval */
  useEffect(() => {
    const timer = setInterval(() => {
      conn.channelsView().then((v) => {
        healthRef.current = v.channels;
        setHealth(v.channels);
      }, () => {});
    }, HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, [conn]);

  /** 全表写收口:统一在途门 + 错误行内 + 成功落草稿并重拉(ProvidersPane runOp 同语义) */
  const writeAll = (next: ChannelDraft[], opId: string): void => {
    if (savingId !== '') return;
    setSavingId(opId);
    setActionError('');
    conn
      .putChannels(next.map(toMsg))
      .then(() => {
        setSavingId('');
        setDrafts(next);
        load();
      })
      .catch((err: unknown) => {
        setSavingId('');
        setActionError(errText(err));
      });
  };

  /** 卡头启停 Switch:即改即写(全表 enabled 翻转;置 dirty——回拉不回退用户操作) */
  const toggleCard = (d: ChannelDraft): void => {
    if (savingId !== '' || drafts === null) return;
    const next = drafts.map((x) => (x.id === d.id ? { ...x, enabled: !x.enabled, dirty: true } : x));
    setDrafts(next);
    writeAll(next, d.id);
  };

  /** 删除确认弹窗态(2026-11-23 用户裁定「删除增加弹窗确认,不是原地二次确认」):id+展示名 */
  const [delAsk, setDelAsk] = useState<{ id: string; name: string } | null>(null);
  /** 删除钮:开确认弹窗(真删除不可恢复,文案明示) */
  const askDelete = (d: ChannelDraft): void => setDelAsk({ id: d.id, name: displayNameOf(d) });
  /** 弹窗确认 → DELETE /channels/:id 真删除(条目+绑定+聊天域目录)→ 本地摘卡+墓碑+重拉 */
  const confirmDelete = (): void => {
    if (delAsk === null || savingId !== '') return;
    const id = delAsk.id;
    setSavingId(id);
    conn
      .deleteChannel(id)
      .then(() => {
        setSavingId('');
        setDelAsk(null);
        removedRef.current.add(id);
        setDrafts((prev) => (prev ?? []).filter((d) => d.id !== id));
        load();
      }, (err: unknown) => {
        setSavingId('');
        setDelAsk(null);
        setActionError(errText(err));
      });
  };

  /** 试连结果落槽单点(手动测试与保存后自动试连同路径;成功回显 botId,失败简洁化——去内部细节)。
   *  失败档按结构化 code 映射(D111:免 daemon 文案子串耦合);旧 daemon/未知码回落自由文本首段 */
  const recordTest = (_id: string, r: { ok: boolean; botId?: string; error?: string; code?: string }): void => {
    if (r.ok) {
      showToast({ tone: 'ok', text: `${t('Test passed', '测试通过')} · ${r.botId ?? ''}` });
    } else {
      const brief =
        r.code === 'secret-missing'
          ? t('No secret configured', '未配置密钥')
          : r.code === 'ident-invalid'
            ? t('Invalid App ID', 'App ID 无效')
            : r.code === 'connect-failed'
              ? t('Connection failed', '连接失败')
              : (r.error ?? '').split('——')[0]!.split('（')[0]!;
      showToast({ tone: 'err', text: `${t('Test failed', '测试失败')}：${brief}` });
    }
  };

  /** 卡头「测试连接」(dry-run,不动在座表) */
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

  /** 打开弹窗:add=写面缺省草稿(平台待选);edit=卡片草稿逐字段回填(settingsChannels 真值已
   *  经 mergeDrafts 回填进草稿;secret 回显已存值——2026-11-22 内联可回显裁定) */
  const openModal = (d: ChannelDraft | null): void => {
    setFormError('');
    if (d === null) {
      setForm(EMPTY_FORM);
      setModal({ mode: 'add' });
    } else {
      setForm({ platform: d.platform, name: d.name, secret: d.secret, appId: d.appId, rootText: d.rootText, mode: d.mode, model: d.model, effort: d.effort, sessionKind: d.sessionKind, charter: d.charter, commands: d.commands, allowKind: d.allowKind, userIdsText: d.userIdsText });
      setModal({ mode: 'edit', id: d.id });
    }
    // 品性模板拉取(尽力而为:连接面缺席/失败=空列,模板下拉隐藏,textarea 直填不受影响)
    void conn.sunxTemplates?.().then(
      (v) => setSunxTemplates(v.entries.filter((e) => !e.shadowed)),
      () => setSunxTemplates([]),
    );
  };

  /** 弹窗保存:putChannels 全表读改写(secret 随条目内联,2026-11-22 裁定)→ 成功关弹窗 + 重拉 +
   *  自动 testChannel 一次。id 新增时自动生成;编辑保留原 id(平台锁定同因)。
   *  在途门全程闭合(D112:原中途 setSavingId('')→取名腿再置 savingId 有空窗,试连期可再触发写
   *  与回填写竞态)——单链收口,save/试连/自动取名全程 busy,收尾统一放门 */
  const submitChannel = (): void => {
    if (modal === null || savingId !== '' || drafts === null) return;
    const platform = CHANNEL_PLATFORMS.find((p) => p.v === form.platform);
    if (modal.mode === 'add' && (platform === undefined || !platform.supports)) {
      setFormError(t('Choose a platform', '请选择平台'));
      return;
    }
    const name = form.name.trim();
    if (name.length > NAME_MAX) {
      setFormError(t(`App name must be at most ${NAME_MAX} characters`, `应用名称至多 ${NAME_MAX} 字`));
      return;
    }
    const base = modal.mode === 'edit' ? drafts.find((d) => d.id === modal.id) : undefined;
    if (modal.mode === 'edit' && base === undefined) {
      setFormError(t('Channel not found', '通道不存在'));
      return;
    }
    if (form.allowKind === 'list' && splitUserIds(form.userIdsText).length === 0) {
      setFormError(t('Allow-list needs at least one user id', '白名单准入至少需要一个 userId'));
      return;
    }
    // 唯一标识去重(2026-11-23 用户裁定「根据 AppID 去重,其他应用也根据唯一标识去重,保存时
    // warn toast 提示」)：feishu=App ID/telegram=Bot Token;同标识他通道在场(排除自身)即拦下
    const identity = identityOf(form.platform, form.appId.trim(), form.secret);
    const selfId = modal.mode === 'edit' ? modal.id : undefined; // 编辑=排除自身
    if (identity !== undefined && drafts.some((d) => d.id !== selfId && identityOf(d.platform, d.appId, d.secret) === identity)) {
      showToast({ tone: 'warn', text: t('This app is already connected.', '该通道应用已接入。') });
      return;
    }
    const id = modal.mode === 'edit' ? modal.id! : newChannelId(platform!.v, drafts);
    const saved: ChannelDraft = {
      id,
      platform: (modal.mode === 'edit' ? base!.platform : platform!.v) as ChannelDraft['platform'],
      name,
      enabled: modal.mode === 'edit' ? base!.enabled : true,
      secret: form.secret,
      rootText: form.rootText,
      mode: form.mode,
      model: form.model,
      effort: form.effort,
      appId: form.appId.trim(),
      ident: base?.ident,
      sessionKind: form.sessionKind,
      charter: form.sessionKind === 'sunx' ? form.charter : '',
      commands: form.commands,
      allowKind: form.allowKind,
      userIdsText: form.userIdsText,
      dirty: false, // 已落盘:读面真值即本地值,回拉重播种不回退
    };
    const next = modal.mode === 'edit' ? drafts.map((d) => (d.id === id ? saved : d)) : [...drafts, saved];
    setSavingId(id);
    setFormError('');
    conn
      .putChannels(next.map(toMsg))
      .then(() => {
        setDrafts(next);
        setModal(null);
        setForm(EMPTY_FORM);
        load();
        // 自动取名(2026-11-22 用户裁定「保存时自动获取飞书的应用名称做占位」):应用名称留空
        // 且试连拿到平台侧应用名 → 静默回填 name=botId 再落一次(全表写,门保持闭合)
        return conn.testChannel(id).then(
          (r) => {
            recordTest(id, r);
            const botName = r.ok && saved.name === '' ? r.botId?.trim() : undefined;
            if (botName !== undefined && botName !== '' && botName.length <= NAME_MAX) {
              const named = next.map((d) => (d.id === id ? { ...d, name: botName } : d));
              setDrafts(named);
              return conn.putChannels(named.map(toMsg)).then(
                () => {
                  load();
                },
                (err: unknown) => showToast({ tone: 'err', text: errText(err) }), // 回填写失败:toast 可见化(原静默吞)
              );
            }
            return undefined;
          },
          (err: unknown) => recordTest(id, { ok: false, error: errText(err) }),
        );
      })
      .catch((err: unknown) => {
        setFormError(errText(err)); // 首腿失败:弹窗未关,表单错误行可见化
      })
      .finally(() => setSavingId(''));
  };

  /** 工作区文件夹选择(路径与执行环境页同款):window.sunshinex.pickFolder → 返回路径落草稿;
   *  取消(null)零动作。空值 = 聊天专属工作区(自动) */
  const pickWorkspaceFolder = (): void => {
    const nativePick = window.sunshinex?.pickFolder;
    if (nativePick === undefined) return;
    void nativePick(form.rootText !== '' ? form.rootText : undefined).then(
      (p) => {
        if (p !== null) setForm((f) => ({ ...f, rootText: p }));
      },
      () => undefined,
    );
  };

  const loading = drafts === null && loadError === '';
  const busy = savingId !== '';
  const editingDraft = modal?.mode === 'edit' ? drafts?.find((d) => d.id === modal.id) : undefined;
  return (
    <section className="sx-settings-form" aria-label="settings pane channels">
      <h2>{t('Channels', '通道')}</h2>
      {/* 添加通道工具栏(稳定搜索锚 channels.add) */}
      {/* 一句简介(本页主要作用;2026-11-22 文案精简裁定——仅此一句,无内部术语) */}
      <p className="sx-provider-hint">
        {t('Connect third-party apps (e.g. Feishu, WeCom) to Sunshinex.', '把三方应用（如飞书，企业微信）接入 Sunshinex。')}
      </p>
      <div className="sx-res-toolbar" data-setting-key="channels.add">
        <button type="button" className="sx-add-button" onClick={() => openModal(null)}>
          {t('+ New channel', '+ 新增通道')}
        </button>
      </div>
      {loadError !== '' && <ErrorBanner text={loadError} />}
      {actionError !== '' && <ErrorBanner text={actionError} />}
      {cfgWarnings.map((w) => (
        <ErrorBanner key={w} text={w} />
      ))}
      {loading && <EmptyState text={t('Loading channels…', '加载通道…')} />}
      {!loading && drafts !== null && drafts.length === 0 && <EmptyState text={t('No channels yet.', '暂无通道。')} />}
      {/* 卡片列表(ProvidersPane sx-rc 克隆;卡簇 ChannelCard 单点) */}
      <ul className="sx-rc-list">
        {(drafts ?? []).map((d) => (
          <ChannelCard
            key={d.id}
            d={d}
            healthRow={health.find((r) => r.id === d.id)}
            busy={busy}
            onDelete={() => askDelete(d)}
            onTest={() => testOnly(d.id)}
            onEdit={() => openModal(d)}
            onToggle={() => toggleCard(d)}
          />
        ))}
      </ul>
      {/* 新增/编辑弹窗:标题=应用名称(2026-11-22 用户裁定「应用名称是飞书1,编辑 feishu-1 是什么」
          ——显示名回退通道 id);字段面 ChannelModalForm 单点 */}
      {modal !== null && (
        <EditorModal
          open
          title={modal.mode === 'add' ? t('New channel', '新增通道') : t(`Edit ${editingDraft?.name || (modal.id ?? '')}`, `编辑 ${editingDraft?.name || (modal.id ?? '')}`)}
          onClose={() => setModal(null)}
          onSubmit={submitChannel}
        >
          <ChannelModalForm modal={modal} form={form} setForm={setForm} formError={formError} onPickFolder={pickWorkspaceFolder} modelChoices={modelChoices} sunxTemplates={sunxTemplates} />
        </EditorModal>
      )}
      {/* 删除确认弹窗(2026-11-23 用户裁定「弹窗确认,不是原地二次确认」):文案明示真删除
          范围(应用+相关会话记录+数据目录)不可恢复;确认=DELETE /channels/:id 真删除 */}
      {delAsk !== null && (
        <ModalShell title={t('Delete channel', '删除通道')} onClose={() => setDelAsk(null)} modifier="sx-turn-confirm">
          <form
            id="sx-channel-del-form"
            className="sx-turn-confirm-body"
            onSubmit={(e) => {
              e.preventDefault();
              confirmDelete();
            }}
          >
            <p className="sx-provider-warn" role="alert">
              {t(
                `This will permanently delete "${delAsk.name}" and ALL its chat session records and data directories. This cannot be undone.`,
                `即将删除「${delAsk.name}」以及它的全部会话记录和数据目录，此操作不可恢复。`,
              )}
            </p>
          </form>
          {/* 按钮位(2026-11-24 用户报障「按钮离边框太远,和其他弹窗不一致」):actions 移出 body
              form 成弹窗直接子级(sx-turn-confirm-actions 同构 EditorModal 尾栏——22px 侧衬/
              全出血分隔线);提交钮经 form 属性关联上方表单,回车提交不变 */}
          <div className="sx-turn-confirm-actions">
            <button type="button" disabled={savingId === delAsk.id} onClick={() => setDelAsk(null)}>
              {t('Cancel', '取消')}
            </button>
            <button type="submit" form="sx-channel-del-form" className="sx-danger-solid" disabled={savingId === delAsk.id}>
              {savingId === delAsk.id ? t('Deleting…', '删除中…') : t('Delete', '删除')}
            </button>
          </div>
        </ModalShell>
      )}
      {testToast !== null && (
        <div className={`sx-toast ${testToast.tone === 'ok' ? 'sx-toast-ok' : testToast.tone === 'warn' ? 'sx-toast-warn' : 'sx-toast-err'}`} role="status">
          {testToast.text}
        </div>
      )}
    </section>
  );
}

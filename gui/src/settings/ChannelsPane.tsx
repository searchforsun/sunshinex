import { FolderOpen, Pencil, PlugZap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import { CHANNEL_PLATFORMS } from '../sidebar/use-menu-channels';
import { ConfirmDeleteButton, EditorModal, EmptyState, ErrorBanner, ModalField, Switch } from './components';
import { MultiSelect, SecretInput, Select } from './controls';
import type { ChannelConfigMsg, ChannelHealthRowMsg } from '../connection-api';
import type { WorkspaceRow } from '../connection';

/**
 * ChannelsPane(channels Task 15 第三版重做,**2026-11-22 终形态用户裁定**:保留多实例 + ProvidersPane
 * 形态克隆 + 2026-11-22 追加裁定:弃原生 select 改共享 Select 弹层控件、工作区改文件夹选择(空=聊天
 * 专属工作区)、文案只留简短主要作用、密钥内联可回显(推翻 D6)、飞书首发可测)。
 *
 * 页面结构:节头「通道」+ 一句简介 + 「+ 新增通道」工具栏(搜索锚 channels.add)+ 每通道一张卡片
 * (状态点 sx-api-dot + 应用名称 + 平台副标 + 操作簇:测试连接/删除/编辑/启用 Switch)。卡片无内嵌
 * 表单——全部编辑走弹窗(EditorModal/ModalField)。弹窗字段:平台(共享 Select,新增可选飞书/Telegram,
 * 编辑锁定)/应用名称/按平台凭证(飞书:App ID+App Secret;Telegram:Bot Token;均 SecretInput
 * 回显+眼睛)/工作区(文本框+pickFolder 文件夹钮,空=聊天专属工作区)/权限模式/准入(共享 Select,
 * full-access 与「不限」红字)。保存 → putChannels 全表(secret 随条目内联,2026-11-22 裁定)→
 * 成功自动 testChannel。
 *
 * 读面/回填:挂载时 channelsView(健康)+ settingsChannels(配置)双源并行 mergeDrafts——配置行逐字段
 * 回填弹窗草稿真值,dirty 卡不覆盖,removed 墓碑防轮询复活;健康 5s 轮询只刷状态点。
 * id 自动生成:platform-<序>(同前缀最大序+1);启用 Switch/删除即改即写;写面在途单门(savingId)。
 */

/** 通道页连接面(Task 11/12/15 面,结构满足即收,App 传整只 Connection) */
export interface ChannelsPaneConn {
  channelsView(): Promise<{ channels: ChannelHealthRowMsg[] }>;
  /** GET /settings/channels:全局档 channels 配置读端点——已有通道弹窗回填真值的数据源 */
  settingsChannels(): Promise<{ channels: ChannelConfigMsg[]; warnings: string[] }>;
  putChannels(channels: ChannelConfigMsg[]): Promise<{ ok: true; warnings: string[] }>;
  testChannel(id: string): Promise<{ ok: boolean; botId?: string; error?: string }>;
  workspaces(): Promise<WorkspaceRow[]>;
}

type PlatformValue = ChannelConfigMsg['platform'];
type ModeValue = ChannelConfigMsg['mode'];
type AllowKind = ChannelConfigMsg['allow']['kind'];

/** 健康徽标轮询窗(毫秒;brief §12 裁定 5s 一次) */
const HEALTH_POLL_MS = 5_000;

/** 应用名称长度上限(spec §8 终形态:1..80,trim) */
const NAME_MAX = 80;

/** 应用名称占位随平台（新增下拉可选平台；CHANNEL_PLATFORMS 之外回落通用占位） */
const NAME_PLACEHOLDERS: Record<string, { en: string; zh: string }> = {
  feishu: { en: 'My Feishu bot', zh: '我的飞书机器人' },
  telegram: { en: 'My Telegram bot', zh: '我的 Telegram 机器人' },
};

/** 聊天命令目录（镜像 serve/channels/model.ts CHANNEL_COMMANDS——2026-11-22 用户裁定
 *  「配置可以给聊天执行的命令,一个下拉多选(每项的命令以及说明)」):label=命令+一句说明 */
const COMMAND_OPTIONS: ReadonlyArray<{ v: string; en: string; zh: string }> = [
  { v: '/help', en: '/help — Show this help', zh: '/help — 显示本帮助' },
  { v: '/stop', en: '/stop — Stop the current task', zh: '/stop — 停止当前任务' },
  { v: '/new', en: '/new — Start a new conversation', zh: '/new — 开始新对话' },
  { v: '/status', en: '/status — Check task status', zh: '/status — 查看任务状态' },
];
const COMMAND_KEYS: readonly string[] = COMMAND_OPTIONS.map((o) => o.v);

const MODE_LABELS: Record<ModeValue, { en: string; zh: string }> = {
  'read-only': { en: 'Read-only', zh: '只读' },
  acceptEdits: { en: 'Accept edits', zh: '接受编辑' },
  'full-access': { en: 'Full access', zh: '完全访问' },
};
const modeLabel = (m: ModeValue): string => t(MODE_LABELS[m].en, MODE_LABELS[m].zh);

const allowLabel = (d: ChannelDraft): string => {
  if (d.allowKind === 'first-user') return t('First respondent only', '仅首次对话用户');
  if (d.allowKind === 'all') return t('Open to everyone', '不限');
  const n = splitUserIds(d.userIdsText).length;
  return `${t('Allow-list', '白名单')}(${n})`;
};

/** 卡片展示名（2026-11-22 用户裁定「应用名称是飞书1,编辑 feishu-1 是什么」:显示名=应用名称,
 *  缺省回退通道 id(内部标识如实示人)——不再回退平台名(与副标重复成「飞书 飞书」) */
const displayNameOf = (d: ChannelDraft): string => (d.name !== '' ? d.name : d.id);

const platformLabel = (v: string): string => {
  const p = CHANNEL_PLATFORMS.find((x) => x.v === v);
  return p === undefined ? v : t(p.en, p.zh);
};

/** 卡草稿(卡片显示 + 弹窗回填种子;id 运行期自动生成 platform-<序>)。secret=密钥内联(2026-11-22
 *  裁定,回显已存值);rootText=''=聊天专属工作区(auto);appId=飞书 App ID(ident.appId);dirty=
 *  用户已改写——配置读面晚到回填时只替换未改写卡;model/ident=raw 配置既有值原样携带回写 */
interface ChannelDraft {
  readonly id: string;
  platform: PlatformValue;
  /** 应用名称;'' = 未命名(卡片回退平台名,落盘省 name 键) */
  name: string;
  enabled: boolean;
  /** 通道密钥(内联可回显,2026-11-22 裁定);'' = 未配置 */
  secret: string;
  /** '' = 聊天专属工作区(auto);其余 = 已注册项目 root */
  rootText: string;
  mode: ModeValue;
  /** '' = 跟随全局默认(raw 配置既有值原样携带) */
  model: string;
  /** 飞书 App ID(ident.appId);'' = 未配置 */
  appId: string;
  /** 平台其余非密钥标识(raw 配置既有值原样携带,编辑不丢) */
  ident?: Record<string, string>;
  /** 开放的聊天命令(2026-11-22 裁定命令配置化):子集;落盘=全选省键(absent=全部开放) */
  commands: string[];
  allowKind: AllowKind;
  /** 白名单粘贴原文(空格/逗号/分号/换行分隔),提交时切分去重 */
  userIdsText: string;
  dirty: boolean;
}

/** 健康行 → 卡草稿播种(配置读面缺位/失败时的回退种子) */
const seedDraft = (row: ChannelHealthRowMsg): ChannelDraft => ({
  id: row.id,
  platform: row.platform as PlatformValue,
  name: '',
  enabled: row.enabled,
  secret: '',
  rootText: '',
  mode: 'read-only',
  model: '',
  appId: '',
  ident: undefined,
  commands: [...COMMAND_KEYS],
  allowKind: 'first-user',
  userIdsText: '',
  dirty: false,
});

/** 配置读面行 → 卡草稿:已有通道细粒度字段逐字段回填真值;userIds 数组粘回分隔原文;
 *  commands 缺席(旧档)=全开放 */
const seedFromConfig = (cfg: ChannelConfigMsg): ChannelDraft => ({
  id: cfg.id,
  platform: cfg.platform,
  name: cfg.name ?? '',
  enabled: cfg.enabled,
  secret: cfg.secret ?? '',
  rootText: cfg.root === 'auto' ? '' : cfg.root,
  mode: cfg.mode,
  model: cfg.model ?? '',
  appId: cfg.ident?.appId ?? '',
  ident: cfg.ident,
  commands: cfg.commands ?? [...COMMAND_KEYS],
  allowKind: cfg.allow.kind,
  userIdsText: (cfg.allow.userIds ?? []).join(' '),
  dirty: false,
});

/** 读面两源 → 本地草稿并集单点:配置读面行优先回填真值,健康行补位缺省播种;dirty 卡不覆盖;
 *  removed=本会话已删 id 墓碑;两源均无且未改写的陈旧卡摘除 */
function mergeDrafts(
  prev: ChannelDraft[],
  healthRows: ChannelHealthRowMsg[],
  cfgRows: ChannelConfigMsg[],
  removed: ReadonlySet<string>,
): ChannelDraft[] {
  const seeds = new Map<string, ChannelDraft>();
  for (const c of cfgRows) {
    if (!removed.has(c.id)) seeds.set(c.id, seedFromConfig(c));
  }
  for (const r of healthRows) {
    if (!seeds.has(r.id) && !removed.has(r.id)) seeds.set(r.id, seedDraft(r));
  }
  const out: ChannelDraft[] = [];
  const have = new Set<string>();
  for (const d of prev) {
    if (d.dirty) {
      out.push(d);
      have.add(d.id);
      continue;
    }
    const s = seeds.get(d.id);
    if (s !== undefined) {
      out.push(s);
      have.add(d.id);
    }
  }
  for (const [id, s] of seeds) {
    if (!have.has(id)) out.push(s);
  }
  return out;
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

/** 草稿 → ChannelConfigMsg(全表写行):name 空=未命名省键;secret 空=未配置省键;rootText 空=auto;
 *  ident:appId 合并进既有 ident(非空覆写,空删键);allow list 携切分 userIds */
const toMsg = (d: ChannelDraft): ChannelConfigMsg => {
  const ident: Record<string, string> = { ...(d.ident ?? {}) };
  if (d.appId !== '') ident.appId = d.appId;
  else delete ident.appId;
  // commands:全选=省键(absent=全部开放,后端缺省语义);子集/空数组=显式落键
  const commands = [...d.commands];
  const allSelected = COMMAND_KEYS.every((k) => commands.includes(k)) && commands.length === COMMAND_KEYS.length;
  return {
    id: d.id,
    platform: d.platform,
    enabled: d.enabled,
    ...(d.name !== '' ? { name: d.name } : {}),
    ...(d.secret !== '' ? { secret: d.secret } : {}),
    root: d.rootText === '' ? 'auto' : d.rootText,
    mode: d.mode,
    ...(d.model !== '' ? { model: d.model } : {}),
    ...(Object.keys(ident).length > 0 ? { ident } : {}),
    ...(allSelected ? {} : { commands }),
    allow: d.allowKind === 'list' ? { kind: 'list', userIds: splitUserIds(d.userIdsText) } : { kind: d.allowKind },
  };
};

/** 新卡 id 生成（2026-11-22 用户裁定「feishu-1 太草率,应该 feishu-{随机字符}」）：
 *  `<平台>-<5 位小写无混淆字符>`（去 0/1/l/o/i/v），碰撞重掷（同批草稿查重） */
function newChannelId(platform: string, drafts: ChannelDraft[]): string {
  const alphabet = 'abcdefghjkmnpqrstuwxyz23456789';
  for (;;) {
    let suffix = '';
    for (let i = 0; i < 5; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    const id = `${platform}-${suffix}`;
    if (!drafts.some((d) => d.id === id)) return id;
  }
}

/** 弹窗表单(新增/编辑;平台新增可选、编辑锁定) */
interface ChannelForm {
  platform: string;
  name: string;
  secret: string;
  appId: string;
  rootText: string;
  mode: ModeValue;
  commands: string[];
  allowKind: AllowKind;
  userIdsText: string;
}

const EMPTY_FORM: ChannelForm = { platform: 'feishu', name: '', secret: '', appId: '', rootText: '', mode: 'read-only', commands: [...COMMAND_KEYS], allowKind: 'first-user', userIdsText: '' }; // 平台缺省飞书(2026-11-22 裁定);命令缺省全开放

/** 弹窗开合态:add=新增(平台待选);edit=编辑(锁定 original id) */
interface ChannelModal {
  mode: 'add' | 'edit';
  id?: string;
}

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
   *  提示色规范见 CLAUDE.md) */
  const [testToast, setTestToast] = useState<{ ok: boolean; text: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (ok: boolean, text: string): void => {
    setTestToast({ ok, text });
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setTestToast(null), 3_000);
  };
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
  }, [load]);

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

  /** 删卡(两段确认后):本地摘卡 + id 落墓碑(防轮询复活)→ putChannels 全表少一条 → 重拉 */
  const removeCard = (id: string): void => {
    if (savingId !== '' || drafts === null) return;
    const next = drafts.filter((d) => d.id !== id);
    removedRef.current.add(id);
    setDrafts(next);
    writeAll(next, id);
  };

  /** 试连结果落槽单点(手动测试与保存后自动试连同路径;成功回显 botId,失败简洁化——去内部细节) */
  const recordTest = (_id: string, r: { ok: boolean; botId?: string; error?: string }): void => {
    if (r.ok) {
      showToast(true, `${t('Test passed', '测试通过')} · ${r.botId ?? ''}`);
    } else {
      const raw = r.error ?? '';
      const brief = raw.includes('密钥未配置')
        ? t('No secret configured', '未配置密钥')
        : raw.includes('App ID')
          ? t('Invalid App ID', 'App ID 无效')
          : raw.includes('长连接未建立')
            ? t('Connection failed', '连接失败')
            : raw.split('——')[0]!.split('（')[0]!;
      showToast(false, `${t('Test failed', '测试失败')}：${brief}`);
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
      return;
    }
    setForm({ platform: d.platform, name: d.name, secret: d.secret, appId: d.appId, rootText: d.rootText, mode: d.mode, commands: d.commands, allowKind: d.allowKind, userIdsText: d.userIdsText });
    setModal({ mode: 'edit', id: d.id });
  };

  /** 弹窗保存:putChannels 全表读改写(secret 随条目内联,2026-11-22 裁定)→ 成功关弹窗 + 重拉 +
   *  自动 testChannel 一次。id 新增时自动生成 platform-<序>;编辑保留原 id(平台锁定同因) */
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
    const id = modal.mode === 'edit' ? modal.id! : newChannelId(platform!.v, drafts);
    const saved: ChannelDraft = {
      id,
      platform: (modal.mode === 'edit' ? base!.platform : platform!.v) as PlatformValue,
      name,
      enabled: modal.mode === 'edit' ? base!.enabled : true,
      secret: form.secret,
      rootText: form.rootText,
      mode: form.mode,
      model: base?.model ?? '',
      appId: form.appId.trim(),
      ident: base?.ident,
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
        setSavingId('');
        setDrafts(next);
        setModal(null);
        setForm(EMPTY_FORM);
        load();
        // 自动取名(2026-11-22 用户裁定「保存时自动获取飞书的应用名称做占位」):应用名称留空
        // 且试连拿到平台侧应用名 → 静默回填 name=botId 再落一次(全表写,单门复用)
        return conn.testChannel(id).then(
          (r) => {
            recordTest(id, r);
            const botName = r.ok && saved.name === '' ? r.botId?.trim() : undefined;
            if (botName !== undefined && botName !== '' && botName.length <= NAME_MAX) {
              const named = next.map((d) => (d.id === id ? { ...d, name: botName } : d));
              setDrafts(named);
              setSavingId(id);
              conn
                .putChannels(named.map(toMsg))
                .then(() => {
                  setSavingId('');
                  load();
                }, () => setSavingId(''));
            }
          },
          (err: unknown) => recordTest(id, { ok: false, error: errText(err) }),
        );
      })
      .catch((err: unknown) => {
        setSavingId('');
        setFormError(errText(err));
      });
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
      {/* 卡片列表(ProvidersPane sx-rc 克隆):状态点+应用名称+平台副标+右侧操作簇 */}
      <ul className="sx-rc-list">
        {(drafts ?? []).map((d) => {
          const row = health.find((r) => r.id === d.id);
          return (
            <li key={d.id} className="sx-rc">
              <div className="sx-rc-head">
                <span className={`sx-api-dot ${row?.connected ? 'present' : 'missing'}`} data-tip={row?.detail ?? ''} aria-hidden="true" />
                <span className="sx-rc-title">{displayNameOf(d)}</span>
                <span className="sx-rc-subtitle">{platformLabel(d.platform)}</span>
                <span className="sx-rc-head-acts">
                  {/* 裸图标按钮必带 hover 提示(2026-11-22 全局规范,见 CLAUDE.md):删除两段同名 tip */}
                  <ConfirmDeleteButton icon ariaLabel={`${t('Delete', '删除')} ${d.id}`} dataTip={t('Delete', '删除')} disabled={busy} onConfirm={() => removeCard(d.id)} />
                  <button
                    type="button"
                    className="sx-iconbtn"
                    aria-label={`${t('Test connection', '测试连接')} ${d.id}`}
                    data-tip={t('Test connection', '测试连接')}
                    disabled={busy}
                    onClick={() => testOnly(d.id)}
                  >
                    <PlugZap size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="sx-iconbtn"
                    aria-label={`${t('Edit', '编辑')} ${d.id}`}
                    data-tip={t('Edit', '编辑')}
                    disabled={busy}
                    onClick={() => openModal(d)}
                  >
                    <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <Switch on={d.enabled} onToggle={() => toggleCard(d)} ariaLabel={`${t('Enable', '启用')} ${d.id}`} disabled={busy} />
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
        })}
      </ul>
      {/* 新增/编辑弹窗:标题=应用名称(2026-11-22 用户裁定「应用名称是飞书1,编辑 feishu-1 是什么」
          ——显示名回退通道 id);平台/应用名称/凭证/工作区/权限模式/聊天命令/准入;下拉全走共享
          Select/MultiSelect 弹层控件(2026-11-22 裁定:弃原生 select);工作区=文本框+文件夹钮 */}
      {modal !== null && (
        <EditorModal
          open
          title={
            modal.mode === 'add'
              ? t('New channel', '新增通道')
              : t(`Edit ${drafts?.find((d) => d.id === modal.id)?.name || (modal.id ?? '')}`, `编辑 ${drafts?.find((d) => d.id === modal.id)?.name || (modal.id ?? '')}`)
          }
          onClose={() => setModal(null)}
          onSubmit={submitChannel}
        >
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
                onClick={pickWorkspaceFolder}
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
        </EditorModal>
      )}
      {testToast !== null && (
        <div className={`sx-toast ${testToast.ok ? 'sx-toast-ok' : 'sx-toast-err'}`} role="status">
          {testToast.text}
        </div>
      )}
    </section>
  );
}

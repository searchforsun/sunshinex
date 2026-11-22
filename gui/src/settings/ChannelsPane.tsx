import { Pencil, PlugZap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import { ConfirmDeleteButton, EditorModal, EmptyState, ErrorBanner, ModalField, Switch, scopeTargetLabel } from './components';
import type { ChannelConfigMsg, ChannelHealthRowMsg } from '../connection-api';
import type { WorkspaceRow } from '../connection';

/**
 * ChannelsPane(channels Task 15,spec §8 **2026-11-22 终形态裁定**,推翻前两版):通道设置页
 * **完整克隆「模型与提供方」(ProvidersPane)形态**——保留多实例,卡片列表 + 弹窗编辑。
 *
 * 页面结构(ProvidersPane verbatim 克隆):节头「通道」+ 一句人话简介 + 「+ 新增通道」工具栏
 * (稳定搜索锚 channels.add)+ 凭证一句说明(稳定搜索锚 channels.secret,settings-search.ts 既有
 * 注册不可改——本文件不在允许改动清单)+ 每通道一张卡片:状态点(sx-api-dot 绿=connected/
 * 灰=断连,取 channelsView 健康轮询,detail 悬浮)+ 应用名称(粗体 sx-rc-title,缺省回退平台名)
 * + 平台副标;右侧操作簇(sx-rc-head-acts,ProvidersPane 同款序)= 测试连接(PlugZap 图标钮)
 * / 删除(ConfirmDeleteButton 两段确认)/ 编辑(Pencil 图标钮)/ 启用 Switch。卡片无内嵌表单——
 * 全部编辑走弹窗(EditorModal/ModalField,ProvidersPane 2026-10-30 弹窗形态同款)。
 *
 * 新增/编辑弹窗字段(spec §8 终形态字段清单):平台下拉(新增可选 Telegram/Mock(测试),
 * 飞书/钉钉/企微在「即将支持」optgroup 内 disabled 不可选;编辑锁定只读展示——id 是键不可换)
 * / 应用名称(text,1..80,占位随平台;留空缺省平台名=落盘省 name 键)/ 按平台凭证字段(Telegram:
 * Bot Token password + @BotFather 引导;mock 免密无凭证组;未支持平台不可选到故无凭证组)
 * / 工作区下拉(「聊天专属工作区(自动)」缺省 + conn.workspaces() 注册表)/ 权限模式下拉
 * (read-only 缺省,full-access 红字警示)/ 准入下拉(仅首次对话用户缺省/自定义白名单 textarea/
 * 不限红字)。保存 → putChannels 全表读改写 → 成功自动 testChannel 一次(结果行内 role=status,
 * 成功回显机器人身份失败回显平台错误原文);模型字段不在终形态清单内——草稿仍保留 cfg 既有
 * model/ident 值原样回写(编辑不丢 raw 配置的细粒度字段,只是 GUI 不再提供编辑面)。
 *
 * 凭证与 D6(spec §8.2,2026-11-22 终形态修复波):通道密钥写面 = PUT /channels/:id/secret
 * (serve handleChannelsSecretPut——写全局 settings.json env 块 SUNSHINEX_CHANNEL_SECRET_<ID> 槽,
 * providers setKey 同机制;GUI 侧 conn.setChannelSecret)。弹窗保存链:putChannels 全表 → token
 * 非空时 setChannelSecret(id, token) → 成功自动 testChannel 一次(dry-run,链重载后取新槽值)。
 * Bot Token 输入零回显(ProvidersPane 密钥行同纪律:播种恒空串,留空=不动 env 键——不调
 * setChannelSecret);凭证区一句「密钥保存到 settings.json 的 env 块;此处输入不会明文回显」。
 * 文案裁定:顶部一句简介;旧版 D6/env 槽内部术语段删除。
 *
 * 读面/回填(修复波 mergeDrafts 语义保留):挂载时 channelsView(健康)+ settingsChannels(配置)
 * 双源并行,各落 ref 后 applySources 单点重算——配置行逐字段回填弹窗草稿真值,健康行补位缺省
 * 播种;本地已改写(dirty)卡不被回填覆盖;removed 墓碑防已删卡被轮询复活;token 为本地态,
 * 重播种时从前稿随行携带(config 无此字段)。健康 5s 轮询(brief §12)只刷状态点。
 *
 * id 自动生成:platform-<序>(同前缀最大序 +1),不暴露手填;启用 Switch/删除即改即写
 * (putChannels 全表,ProvidersPane runOp 即写同语义);写面在途单门(savingId)禁再发。
 */

/** 通道页连接面(Task 11 六方法 + 修复波 settingsChannels 读端点,结构满足即收,App 传整只
 *  Connection) */
export interface ChannelsPaneConn {
  channelsView(): Promise<{ channels: ChannelHealthRowMsg[] }>;
  /** GET /settings/channels(修复波补面):全局档 channels 配置读端点——已有通道弹窗回填
   *  真值的数据源(serve handleChannelsGet 同形状) */
  settingsChannels(): Promise<{ channels: ChannelConfigMsg[]; warnings: string[] }>;
  putChannels(channels: ChannelConfigMsg[]): Promise<{ ok: true; warnings: string[] }>;
  testChannel(id: string): Promise<{ ok: boolean; botId?: string; error?: string }>;
  /** PUT /channels/:id/secret(2026-11-22 终形态修复波):通道密钥写面——写全局 settings.json env
   *  块 SUNSHINEX_CHANNEL_SECRET_<ID> 槽(D6:密钥不进 channels 键);空串=删除;响应零回显 */
  setChannelSecret(id: string, secret: string): Promise<{ ok: true }>;
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

/** 应用名称长度上限(spec §8 终形态:1..80,trim) */
const NAME_MAX = 80;

/** 应用名称占位随平台(终形态裁定:占位如「我的飞书机器人」) */
const NAME_PLACEHOLDERS: Record<string, { en: string; zh: string }> = {
  telegram: { en: 'My Telegram bot', zh: '我的 Telegram 机器人' },
  feishu: { en: 'My Feishu bot', zh: '我的飞书机器人' },
  dingtalk: { en: 'My DingTalk bot', zh: '我的钉钉机器人' },
  wecom: { en: 'My WeCom bot', zh: '我的企业微信机器人' },
  mock: { en: 'My Mock bot', zh: '我的 Mock 机器人' },
};

/** 卡片展示名(应用名称缺省回退平台名;仅展示——写面 name 缺席即省键,平台名由 UI 回退) */
const displayNameOf = (d: ChannelDraft): string => (d.name !== '' ? d.name : platformLabel(d.platform));

const platformLabel = (v: string): string => {
  const p = PLATFORMS.find((x) => x.v === v);
  return p === undefined ? v : t(p.en, p.zh);
};

/** 卡草稿(卡片显示 + 弹窗回填种子;id 运行期自动生成 platform-<序>,不暴露手填)。
 *  dirty=用户已改写——配置读面晚到回填时只替换未改写(seed)卡;token 不入草稿(密钥写面独立走
 *  setChannelSecret,弹窗输入零回显——播种恒空串,留空=不动 env 键);model/ident=raw 配置既有值
 *  原样携带回写(GUI 无编辑面,保真不丢) */
interface ChannelDraft {
  readonly id: string;
  platform: PlatformValue;
  /** 应用名称(spec §8 终形态);'' = 未命名(卡片回退平台名,落盘省 name 键) */
  name: string;
  enabled: boolean;
  /** 'auto' = 聊天专属工作区(缺省);其余 = 已注册项目 root */
  root: string;
  mode: ModeValue;
  /** '' = 跟随全局默认(raw 配置既有值原样携带,GUI 无编辑面) */
  model: string;
  /** 平台非密钥标识(raw 配置既有值原样携带,编辑不丢) */
  ident?: Record<string, string>;
  allowKind: AllowKind;
  /** 白名单粘贴原文(空格/逗号/分号/换行分隔),提交时切分去重 */
  userIdsText: string;
  dirty: boolean;
}

/** 健康行 → 卡草稿播种(id/platform/enabled 取真值,其余字段取写面缺省——配置读面缺位/失败
 *  时的回退种子) */
const seedDraft = (row: ChannelHealthRowMsg): ChannelDraft => ({
  id: row.id,
  platform: row.platform as PlatformValue,
  name: '',
  enabled: row.enabled,
  root: 'auto',
  mode: 'read-only',
  model: '',
  allowKind: 'first-user',
  userIdsText: '',
  dirty: false,
});

/** 配置读面行 → 卡草稿(修复波语义保留):已有通道细粒度字段逐字段回填真值;userIds 数组粘回
 *  分隔原文;name/model/ident 原样携带(弹窗回填 + 回写保真) */
const seedFromConfig = (cfg: ChannelConfigMsg): ChannelDraft => ({
  id: cfg.id,
  platform: cfg.platform,
  name: cfg.name ?? '',
  enabled: cfg.enabled,
  root: cfg.root,
  mode: cfg.mode,
  model: cfg.model ?? '',
  ident: cfg.ident,
  allowKind: cfg.allow.kind,
  userIdsText: (cfg.allow.userIds ?? []).join(' '),
  dirty: false,
});

/** 读面两源 → 本地草稿并集单点(修复波 mergeDrafts 语义保留):配置读面行优先回填真值,健康行
 *  补位缺省播种;本地已改写(dirty)卡不覆盖(用户输入为准);removed=本会话已删 id 墓碑——健康
 *  快照晚到/轮询窗口内仍报该行时不复活已删卡;两源均无且未改写的陈旧卡摘除(外部已删真值) */
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
      out.push(d); // 用户已改写:原样保留
      have.add(d.id);
      continue;
    }
    const s = seeds.get(d.id);
    if (s !== undefined) {
      out.push(s); // 未改写:两源最新种子替换(配置真值回填/健康缺省)
      have.add(d.id);
    }
    // 两源均无且未改写:外部已删的陈旧种子——摘除
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

/** 草稿 → ChannelConfigMsg(全表写行):name 空=未命名省键(缺省平台名由 UI 决定);model 空=跟随
 *  全局省键;allow list 携切分 userIds,其余 kind 无附加键;ident 原样携带 */
const toMsg = (d: ChannelDraft): ChannelConfigMsg => ({
  id: d.id,
  platform: d.platform,
  enabled: d.enabled,
  ...(d.name !== '' ? { name: d.name } : {}),
  root: d.root,
  mode: d.mode,
  ...(d.model !== '' ? { model: d.model } : {}),
  ...(d.ident !== undefined && Object.keys(d.ident).length > 0 ? { ident: d.ident } : {}),
  allow: d.allowKind === 'list' ? { kind: 'list', userIds: splitUserIds(d.userIdsText) } : { kind: d.allowKind },
});

/** 新卡 id 序号单点:platform-<序>,取既有同前缀最大序 +1(不暴露手填) */
function nextSeq(platform: string, drafts: ChannelDraft[]): number {
  const re = new RegExp(`^${platform}-(\\d+)$`);
  let max = 0;
  for (const d of drafts) {
    const m = re.exec(d.id);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** 弹窗表单(新增/编辑;平台新增可选、编辑锁定;token=本地态) */
interface ChannelForm {
  platform: string;
  name: string;
  token: string;
  root: string;
  mode: ModeValue;
  allowKind: AllowKind;
  userIdsText: string;
}

const EMPTY_FORM: ChannelForm = { platform: '', name: '', token: '', root: 'auto', mode: 'read-only', allowKind: 'first-user', userIdsText: '' };

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
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  /** 写面在途门(单通道在途:保存/删除/试连/Switch 共用——禁再发) */
  const [savingId, setSavingId] = useState('');
  /** 试连结果行内提示(id → 结果;保存成功自动试连与手动测试同槽) */
  const [testMap, setTestMap] = useState<Record<string, { ok: boolean; detail: string }>>({});
  /** 弹窗开合态 + 表单 + 弹窗校验错误(EditorModal/ModalField,ProvidersPane 弹窗形态) */
  const [modal, setModal] = useState<ChannelModal | null>(null);
  const [form, setForm] = useState<ChannelForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  /** 本会话已删通道 id 墓碑(mergeDrafts 防复活面;ref 持有免 useCallback 依赖抖动) */
  const removedRef = useRef<Set<string>>(new Set());
  /** 配置读面双源 ref(修复波):两响应到达次序不定——各落 ref 后 applySources 单点重算草稿 */
  const healthRef = useRef<ChannelHealthRowMsg[]>([]);
  const cfgRef = useRef<ChannelConfigMsg[]>([]);
  /** 配置读面 warnings(读面宽容语义:warning 跳过不致命——行内提示,不阻断编辑) */
  const [cfgWarnings, setCfgWarnings] = useState<string[]>([]);
  /** 双源 → 草稿重算单点(健康/配置 ref 就位后调用;状态点源同步刷新) */
  const applySources = useCallback((): void => {
    setHealth(healthRef.current);
    setDrafts((prev) => mergeDrafts(prev ?? [], healthRef.current, cfgRef.current, removedRef.current));
  }, []);

  /** 读面装载(修复波语义保留):健康快照(channelsView)+ 配置读面(settingsChannels)双源并行,
   *  各自先落 ref 再统一 applySources 重算草稿;配置读面失败静默(保持健康缺省播种) */
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

  /** 5s 健康轮询(brief §12):只刷状态点,不扰弹窗草稿;卸载 clearInterval */
  useEffect(() => {
    const timer = setInterval(() => {
      conn.channelsView().then((v) => {
        healthRef.current = v.channels;
        setHealth(v.channels);
      }, () => {});
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

  /** 试连结果落槽单点(手动测试与保存后自动试连同路径;成功回显 botId,失败回显平台错误) */
  const recordTest = (id: string, r: { ok: boolean; botId?: string; error?: string }): void => {
    setTestMap((m) => ({ ...m, [id]: { ok: r.ok, detail: r.ok ? r.botId ?? '' : r.error ?? '' } }));
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

  /** 打开弹窗:add=写面缺省草稿(平台待选);edit=卡片草稿逐字段回填(settingsChannels 真值
   *  已经 mergeDrafts 回填进草稿;token 恒空串——零回显纪律,留空=不动 env 键) */
  const openModal = (d: ChannelDraft | null): void => {
    setFormError('');
    if (d === null) {
      setForm(EMPTY_FORM);
      setModal({ mode: 'add' });
      return;
    }
    setForm({ platform: d.platform, name: d.name, token: '', root: d.root, mode: d.mode, allowKind: d.allowKind, userIdsText: d.userIdsText });
    setModal({ mode: 'edit', id: d.id });
  };

  /** 弹窗保存(spec §8.3 + 2026-11-22 终形态修复波):putChannels 全表读改写 → token 非空时
   *  setChannelSecret(id, token)(密钥腿——写 env 块槽,留空=不动键)→ 成功关弹窗 + 重拉 +
   *  自动 testChannel 一次(链重载后 dry-run 取新槽值)。id 新增时自动生成 platform-<序>(同前缀
   *  最大序 +1,不暴露手填);编辑保留原 id(平台锁定同因) */
  const submitChannel = (): void => {
    if (modal === null || savingId !== '' || drafts === null) return;
    const platform = PLATFORMS.find((p) => p.v === form.platform);
    if (modal.mode === 'add' && (platform === undefined || !platform.supports)) {
      setFormError(t('Choose a platform', '请选择平台'));
      return;
    }
    const name = form.name.trim();
    if (name.length > NAME_MAX) {
      setFormError(t(`App name must be at most ${NAME_MAX} characters`, `应用名称至多 ${NAME_MAX} 字`));
      return;
    }
    if (form.allowKind === 'list' && splitUserIds(form.userIdsText).length === 0) {
      setFormError(t('Allow-list needs at least one user id', '白名单准入至少需要一个 userId'));
      return;
    }
    const base = modal.mode === 'edit' ? drafts.find((d) => d.id === modal.id) : undefined;
    if (modal.mode === 'edit' && base === undefined) {
      setFormError(t('Channel not found', '通道不存在'));
      return;
    }
    const id = modal.mode === 'edit' ? modal.id! : `${platform!.v}-${nextSeq(platform!.v, drafts)}`;
    const token = form.token;
    const saved: ChannelDraft = {
      id,
      platform: (modal.mode === 'edit' ? base!.platform : platform!.v) as PlatformValue,
      name,
      enabled: modal.mode === 'edit' ? base!.enabled : true,
      root: form.root,
      mode: form.mode,
      model: base?.model ?? '',
      ident: base?.ident,
      allowKind: form.allowKind,
      userIdsText: form.userIdsText,
      dirty: false, // 已落盘:读面真值即本地值,回拉重播种不回退
    };
    const next = modal.mode === 'edit' ? drafts.map((d) => (d.id === id ? saved : d)) : [...drafts, saved];
    setSavingId(id);
    setFormError('');
    conn
      .putChannels(next.map(toMsg))
      .then(() => (token !== '' ? conn.setChannelSecret(id, token) : undefined)) // 密钥腿(留空=不动键)
      .then(() => {
        setSavingId('');
        setDrafts(next);
        setModal(null);
        setForm(EMPTY_FORM);
        load();
        return conn.testChannel(id).then(
          (r) => recordTest(id, r),
          (err: unknown) => recordTest(id, { ok: false, error: errText(err) }),
        );
      })
      .catch((err: unknown) => {
        setSavingId('');
        setFormError(errText(err));
      });
  };

  const loading = drafts === null && loadError === '';
  const busy = savingId !== '';
  return (
    <section className="sx-settings-form" aria-label="settings pane channels">
      <h2>{t('Channels', '通道')}</h2>
      {/* 一句人话简介(终形态裁定;顶部唯一导语) */}
      <p className="sx-provider-hint">
        {t('Connect Feishu / DingTalk / WeCom / Telegram chats to sunshine sessions.', '把飞书/钉钉/企业微信/Telegram 的聊天接入 sunshine 会话。')}
      </p>
      {/* 添加通道工具栏(稳定搜索锚 channels.add) */}
      <div className="sx-res-toolbar" data-setting-key="channels.add">
        <button type="button" className="sx-add-button" onClick={() => openModal(null)}>
          {t('+ New channel', '+ 新增通道')}
        </button>
      </div>
      {/* 凭证一句说明(稳定搜索锚 channels.secret——settings-search 既有注册;终形态文案口径) */}
      <p className="sx-provider-hint" data-setting-key="channels.secret">
        {t(
          'Secrets live in the settings.json env block (SUNSHINEX_CHANNEL_SECRET_<ID>) and are never shown on this page.',
          '密钥存放于 settings.json 的 env 块（SUNSHINEX_CHANNEL_SECRET_<ID>），不在此页显示。',
        )}
      </p>
      {loadError !== '' && <ErrorBanner text={loadError} />}
      {actionError !== '' && <ErrorBanner text={actionError} />}
      {/* 配置读面 warnings(读面宽容语义——坏条目跳过提示,不阻断编辑) */}
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
                {/* 操作簇(ProvidersPane 同款):测试连接→删除→编辑→启用开关 */}
                <span className="sx-rc-head-acts">
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
                  <ConfirmDeleteButton icon ariaLabel={`${t('Delete', '删除')} ${d.id}`} disabled={busy} onConfirm={() => removeCard(d.id)} />
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
              {/* 试连结果行内提示(保存后自动试连与手动测试共用;role=status) */}
              {testMap[d.id] !== undefined && (
                <p role="status" className={testMap[d.id]!.ok ? 'sx-provider-hint' : 'sx-provider-warn'}>
                  {testMap[d.id]!.ok
                    ? `${t('Test passed', '测试通过')}${testMap[d.id]!.detail !== '' ? ` · ${testMap[d.id]!.detail}` : ''}`
                    : `${t('Test failed', '测试失败')}: ${testMap[d.id]!.detail}`}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {/* 新增/编辑弹窗(EditorModal/ModalField,ProvidersPane 弹窗形态):平台/应用名称/凭证/
          工作区/权限模式/准入;下拉用原生 select——「即将支持」需 disabled 选项语义 */}
      {modal !== null && (
        <EditorModal
          open
          title={modal.mode === 'add' ? t('New channel', '新增通道') : t(`Edit ${modal.id ?? ''}`, `编辑 ${modal.id ?? ''}`)}
          onClose={() => setModal(null)}
          onSubmit={submitChannel}
        >
          <ModalField label={t('Platform', '平台')}>
            {modal.mode === 'add' ? (
              <select
                className="sx-setting-input"
                aria-label={t('Platform', '平台')}
                value={form.platform}
                onChange={(e) => setForm({ ...form, platform: e.target.value })}
              >
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
            ) : (
              /* 编辑锁定:id 是键不可换——只读展示平台名 */
              <select className="sx-setting-input" aria-label={t('Platform', '平台')} value={form.platform} disabled>
                <option value={form.platform}>{platformLabel(form.platform)}</option>
              </select>
            )}
          </ModalField>
          <ModalField label={t('App name', '应用名称')} hint={t('Leave empty to use the platform name', '留空缺省平台名')}>
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
          {/* 凭证区(按平台;终形态修复波:Telegram Bot Token password + @BotFather 引导 + 保存去向
              一句;mock 免密无凭证组;未支持平台不可选到) */}
          {form.platform === 'telegram' && (
            <ModalField label={t('Bot Token', 'Bot Token')} hint={t('Get it from @BotFather on Telegram', '在 Telegram 向 @BotFather 获取')}>
              <input
                type="password"
                className="sx-setting-input"
                aria-label={t('Bot Token', 'Bot Token')}
                value={form.token}
                autoComplete="new-password"
                onChange={(e) => setForm({ ...form, token: e.target.value })}
                spellCheck={false}
              />
              <p className="sx-provider-hint">
                {t(
                  'The secret is saved to the settings.json env block; what you type here is never echoed back.',
                  '密钥保存到 settings.json 的 env 块；此处输入不会明文回显。',
                )}
              </p>
            </ModalField>
          )}
          <ModalField
            label={t('Workspace', '工作区')}
            hint={t('Chat-only workspace by default; binding a registered project is for advanced use', '缺省聊天专属工作区;绑定真实项目为高级用法')}
          >
            <select className="sx-setting-input" aria-label={t('Workspace', '工作区')} value={form.root} onChange={(e) => setForm({ ...form, root: e.target.value })}>
              <option value="auto">{t('Chat-only workspace (auto)', '聊天专属工作区(自动)')}</option>
              {workspaces.map((w) => (
                <option key={w.root} value={w.root}>
                  {scopeTargetLabel(w.root!)}
                </option>
              ))}
            </select>
          </ModalField>
          <ModalField label={t('Access mode', '权限模式')}>
            <select
              className="sx-setting-input"
              aria-label={t('Access mode', '权限模式')}
              value={form.mode}
              onChange={(e) => setForm({ ...form, mode: e.target.value as ModeValue })}
            >
              <option value="read-only">{t('Read-only', '只读')}</option>
              <option value="acceptEdits">{t('Accept edits', '接受编辑')}</option>
              <option value="full-access">{t('Full access', '完全访问')}</option>
            </select>
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
            <select
              className="sx-setting-input"
              aria-label={t('Admission', '准入')}
              value={form.allowKind}
              onChange={(e) => setForm({ ...form, allowKind: e.target.value as AllowKind })}
            >
              <option value="first-user">{t('First respondent only', '仅首次对话用户')}</option>
              <option value="list">{t('Custom allow-list', '自定义白名单')}</option>
              <option value="all">{t('Open to everyone', '不限')}</option>
            </select>
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
          {formError !== '' && <ErrorBanner text={formError} />}
        </EditorModal>
      )}
    </section>
  );
}

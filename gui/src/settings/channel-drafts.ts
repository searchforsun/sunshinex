import { t } from '../i18n';
import { CHANNEL_PLATFORMS } from '../sidebar/use-menu-channels';
import type { ChannelConfigMsg, ChannelHealthRowMsg } from '../connection-api';

/**
 * 通道卡草稿引擎单点（D112 拆分件一，自 ChannelsPane 平迁零行为变化）：卡草稿形态/双源回填
 * （配置行逐字段真值+健康行缺省播种）/mergeDrafts 并集（dirty 卡不覆盖+removed 墓碑+陈旧卡
 * 摘除）/全表写行投影 toMsg/id 生成/展示名与标签 helpers。纯件零 React——ChannelsPane（装配）
 * /ChannelModalForm（表单）/ChannelCard（卡片）三消费面共用。
 */

export type PlatformValue = ChannelConfigMsg['platform'];
export type ModeValue = ChannelConfigMsg['mode'];
export type AllowKind = ChannelConfigMsg['allow']['kind'];

/** 应用名称长度上限(spec §8 终形态:1..80,trim) */
export const NAME_MAX = 80;

/** 应用名称占位随平台（新增下拉可选平台；CHANNEL_PLATFORMS 之外回落通用占位） */
export const NAME_PLACEHOLDERS: Record<string, { en: string; zh: string }> = {
  feishu: { en: 'My Feishu bot', zh: '我的飞书机器人' },
  telegram: { en: 'My Telegram bot', zh: '我的 Telegram 机器人' },
};

/** 聊天命令目录（镜像 serve/channels/model.ts CHANNEL_COMMANDS——2026-11-22 用户裁定
 *  「配置可以给聊天执行的命令,一个下拉多选(每项的命令以及说明)」):label=命令+一句说明 */
export const COMMAND_OPTIONS: ReadonlyArray<{ v: string; en: string; zh: string }> = [
  { v: '/help', en: '/help — Show this help', zh: '/help — 显示本帮助' },
  { v: '/stop', en: '/stop — Stop the current task', zh: '/stop — 停止当前任务' },
  { v: '/new', en: '/new — Start a new conversation', zh: '/new — 开始新对话' },
  { v: '/status', en: '/status — Check task status', zh: '/status — 查看任务状态' },
];
export const COMMAND_KEYS: readonly string[] = COMMAND_OPTIONS.map((o) => o.v);

const MODE_LABELS: Record<ModeValue, { en: string; zh: string }> = {
  'read-only': { en: 'Read-only', zh: '只读' },
  acceptEdits: { en: 'Accept edits', zh: '接受编辑' },
  'full-access': { en: 'Full access', zh: '完全访问' },
};
export const modeLabel = (m: ModeValue): string => t(MODE_LABELS[m].en, MODE_LABELS[m].zh);

export const allowLabel = (d: ChannelDraft): string => {
  if (d.allowKind === 'first-user') return t('First respondent only', '仅首次对话用户');
  if (d.allowKind === 'all') return t('Open to everyone', '不限');
  const n = splitUserIds(d.userIdsText).length;
  return `${t('Allow-list', '白名单')}(${n})`;
};

/** 卡片展示名（2026-11-22 用户裁定「应用名称是飞书1,编辑 feishu-1 是什么」:显示名=应用名称,
 *  缺省回退通道 id(内部标识如实示人)——不再回退平台名(与副标重复成「飞书 飞书」) */
export const displayNameOf = (d: ChannelDraft): string => (d.name !== '' ? d.name : d.id);

export const platformLabel = (v: string): string => {
  const p = CHANNEL_PLATFORMS.find((x) => x.v === v);
  return p === undefined ? v : t(p.en, p.zh);
};

/** 卡草稿(卡片显示 + 弹窗回填种子;id 运行期自动生成 platform-<序>)。secret=密钥内联(2026-11-22
 *  裁定,回显已存值);rootText=''=聊天专属工作区(auto);appId=飞书 App ID(ident.appId);dirty=
 *  用户已改写——配置读面晚到回填时只替换未改写卡;model/ident=raw 配置既有值原样携带回写 */
export interface ChannelDraft {
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
  /** '' = 跟随全局默认(2026-11-23 用户裁定「可以选择默认的模型和强度」) */
  effort: string;
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
  effort: '',
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
  effort: cfg.effort ?? '',
  appId: cfg.ident?.appId ?? '',
  ident: cfg.ident,
  commands: cfg.commands ?? [...COMMAND_KEYS],
  allowKind: cfg.allow.kind,
  userIdsText: (cfg.allow.userIds ?? []).join(' '),
  dirty: false,
});

/** 读面两源 → 本地草稿并集单点:配置读面行优先回填真值,健康行补位缺省播种;dirty 卡不覆盖;
 *  removed=本会话已删 id 墓碑;两源均无且未改写的陈旧卡摘除 */
export function mergeDrafts(
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
export function splitUserIds(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;，；]+/)) {
    const id = raw.trim();
    if (id !== '' && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 草稿 → ChannelConfigMsg(全表写行):name 空=未命名省键;secret 空=未配置省键;rootText 空=auto;
 *  ident:appId 合并进既有 ident(非空覆写,空删键);allow list 携切分 userIds */
export const toMsg = (d: ChannelDraft): ChannelConfigMsg => {
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
    ...(d.effort !== '' ? { effort: d.effort } : {}),
    ...(Object.keys(ident).length > 0 ? { ident } : {}),
    ...(allSelected ? {} : { commands }),
    allow: d.allowKind === 'list' ? { kind: 'list', userIds: splitUserIds(d.userIdsText) } : { kind: d.allowKind },
  };
};

/** 新卡 id 生成（2026-11-22 用户裁定「feishu-1 太草率,应该 feishu-{随机字符}」）：
 *  `<平台>-<5 位小写无混淆字符>`（去 0/1/l/o/i/v），碰撞重掷（同批草稿查重） */
export function newChannelId(platform: string, drafts: ChannelDraft[]): string {
  const alphabet = 'abcdefghjkmnpqrstuwxyz23456789';
  for (;;) {
    let suffix = '';
    for (let i = 0; i < 5; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    const id = `${platform}-${suffix}`;
    if (!drafts.some((d) => d.id === id)) return id;
  }
}

/** 弹窗表单(新增/编辑;平台新增可选、编辑锁定) */
export interface ChannelForm {
  platform: string;
  name: string;
  secret: string;
  appId: string;
  rootText: string;
  mode: ModeValue;
  model: string;
  effort: string;
  commands: string[];
  allowKind: AllowKind;
  userIdsText: string;
}

export const EMPTY_FORM: ChannelForm = { platform: 'feishu', name: '', secret: '', appId: '', rootText: '', mode: 'read-only', model: '', effort: '', commands: [...COMMAND_KEYS], allowKind: 'first-user', userIdsText: '' }; // 平台缺省飞书(2026-11-22 裁定);命令缺省全开放

/** 弹窗开合态:add=新增(平台待选);edit=编辑(锁定 original id) */
export interface ChannelModal {
  mode: 'add' | 'edit';
  id?: string;
}

/** 通道配置模型（spec 2026-11-21-channels §4 存储总览）：settings.json `channels` 结构化语义键形状裁决单点——
 *  非法条目 warning 跳过不致命（providers 键同语义）；键内零密钥（D6「设置与凭据分离」），
 *  密钥按通道名走 env 槽 SUNSHINEX_CHANNEL_SECRET_<大写通道名>（派生规则同 config/providers.ts providerApiKeyEnv）。 */

export type ChannelPlatform = 'feishu' | 'dingtalk' | 'wecom' | 'telegram' | 'mock';
export type ChannelAccessMode = 'read-only' | 'acceptEdits' | 'full-access';
export type AllowKind = 'first-user' | 'list' | 'all';

export interface ChannelAllowConfig {
  kind: AllowKind;
  userIds?: string[];
  chatIds?: string[];
}

export interface ChannelConfig {
  id: string;
  platform: ChannelPlatform;
  enabled: boolean;
  root: string;
  mode: ChannelAccessMode;
  model?: string;
  /** 平台非密钥标识（feishu appId / wecom botId 等）——密钥不在此（D6），env 槽承载 */
  ident?: Record<string, string>;
  allow: ChannelAllowConfig;
}

export interface Binding {
  key: string;
  sessionId: string;
  journalId?: string;
  lockedUserId?: string;
  /** 绑定工作区切换覆盖（spec §4 schema rootOverride 列）：聊天信息条写入，下次 /new 生效；
   *  仅类型层存在，不经 parseChannelsKey 解析（bindings 不走 channels 键） */
  rootOverride?: string;
  /** 聊天形态（spec §9.3 单聊/群聊标）：首绑定时自入站消息取，聊天信息条单聊/群聊标消费；
   *  绑定元数据，/new 重绑保留语义同 lockedUserId/rootOverride */
  chatKind?: 'direct' | 'group';
  updatedAt: number;
}

export interface InboundMessage {
  channel: string;
  chatId: string;
  chatKind: 'direct' | 'group';
  userId: string;
  /** 发送者展示名（平台昵称），缺省回退 userId */
  userDisplay?: string;
  msgId: string;
  text?: string;
  images?: string[];
  atBot?: boolean;
  raw?: unknown;
}

export interface OutboundMessage {
  text: string;
  markdown?: boolean;
}

export interface DeliveryCaps {
  streaming: boolean;
  markdown: boolean;
  card: boolean;
  maxTextLength: number;
}

const PLATFORMS: readonly ChannelPlatform[] = ['feishu', 'dingtalk', 'wecom', 'telegram', 'mock'];
const MODES: readonly ChannelAccessMode[] = ['read-only', 'acceptEdits', 'full-access'];
const ALLOW_KINDS: readonly AllowKind[] = ['first-user', 'list', 'all'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function channelSecretEnv(id: string): string {
  return 'SUNSHINEX_CHANNEL_SECRET_' + id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export function bindingKey(channelId: string, chatId: string): string {
  return `${channelId}:${chatId}`;
}

export function parseChannelsKey(raw: unknown): { value: ChannelConfig[]; warnings: string[] } {
  if (!Array.isArray(raw)) return { value: [], warnings: ['channels 键须为数组'] };
  const value: ChannelConfig[] = [];
  const warnings: string[] = [];
  raw.forEach((item, i) => {
    if (!isRecord(item)) { warnings.push(`channels[${i}] 非对象，跳过`); return; }
    const id = typeof item['id'] === 'string' ? item['id'].trim() : '';
    const platform = item['platform'];
    const mode = item['mode'];
    const allow = item['allow'];
    if (id === '') { warnings.push(`channels[${i}] 缺 id，跳过`); return; }
    if (typeof platform !== 'string' || !(PLATFORMS as readonly string[]).includes(platform)) {
      warnings.push(`channels[${i}](${id}) platform 非法，跳过`); return;
    }
    if (typeof item['root'] !== 'string' || (item['root'] as string).trim() === '') {
      warnings.push(`channels[${i}](${id}) 缺 root，跳过`); return;
    }
    if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) {
      warnings.push(`channels[${i}](${id}) mode 非法，跳过`); return;
    }
    if (!isRecord(allow) || typeof allow['kind'] !== 'string' || !(ALLOW_KINDS as readonly string[]).includes(allow['kind'])) {
      warnings.push(`channels[${i}](${id}) allow 非法，跳过`); return;
    }
    const allowCfg = allow as Record<string, unknown>;
    const strArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
    const model = typeof item['model'] === 'string' && item['model'].trim() !== '' ? item['model'] : undefined;
    const identRaw = item['ident'];
    const ident = isRecord(identRaw)
      ? Object.fromEntries(Object.entries(identRaw).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      : undefined;
    value.push({
      id,
      platform: platform as ChannelPlatform,
      enabled: item['enabled'] === true,
      root: (item['root'] as string).trim(),
      mode: mode as ChannelAccessMode,
      ...(model !== undefined ? { model } : {}),
      ...(ident !== undefined && Object.keys(ident).length > 0 ? { ident } : {}),
      allow: {
        kind: allowCfg['kind'] as AllowKind,
        ...(strArr(allowCfg['userIds']) !== undefined ? { userIds: strArr(allowCfg['userIds']) } : {}),
        ...(strArr(allowCfg['chatIds']) !== undefined ? { chatIds: strArr(allowCfg['chatIds']) } : {}),
      },
    });
  });
  return { value, warnings };
}

/** 通道配置模型（spec 2026-11-21-channels §4 存储总览；§8 2026-11-22 终形态加 name）：settings.json `channels`
 *  结构化语义键形状裁决单点——非法条目 warning 跳过不致命（providers 键同语义）。`secret` = 通道密钥
 *  **内联进条目**（2026-11-22 用户裁定推翻 D6「设置与凭据分离」：env 分组承载密钥维护成本过高、且
 *  不可回显导致 GUI 配置不闭环——密钥随配置项存放、GET 可回显；settings.json 对 agent 的写保护
 *  硬底线不受影响，暴露面与原 env 块同文件等价）。`name` = 应用名称（用户自定义展示名，1..80 trim，
 *  缺省由 UI 回退平台名）——非串/超长 warning 跳过该字段不致命（ident 同款宽容口径）。 */

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
  /** 应用名称（spec §8 2026-11-22 终形态）：用户自定义展示名，1..80，trim；缺席=UI 回退平台名 */
  name?: string;
  /** 通道密钥（2026-11-22 内联裁定）：直接存条目字段、GET /settings/channels 可回显；缺席=未配置 */
  secret?: string;
  root: string;
  mode: ChannelAccessMode;
  model?: string;
  /** 平台非密钥标识（feishu 自建应用 URL 等扩展位） */
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
    // name 宽容解析（spec §8 2026-11-22 终形态）：非串/trim 后超 80 → warning 跳过该字段不致命；
    // 缺席/空串=未命名（UI 回退平台名），照 ident 的「坏字段不毁条目」口径
    let name: string | undefined;
    const nameRaw = item['name'];
    if (nameRaw !== undefined && nameRaw !== null) {
      if (typeof nameRaw !== 'string') {
        warnings.push(`channels[${i}](${id}) name 非串，跳过该字段`);
      } else {
        const trimmed = nameRaw.trim();
        if (trimmed !== '') {
          if (trimmed.length > 80) warnings.push(`channels[${i}](${id}) name 超 80 字，跳过该字段`);
          else name = trimmed;
        }
      }
    }
    const identRaw = item['ident'];
    const ident = isRecord(identRaw)
      ? Object.fromEntries(Object.entries(identRaw).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      : undefined;
    // secret 内联解析（2026-11-22 裁定）：串即收（trim，上限 2000——密钥可长）；空串=缺席；
    // 非串/超长 warning 跳字段不致命
    let secret: string | undefined;
    const secretRaw = item['secret'];
    if (secretRaw !== undefined && secretRaw !== null) {
      if (typeof secretRaw !== 'string') {
        warnings.push(`channels[${i}](${id}) secret 非串，跳过该字段`);
      } else {
        const trimmed = secretRaw.trim();
        if (trimmed === '') {
          secret = undefined; // 空串=未配置
        } else if (trimmed.length > 2000) {
          warnings.push(`channels[${i}](${id}) secret 超 2000 字，跳过该字段`);
        } else {
          secret = trimmed;
        }
      }
    }
    value.push({
      id,
      platform: platform as ChannelPlatform,
      enabled: item['enabled'] === true,
      ...(name !== undefined ? { name } : {}),
      ...(secret !== undefined ? { secret } : {}),
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

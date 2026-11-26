/** 通道配置模型（spec 2026-11-21-channels §4 存储总览；§8 2026-11-22 终形态加 name）：settings.json `channels`
 *  结构化语义键形状裁决单点——非法条目 warning 跳过不致命（providers 键同语义）。`secret` = 通道密钥
 *  **内联进条目**（2026-11-22 用户裁定推翻 D6「设置与凭据分离」：env 分组承载密钥维护成本过高、且
 *  不可回显导致 GUI 配置不闭环——密钥随配置项存放、GET 可回显；settings.json 对 agent 的写保护
 *  硬底线不受影响，暴露面与原 env 块同文件等价）。`name` = 应用名称（用户自定义展示名，1..80 trim，
 *  缺省由 UI 回退平台名）——非串/超长 warning 跳过该字段不致命（ident 同款宽容口径）。 */
import { parseEffort } from '../../model/effort';

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
  /** 通道密钥（内联裁定,权威口径本文件头注）：直接存条目字段、GET /settings/channels 可回显；缺席=未配置 */
  secret?: string;
  root: string;
  mode: ChannelAccessMode;
  model?: string;
  /** 思考强度（2026-11-23 用户裁定「可以选择默认的模型和强度」）：子集出自 EFFORT_ORDER
   *  （parseEffort 校验）；缺席=跟随全局默认；router createOpts 透传 createSession */
  effort?: string;
  /** 平台非密钥标识（feishu 自建应用 URL 等扩展位） */
  ident?: Record<string, string>;
  /** 会话模式（2026-11-24 用户裁定「创建通道时支持选择模式:普通会话还是 Sunx」）：'sunx'=该通道
   *  各聊天建 Sunx 编排会话（品性冻结层;/new 重建仅品性复用——会话级,不跨聊天共享,全异步驱动）;
   *  缺席=普通会话（standard 路径零变化） */
  sessionKind?: 'sunx';
  /** Sunx 品性原文（sessionKind==='sunx' 时生效）：装配透传 ContextManager 品性冻结层,
   *  /new 重建沿用同一段品性;逐字保存不 trim（自撰物料纪律,同 GUI newSession 口径） */
  charter?: string;
  /** 开放的聊天命令（命令配置化裁定**权威注**——用户可配开放子集,一个下拉多选）：
   *  子集出自 CHANNEL_COMMANDS 目录；缺席=全部开放；router 门控与 /help 列举共用此目录 */
  commands?: string[];
  allow: ChannelAllowConfig;
}

/** 聊天命令目录（命令配置化）：cmd=聊天侧触发词；desc=人性化说明（/help 输出与 GUI
 *  多选下拉共用——不透露底层实现，只说作用）；match=触发匹配形态（缺省 exact 全文等值，prefix
 *  前缀命中——/new 允许携带尾注）。门控/匹配/列举共用本目录；执行动作在 router.ts 指令短路分支
 *  ——新增命令须两处同步（本目录登记 + router 分支） */
export const CHANNEL_COMMANDS: ReadonlyArray<{ cmd: string; desc: string; match?: 'exact' | 'prefix' }> = [
  { cmd: '/help', desc: '显示本帮助' },
  { cmd: '/stop', desc: '停止当前任务' },
  { cmd: '/new', desc: '开始新对话（聊天设置保留）', match: 'prefix' },
  { cmd: '/status', desc: '查看任务状态' },
  { cmd: '/workspace', desc: '查看/切换工作区（回复序号或直接发完整路径，下次新会话生效）', match: 'prefix' },
  { cmd: '/model', desc: '查看/切换模型（回复序号选择，下一条消息生效）', match: 'prefix' },
  { cmd: '/effort', desc: '查看/切换思考强度（回复序号选择，下一条消息生效）', match: 'prefix' },
  { cmd: '/compact', desc: '压缩上下文（释放窗口空间）' },
  { cmd: '/context', desc: '查看上下文构成与窗口占用' },
  { cmd: '/memory', desc: '列出持久记忆' },
  { cmd: '/memory-rm', desc: '删除记忆（/memory-rm <名称或序号>）', match: 'prefix' },
  { cmd: '/memory-gc', desc: '整理持久记忆' },
  { cmd: '/memory-on', desc: '本会话开启持久记忆' },
  { cmd: '/memory-off', desc: '本会话关闭持久记忆' },
  { cmd: '/skills-list', desc: '列出可用技能——聊天里直接描述任务即可触发匹配的技能' },
  { cmd: '/agents-list', desc: '列出可用子智能体——描述任务时点名（如「用 xx 来做…」）即可委派' },
  { cmd: '/teams-list', desc: '列出可用智能体团队——描述任务时点名团队即可按团队协作' },
];

const COMMAND_WORDS: ReadonlySet<string> = new Set(CHANNEL_COMMANDS.map((c) => c.cmd));

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
  /** 聊天名称（2026-11-24 用户裁定「hover 显示聊天名称,单聊=聊天人名称,群聊=群聊名称」）：
   *  首绑定时自入站取（chatTitle 优先,单聊回落发送者姓名），绑定元数据 /new 重绑保留同 chatKind;
   *  侧栏悬浮卡显示面（handlers 行透出） */
  chatTitle?: string;
  updatedAt: number;
}

export interface InboundMessage {
  channel: string;
  chatId: string;
  chatKind: 'direct' | 'group';
  userId: string;
  /** 发送者展示名（平台昵称），缺省回退 userId */
  userDisplay?: string;
  /** 聊天名称（2026-11-24 用户裁定「hover 显示聊天名称」）：群聊=群名（聊天信息 API）,单聊=
   *  对方名;平台尽力富化,缺席由调用方回落（单聊回落发送者姓名） */
  chatTitle?: string;
  msgId: string;
  text?: string;
  images?: string[];
  atBot?: boolean;
  raw?: unknown;
}

export interface OutboundMessage {
  text: string;
  markdown?: boolean;
  /** 定向提及（2026-11-22 用户裁定：@ 人是群聊语义，单聊回执式回复天然指向本人不加 @）——
   *  引擎按 lastSender.chatKind==='group' 注入，适配器按平台语法渲染（feishu `<at>` 标签
   *  服务端渲人名）；caps.mention!==true 的适配器由引擎退化为文本前缀 @<display> */
  mention?: { userId: string; display?: string };
}

export interface DeliveryCaps {
  streaming: boolean;
  markdown: boolean;
  card: boolean;
  maxTextLength: number;
  /** 平台原生提及支持（feishu `<at user_id>` 标签=服务端渲人名）：缺席=引擎文本前缀退化 */
  mention?: boolean;
}

/** 平台消息文本长度帽单点：feishu/telegram caps、mock 缺省档与 reply FALLBACK_CAPS 兜底同值 */
export const CHANNEL_MAX_TEXT_LENGTH = 4000;

const PLATFORMS: readonly ChannelPlatform[] = ['feishu', 'dingtalk', 'wecom', 'telegram', 'mock'];
const MODES: readonly ChannelAccessMode[] = ['read-only', 'acceptEdits', 'full-access'];
const ALLOW_KINDS: readonly AllowKind[] = ['first-user', 'list', 'all'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function bindingKey(channelId: string, chatId: string): string {
  return `${channelId}:${chatId}`;
}

/** 入站提交文本（⑫ 群聊注入单点,router 提交与 engine drain 回显匹配共用）：群聊
 *  `[来自 名字（用户id）]: ` 前缀+正文,单聊原文——run 起源移动按「提交文本===回显帧文本」回配。
 *  id 括注（2026-11-25 用户裁定「hover 显示用户 id,可复制」）：姓名解析成功时也带 id——GUI 来源行
 *  显示名字、hover 面板显示 id 并可复制；姓名缺席时退化为 `[来自 id]:`（不重复括注） */
export function inboundSubmitText(msg: InboundMessage): string {
  const body = msg.text ?? '';
  if (msg.chatKind !== 'group') return body;
  const display = msg.userDisplay ?? msg.userId;
  // 英文前缀（2026-11-25 用户裁定「'来自'应该使用英文,避免双语转换」）:模型面单语,ID 用 ASCII
  // 括号括注（姓名缺失时不重复括注）
  const at = display !== msg.userId && msg.userId !== '' ? ` (${msg.userId})` : '';
  return `[From ${display}${at}]: ${body}`;
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
    // commands 开放命令解析（命令配置化）：字符串数组，元素限目录内命令（未知 warning
    // 跳过该元素不致命）；缺席=全部开放；显式空数组=全不开放（仅自由聊天）
    let commands: string[] | undefined;
    const commandsRaw = item['commands'];
    if (commandsRaw !== undefined && commandsRaw !== null) {
      if (!Array.isArray(commandsRaw) || !commandsRaw.every((x) => typeof x === 'string')) {
        warnings.push(`channels[${i}](${id}) commands 须为字符串数组，已忽略该字段`);
      } else {
        const list: string[] = [];
        for (const raw of commandsRaw as string[]) {
          const c = raw.trim();
          if (c === '') continue;
          if (!COMMAND_WORDS.has(c)) {
            warnings.push(`channels[${i}](${id}) commands 未知命令 ${c}，已跳过`);
            continue;
          }
          if (!list.includes(c)) list.push(c);
        }
        commands = list;
      }
    }
    // secret 内联解析（内联裁定）：串即收（trim，上限 2000——密钥可长）；空串=缺席；
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
    // effort 思考强度解析（2026-11-23 用户裁定「可以选择默认的模型和强度」）：parseEffort 校验
    // （EFFORT_ORDER 子集），非法/非串 warning 跳该字段不致命；缺席=跟随全局默认
    let effort: string | undefined;
    const effortRaw = item['effort'];
    if (effortRaw !== undefined && effortRaw !== null) {
      if (typeof effortRaw !== 'string') {
        warnings.push(`channels[${i}](${id}) effort 非串，跳过该字段`);
      } else {
        const v = parseEffort(effortRaw.trim());
        if (v === undefined) warnings.push(`channels[${i}](${id}) effort 非法（${effortRaw.trim()}），跳过该字段`);
        else effort = v;
      }
    }
    // sessionKind 会话模式解析（2026-11-24 用户裁定「普通会话还是 Sunx」）：仅收 'sunx'；
    // 其他非空串 warning 跳该字段（回退普通会话）不致命；缺席/空=普通会话
    let sessionKind: 'sunx' | undefined;
    const kindRaw = item['sessionKind'];
    if (kindRaw !== undefined && kindRaw !== null) {
      if (kindRaw === 'sunx') sessionKind = 'sunx';
      else if (typeof kindRaw === 'string' && kindRaw.trim() !== '') {
        warnings.push(`channels[${i}](${id}) sessionKind 非法（${kindRaw}），按普通会话处理`);
      }
    }
    // charter 品性原文解析（sessionKind==='sunx' 消费）：串即收,逐字不 trim（自撰物料纪律）,
    // 上限 20000 字防配置膨胀;空串=未配置;非串/超长 warning 跳该字段不致命
    let charter: string | undefined;
    const charterRaw = item['charter'];
    if (charterRaw !== undefined && charterRaw !== null) {
      if (typeof charterRaw !== 'string') {
        warnings.push(`channels[${i}](${id}) charter 非串，跳过该字段`);
      } else if (charterRaw === '') {
        charter = undefined;
      } else if (charterRaw.length > 20000) {
        warnings.push(`channels[${i}](${id}) charter 超 20000 字，跳过该字段`);
      } else {
        charter = charterRaw;
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
      ...(commands !== undefined ? { commands } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(sessionKind !== undefined ? { sessionKind } : {}),
      ...(charter !== undefined ? { charter } : {}),
      allow: {
        kind: allowCfg['kind'] as AllowKind,
        ...(strArr(allowCfg['userIds']) !== undefined ? { userIds: strArr(allowCfg['userIds']) } : {}),
        ...(strArr(allowCfg['chatIds']) !== undefined ? { chatIds: strArr(allowCfg['chatIds']) } : {}),
      },
    });
  });
  return { value, warnings };
}

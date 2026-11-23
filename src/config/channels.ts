/**
 * channels 结构化语义键装载（spec 2026-11-21-channels §4 存储总览 1）：**config/providers.ts 模板**——
 * 结构化键形状裁决单点（形状解析委托 serve/channels/model.ts parseChannelsKey）、非法条目 warning 跳过
 * 不致命、不经 flatten/env 槽；叠加 **全局豁免裁定**（spec §4 存储总览 1「项目级整键忽略」）：providers
 * 键允许项目级遮蔽，channels 不行——通道是 daemon 主动外连的执行面，项目档若能定义通道，等于克隆一个
 * 仓库就能注入「外连攻击者机器人 + full-access 会话」的供应链攻击面。故本装载恒读全局档
 * （loadGlobalSettings 单点），项目档 channels 键整键忽略，无两级遮蔽语义。
 * 密钥内联进条目（内联裁定,权威口径 serve/channels/model.ts 头注）：`secret` 字段随 channels 键存放、GET 可回显，
 * env 槽 SUNSHINEX_CHANNEL_SECRET_<名> 退役（engine 改读 cfg.secret，见 serve/channels/engine.ts）。
 * 兼营聊天专属域目录铸造单点（channelChatDomainDir/channelChatWorkspaceRoot，spec §4 绑定解析
 * 「root==='auto'」缺省形态）：域容器 ~/.sunshinex/channels/ 与容器覆盖（channelsContainerDir）落
 * data-dir.ts——严格三分 projects/sunx/channels；workspace/data 平级不嵌套（用户裁定 2026-11-21）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseSettingsFile, loadGlobalSettings } from './settings';
import { parseChannelsKey } from '../serve/channels/model';
import { slugify } from '../slug';
import { channelsContainerDir } from './data-dir';
import type { ChannelConfig } from '../serve/channels/model';

/**
 * 全局档 channels 键装载（global-only 单点）：缺省读全局档（loadGlobalSettings()）；
 * 档缺失 / channels 键缺省 = 空配置、零告警（没配就是没配，不是错误——parseSettingsFile 文件缺失
 * 返回 null 口径；providers parseProvidersAll 的 undefined 短路同款）；显式错型（含 null）交
 * parseChannelsKey 产「须为数组」告警；畸形 JSON 按 providers 模板处理——settings 装载链统一
 * fail-fast 上报，此处按缺级处理不二次抛错。
 */
export function loadChannels(filePath: string = loadGlobalSettings()): { value: ChannelConfig[]; warnings: string[] } {
  let doc: ReturnType<typeof parseSettingsFile>;
  try {
    doc = parseSettingsFile(filePath);
  } catch {
    return { value: [], warnings: [] }; // 畸形 JSON 由 settings 装载链统一上报；此处按缺级处理（providers.loadProvidersFull read 同款）
  }
  if (doc === null || doc.channels === undefined) return { value: [], warnings: [] };
  return parseChannelsKey(doc.channels);
}

/**
 * 聊天专属域目录铸造（spec §4 绑定解析 root==='auto' 缺省形态）：`<channelsContainerDir()>/im-<channelSlug>-<chatSlug>`——
 * 一聊天一持久化域（与 sunx 域对称），slug 用 src/slug.ts 主链 slugify 单点规则（非拉丁字符折叠 '-'，
 * 防中文 chatId 在跨平台路径面出隐患）；max 60（对齐 projectSlug 折叠截长，防超长 chatId 撑爆路径）、
 * fallback 'chat'（全折叠空串兜底，域目录名恒合法）。mkdir 幂等（域目录本体首调即铸造，recursive 连容器
 * 一起建）；Task 5 router root 解析 / Task 9 容器扫描 / Task 13 侧栏消费本单点。
 */
export function channelChatDomainDir(channelId: string, chatId: string): string {
  const dir = path.join(
    channelsContainerDir(),
    `im-${slugify(channelId, { max: 60, fallback: 'chat' })}-${slugify(chatId, { max: 60, fallback: 'chat' })}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 聊天专属工作区根（createSession 的 root = agent 工作目录，任务文件产出落这里）：`<域>/workspace`——
 * **与 `<域>/data` 平级、不嵌套**（2026-11-21 用户裁定：full-access agent 不得踩到自己的会话账本，
 * data 分支见 data-dir.ts resolveDataDir ②′）。mkdir 幂等。
 */
export function channelChatWorkspaceRoot(channelId: string, chatId: string): string {
  const dir = path.join(channelChatDomainDir(channelId, chatId), 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

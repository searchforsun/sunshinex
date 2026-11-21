/**
 * channels 结构化语义键装载（spec 2026-11-21-channels §4 存储总览 1）：**config/providers.ts 模板**——
 * 结构化键形状裁决单点（形状解析委托 serve/channels/model.ts parseChannelsKey）、非法条目 warning 跳过
 * 不致命、不经 flatten/env 槽；叠加 **全局豁免裁定**（spec §4 存储总览 1「项目级整键忽略」）：providers
 * 键允许项目级遮蔽，channels 不行——通道是 daemon 主动外连的执行面，项目档若能定义通道，等于克隆一个
 * 仓库就能注入「外连攻击者机器人 + full-access 会话」的供应链攻击面。故本装载恒读全局档
 * （loadGlobalSettings 单点），项目档 channels 键整键忽略，无两级遮蔽语义。
 * 密钥不进本键（D6 用户裁决「设置与凭据分离」延续）：键内零密钥字段，每通道按名取
 * SUNSHINEX_CHANNEL_SECRET_<大写通道名> env 槽（channelSecretEnv 派生，规则同 providers.ts
 * providerApiKeyEnv），settings env 块或真实环境变量皆可。
 */
import { parseSettingsFile, loadGlobalSettings } from './settings';
import { parseChannelsKey, channelSecretEnv } from '../serve/channels/model';
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
 * 通道密钥解析（D6）：查 process.env[channelSecretEnv(id)]——settings env 块装载后落 process.env，
 * 真实环境变量同槽；空串视同未配置（providers resolveProviderApiKey 同纪律）。
 * 缺失 = 未配置，由调用方裁定该通道拒绝启用（fail-closed，spec §4 存储总览 2）。
 */
export function resolveChannelSecret(id: string): string | undefined {
  const value = process.env[channelSecretEnv(id)];
  return value !== undefined && value !== '' ? value : undefined;
}

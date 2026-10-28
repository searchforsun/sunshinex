/**
 * catalog/providers 读面：settings.json providers 键（多源多模型清单）的两级装载视图。
 * §15 providers 归一化的数据基座：缺省模型 = 首源首模型（choices[0]，choices 序 = providers 序 ×
 * models 序即默认序）、tier 标注供档位路由消费。两视图一次装载：providers=源级分组（ProviderEntry，
 * 文件结构镜像 + 密钥在场标注）、choices=展平生效值（ModelChoice，条目级 > 源级缺省）。
 * 两级整键遮蔽与形状裁决一律复用 config/providers 装载单点（loadProvidersFull），本模块零解析逻辑——
 * 密钥永不回传值，只标 apiKeyEnv 槽名与 apiKeyPresent 在场布尔（GET /settings providers 面先例）。
 */
import { loadProvidersFull, providerApiKeyEnv, resolveProviderApiKey } from '../config/providers';
import type { ModelChoice, ParsedProviderEntry } from '../config/providers';

/** 单个源条目：config 解析面的源级分组（name/baseUrl/源级显式字段/models 条目显式值）+ 密钥面 */
export interface ProviderEntry extends ParsedProviderEntry {
  /** 该源专用密钥槽名（SUNSHINEX_API_KEY_<大写源名>） */
  apiKeyEnv: string;
  /** 专用槽或主槽 SUNSHINEX_API_KEY 任一有值 = true（resolveProviderApiKey 判存，值不回传） */
  apiKeyPresent: boolean;
}

/** providers 读面：root:null 仅全局（loadProvidersFull 同语义）；providers 与 choices 同源同序，
 *  warnings 为装载告警单（形状裁决逐条跳过/忽略的告知面） */
export function listProviders(root: string | null): { providers: ProviderEntry[]; choices: ModelChoice[]; warnings: string[] } {
  const full = loadProvidersFull(root);
  return {
    providers: full.providers.map((g) => ({
      ...g,
      apiKeyEnv: providerApiKeyEnv(g.name),
      apiKeyPresent: resolveProviderApiKey(g.name) !== undefined,
    })),
    choices: full.choices,
    warnings: full.warnings,
  };
}

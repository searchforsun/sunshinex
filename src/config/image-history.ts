/**
 * imageHistoryLimit 结构化语义键解析单点（spec §3.2 settings 承诺接线；computer-use README 同键承诺）：
 * - 两级 settings（全局 + 项目，项目遮蔽全局——与 plugins 语义键同裁定）取 imageHistoryLimit 原值，
 *   合法域为整数 0-50（0 = 全部剥图，合法边界）；非法值告警 + 回缺省，不 fail-fast——渲染半径是
 *   上下文预算旋钮非安全面，坏值不值得让会话装配失败（容错纪律：宁可缺省不可错配）；
 * - 沿 plugins/permissions 先例：settings.ts 只直通原值（SettingsDoc.imageHistoryLimit?: unknown），
 *   形状裁决在消费处（本文件），不经 flatten/env 槽；
 * - settingsReader 注入整个 settings 文档对象（null = 该级缺档）沿 loadEffectivePlugins 先例，测试免真写 HOME；
 *   畸形 JSON 不在此兜（permissions 同款：由 settings 装载链统一上报，此处按缺级处理）。
 */
import { parseSettingsFile, loadProjectSettings, loadGlobalSettings } from './settings';

/** 渲染半径缺省值：链序上仅最近 3 个带图行保图（buildMessages 同缺省，spec §3.2） */
export const DEFAULT_IMAGE_HISTORY_LIMIT = 3;

export interface ImageHistoryResolution {
  /** 生效半径（buildMessages 第二参透传值） */
  value: number;
  /** 形状非法告警（点名级别与键名；selfcheck 上屏） */
  warnings: string[];
}

/**
 * 两级解析：global 在前、project 在后，后读的合法值覆盖前值（项目遮蔽全局）；
 * 某级形状非法 → 告警并跳过该级（保留前级合法值，两级皆缺/皆非法 → 缺省 3）。
 */
export function resolveImageHistoryLimit(
  projectRoot: string | undefined,
  opts: { settingsReader?: (scope: 'global' | 'project') => Record<string, unknown> | null } = {},
): ImageHistoryResolution {
  const warnings: string[] = [];
  const read = (scope: 'global' | 'project'): unknown => {
    // 注入面（Record）与生产面（SettingsDoc）结构兼容取键：只消费 imageHistoryLimit 原值
    let doc: { imageHistoryLimit?: unknown } | null;
    try {
      doc = opts.settingsReader !== undefined ? opts.settingsReader(scope)
        : scope === 'global' ? parseSettingsFile(loadGlobalSettings())
          : projectRoot === undefined ? null : parseSettingsFile(loadProjectSettings(projectRoot));
    } catch {
      doc = null; // 畸形 JSON 由 settings 装载链统一上报；此处按缺级处理（permissions readLevel 同款）
    }
    return doc === null ? undefined : doc.imageHistoryLimit;
  };
  const legal = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 50;
  let value = DEFAULT_IMAGE_HISTORY_LIMIT;
  for (const scope of ['global', 'project'] as const) {
    const raw = read(scope);
    if (raw === undefined) continue;
    if (legal(raw)) value = raw;
    else warnings.push(`settings.${scope} imageHistoryLimit 须为 0-50 整数，收到 ${typeof raw === 'object' ? JSON.stringify(raw) : String(raw)}，已忽略该值`);
  }
  return { value, warnings };
}

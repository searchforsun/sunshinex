/**
 * catalog/plugins：插件两级清单视图 + 启用态/配置结构化写单点（设置页与 CLI 后续同源消费）。
 * 裁定史：2026-10-27 曾裁定插件启用态收应用级（项目级 plugins 语义键停用），2026-10-28 裁定反转——
 * 恢复两级 per-id 语义（项目记录遮蔽全局记录，记录级整面替换；合并面单点 config/plugins.loadEffectivePlugins，
 * 其 settingsReader 注入面同日改为按 scope 双询问）。本模块是合并读面的配套读写面：
 * - 读 = listPlugins：loadEffectivePlugins 薄包装（root=null 仅全局装载；零增值字段先不做）；
 * - 写 = setPluginEnabled/setPluginConfig：目标 scope 的 settings.json plugins.<id> 记录读改写，
 *   记录内另一字段保留（开关写保 config、config 写保 enabled）——与 handlePluginsPut「记录级整面替换」
 *   不同：catalog 面按字段手术（CLI/设置页增量写场景，不丢用户手写的另一半）。
 * 写纪律沿 catalog/approvals（Task 3）同款：
 * - 读原文（readJsoncDoc）→ 改 doc → writeJsonAtomic 原子写回；盘上形态 2-space + 尾随换行，新档补 version:1；
 * - 目标文件含 JSONC 注释 → CatalogWriteError('COMMENTS')（结构化整写会毁注释，Task 15 映射 409 引流 raw 编辑面）；
 * - 畸形 JSON/根非对象 → CatalogWriteError('INVALID')（结构化写不越权覆盖既有内容）；
 * - id 定位（listPlugins）在文件守卫之后（与 handlePluginsPut 同序：定位面真读两级 settings，先收口
 *   目标文件现状再定位）；未知 id → CatalogWriteError('INVALID')——无装载态的 id 无从写语义键；
 * - 零变化不落盘（同值重写零盘上副作用）；plugins 键形状坏 → 整键重置（装载面告警忽略坏形状，不保留垃圾）；
 * - 定位面对他级 settings 畸形 fail-fast 抛错沿装载链同纪律不在此兜（静默降级会演变成「配置没生效」的排查泥潭）。
 */
import { loadEffectivePlugins, type EffectivePlugin } from '../config/plugins';
import { loadGlobalSettings, loadProjectSettings } from '../config/settings';
import type { Scope } from './types';
import { CatalogWriteError, readJsoncDoc, writeJsonAtomic } from './io';

/** 两级清单（loadEffectivePlugins 薄包装）：plugins + 装载聚合警告单；root=null 仅全局装载（无项目锚） */
export function listPlugins(root: string | null): { plugins: EffectivePlugin[]; warnings: string[] } {
  return loadEffectivePlugins(root ?? undefined);
}

/** 目标 scope 的 settings.json 落位：project=<root>/.sunshinex/settings.json（root 缺省回退 cwd，
 *  与 mcpJsonPath 无项目上下文口径一致）；global=<userConfigDir>/settings.json */
function settingsPath(scope: Scope, root: string | null): string {
  return scope === 'global' ? loadGlobalSettings() : loadProjectSettings(root ?? process.cwd());
}

/** plugins.<id> 记录形状裁决：{enabled?, config?} 浅对象；形状坏按无记录处理（装载面告警忽略坏记录，写面重建） */
const recordOf = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * 写面公共体：目标 scope settings plugins.<id> 记录读改写，patch 由既有记录（形状坏按空记录）
 * 产出整条新记录（enabled/config 两字段互不覆写，记录内其余键原样透传）。纪律见模块头
 * （COMMENTS/INVALID 拒写、未知 id 拒写、原子写、零变化不落盘）。
 */
function updatePluginRecord(
  root: string | null,
  scope: Scope,
  id: string,
  patch: (prev: Record<string, unknown>) => Record<string, unknown>,
): void {
  const file = settingsPath(scope, root);
  const read = readJsoncDoc(file);
  if (read.hasComments) {
    throw new CatalogWriteError('COMMENTS', `${file} 含 JSONC 注释，结构化写会毁注释；请经 raw 编辑面移除注释后重试`);
  }
  if (read.exists && read.warnings.length > 0) {
    // 畸形 JSON/根非对象：readJsoncDoc 降级为空 doc，照写等于毁掉用户既有内容——拒写引流修文件
    throw new CatalogWriteError('INVALID', read.warnings[0]!);
  }
  // id 定位（文件守卫后——见模块头）：无装载态的 id 无从写语义键（与 handlePluginsPut 404 同源判据）
  if (!listPlugins(root).plugins.some((p) => p.manifest.id === id)) {
    throw new CatalogWriteError('INVALID', `plugin not found: ${id}`);
  }
  const doc = read.doc;
  const pluginsMap = recordOf(doc['plugins']) ?? {}; // 既有键形状坏 → 整键重置（装载面告警忽略坏形状，写面不保留垃圾）
  doc['plugins'] = pluginsMap;
  const prev = recordOf(pluginsMap[id]);
  const record = patch(prev ?? {});
  if (prev === undefined || JSON.stringify(prev) !== JSON.stringify(record)) {
    pluginsMap[id] = record;
    if (!read.exists && doc['version'] === undefined) doc['version'] = 1; // 新档补 version:1（settings schema 口径，approvals 同款）
    writeJsonAtomic(file, JSON.stringify(doc, null, 2) + '\n');
  }
}

/** 置插件启用态（写目标 scope settings plugins.<id>.enabled，保留该记录既有 config 与其余键） */
export function setPluginEnabled(root: string | null, scope: Scope, id: string, enabled: boolean): void {
  updatePluginRecord(root, scope, id, (prev) => ({ ...prev, enabled }));
}

/** 置插件 config（写目标 scope settings plugins.<id>.config，保留该记录既有 enabled 与其余键） */
export function setPluginConfig(root: string | null, scope: Scope, id: string, config: Record<string, unknown>): void {
  updatePluginRecord(root, scope, id, (prev) => ({ ...prev, config }));
}

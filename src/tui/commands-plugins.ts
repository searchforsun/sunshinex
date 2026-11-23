import { listPlugins, setPluginEnabled } from '../catalog/plugins';
import type { EffectivePlugin } from '../config/plugins';
import { t } from '../i18n';
import { idleGuard, readListing, runCatalogWriteTui } from './commands-common';
import type { SessionController } from './session';

// Task 20（Phase E）拆分件：/plugins 命令族函数体（commands-model/commands-mcp 先例——handleSlash 骨架
// 只留分发）。读写全走 catalog 单点（listPlugins/setPluginEnabled），TUI 零自管盘上形态；TUI 不做表单
// （缺省裁定）：config 编辑/安装引导 CLI（sunshinex plugins ...），面板只承载清单 + 启停。

/** 生效条目定位单点：listPlugins 装载序内置先用户后、同 id 用户级整体覆盖（视图已合并去重），按 id 直取 */
function effectiveEntry(plugins: EffectivePlugin[], id: string): EffectivePlugin | undefined {
  return plugins.find((p) => p.manifest.id === id);
}

/** 列表卡行（无参清单与带参回执重绘共用单点）：id/启停状态点/来源段（builtin/user）/平台可用性 + name·description */
function pluginRow(p: EffectivePlugin): string {
  const state = p.enabled ? 'on' : 'off';
  const platform = p.platformSupported ? '' : ` · ${t('platform unsupported', '平台不可用')}`;
  return `- ${p.manifest.id} ${state} (${p.source})${platform} — ${p.manifest.name}: ${p.manifest.description}`;
}

/** 读面/写面遏制与 idle 守卫走 commands-common 单点（D87：原本文件手写两件退役）；名词注入 */
const NOUN = { en: 'Plugin', zh: '插件' };

/** 列表卡（无参查看态 + 带参执行后重绘态共用）：两级清单 + 装配告警 + 用法行 */
function pluginsListing(ctrl: SessionController): void {
  const listing = readListing(ctrl, NOUN, () => listPlugins(ctrl.root));
  if (listing === undefined) return; // 读面遏制已出错误行
  const { plugins, warnings } = listing;
  const lines = [t(`Plugins (${plugins.length}):`, `插件（${plugins.length} 个）：`)];
  if (plugins.length === 0) {
    lines.push(t('No plugins installed.', '未安装插件。'));
  }
  for (const p of plugins) lines.push(pluginRow(p));
  for (const w of warnings) lines.push(t(`warning: ${w}`, `警告：${w}`));
  lines.push(t('Usage: /plugins enable|disable <id>', '用法：/plugins enable|disable <id>'));
  ctrl.pushMsg('system', lines.join('\n'));
}

/** /plugins [enable|disable <id>]：无参两级清单卡；带参启停写项目 settings plugins.<id>.enabled
 *  （catalog 单点保该记录既有 config 不丢；生效态两级合并——记录级整面替换由装载面承载）。
 *  TUI 无 --scope 旗标，写锚恒项目 settings（CLI 缺省 project 同口径）。 */
export function pluginsPanel(ctrl: SessionController, rest: string): void {
  if (!idleGuard(ctrl, 'plugins')) return;
  if (rest === '') return pluginsListing(ctrl);
  const parts = rest.split(/\s+/);
  const action = parts[0]!;
  const id = parts[1] ?? '';
  if ((action !== 'enable' && action !== 'disable') || id === '' || parts.length !== 2) {
    ctrl.pushMsg('system', t('Usage: /plugins enable|disable <id>', '用法：/plugins enable|disable <id>'), { level: 'warn' });
    return;
  }
  // 读面一次 + 就地定位（同一遏制单点）：读失败 warn 已出即短路，不落写、不误报 not-found
  const listing = readListing(ctrl, NOUN, () => listPlugins(ctrl.root));
  if (listing === undefined) return;
  const plugin = effectiveEntry(listing.plugins, id);
  if (plugin === undefined) {
    ctrl.pushMsg('system', t(`Plugin not found: ${id}`, `找不到插件：${id}`), { level: 'warn' });
    return;
  }
  const enabled = action === 'enable';
  const ok = runCatalogWriteTui(ctrl, NOUN, () => setPluginEnabled(ctrl.root, 'project', id, enabled));
  if (!ok) return;
  ctrl.pushMsg('system', t(
    `ok: plugin ${id} ${enabled ? 'enabled' : 'disabled'} (project); takes effect on next assembly`,
    `ok：插件 ${id} 已${enabled ? '启用' : '停用'}（项目）；下次装配生效`,
  ));
  pluginsListing(ctrl);
}

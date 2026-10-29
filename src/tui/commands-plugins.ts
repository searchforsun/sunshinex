import { listPlugins, setPluginEnabled } from '../catalog/plugins';
import type { EffectivePlugin } from '../config/plugins';
import { CatalogWriteError } from '../catalog/io';
import { t } from '../i18n';
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

/** 读面遏制单点（T20 评审修补）：loadEffectivePlugins 对畸形 settings fail-fast 抛错（settingsReader →
 *  parseSettingsFile 装载链同纪律），而 submit 是 fire-and-forget——handleSlash 拒绝即未处理拒绝杀进程。
 *  面板「不抛死会话」契约读面与写面同履：统一 try/catch → warn 错误行（与写面错误行同形状），
 *  undefined = 已出错误行，调用方短路后续定位/写路径 */
function readListing<T>(ctrl: SessionController, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    ctrl.pushMsg('system', t(
      `Plugin listing failed: ${e instanceof Error ? e.message : String(e)}`,
      `插件清单读取失败：${e instanceof Error ? e.message : String(e)}`,
    ), { level: 'warn' });
    return undefined;
  }
}

/** 列表卡（无参查看态 + 带参执行后重绘态共用）：两级清单 + 装配告警 + 用法行 */
function pluginsListing(ctrl: SessionController): void {
  const listing = readListing(ctrl, () => listPlugins(ctrl.root));
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
  if (ctrl.state.status !== 'idle') {
    ctrl.pushMsg('system', t('A task is running; /plugins unavailable now', '当前有任务进行中，暂不能执行 /plugins'), { level: 'warn' });
    return;
  }
  if (rest === '') return pluginsListing(ctrl);
  const parts = rest.split(/\s+/);
  const action = parts[0]!;
  const id = parts[1] ?? '';
  if ((action !== 'enable' && action !== 'disable') || id === '' || parts.length !== 2) {
    ctrl.pushMsg('system', t('Usage: /plugins enable|disable <id>', '用法：/plugins enable|disable <id>'), { level: 'warn' });
    return;
  }
  // 读面一次 + 就地定位（同一遏制单点）：读失败 warn 已出即短路，不落写、不误报 not-found
  const listing = readListing(ctrl, () => listPlugins(ctrl.root));
  if (listing === undefined) return;
  const plugin = effectiveEntry(listing.plugins, id);
  if (plugin === undefined) {
    ctrl.pushMsg('system', t(`Plugin not found: ${id}`, `找不到插件：${id}`), { level: 'warn' });
    return;
  }
  const enabled = action === 'enable';
  try {
    setPluginEnabled(ctrl.root, 'project', id, enabled);
  } catch (e) {
    ctrl.pushMsg('system', e instanceof CatalogWriteError ? t(`${e.code}: ${e.message}`, `${e.code}：${e.message}`) : t(
      `Plugin write failed: ${e instanceof Error ? e.message : String(e)}`,
      `插件写入失败：${e instanceof Error ? e.message : String(e)}`,
    ), { level: 'error' });
    return;
  }
  ctrl.pushMsg('system', t(
    `ok: plugin ${id} ${enabled ? 'enabled' : 'disabled'} (project); takes effect on next assembly`,
    `ok：插件 ${id} 已${enabled ? '启用' : '停用'}（项目）；下次装配生效`,
  ));
  pluginsListing(ctrl);
}

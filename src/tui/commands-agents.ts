import { listAgents, setAgentEnabled } from '../catalog/agents';
import type { AgentEntry } from '../catalog/agents';
import { CatalogWriteError } from '../catalog/io';
import { t } from '../i18n';
import type { SessionController } from './session';

// Task 20（Phase E）拆分件：/agents 命令族函数体（commands-model/commands-mcp 先例——handleSlash 骨架
// 只留分发）。读写全走 catalog 单点（listAgents/setAgentEnabled），TUI 零自管盘上形态；TUI 不做表单
// （缺省裁定）：增删/正文编辑引导 CLI（sunshinex agents ...），面板只承载清单 + 启停。

/** 生效条目定位单点：entries 排布 global → 项目新家（catalog 视图口径），倒序取首个同 id =
 *  装载面就近生效条目 */
function effectiveEntry(entries: AgentEntry[], id: string): AgentEntry | undefined {
  return entries.slice().reverse().find((e) => e.id === id);
}

/** 列表卡行（无参清单与带参回执重绘共用单点）：id/scope/启停状态点/来源标注（被遮蔽）+ name·description */
function agentRow(e: AgentEntry): string {
  const state = e.meta.enabled ? 'on' : 'off';
  const origin = e.shadowed ? ` · ${t('shadowed', '被遮蔽')}` : '';
  return `- ${e.id} [${e.scope}] ${state}${origin} — ${e.meta.name}: ${e.meta.description}`;
}

/** 读面遏制单点（T20 评审修补）：列表面与写面同契约（「不抛死会话」）——catalog 读面失败
 *  （目录竞态不可读等）统一 try/catch → warn 错误行（与写面错误行同形状），不抛死会话
 *  （submit 是 fire-and-forget，handleSlash 拒绝即未处理拒绝杀进程） */
function readListing<T>(ctrl: SessionController, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    ctrl.pushMsg('system', t(
      `Subagent listing failed: ${e instanceof Error ? e.message : String(e)}`,
      `子智能体清单读取失败：${e instanceof Error ? e.message : String(e)}`,
    ), { level: 'warn' });
    return undefined;
  }
}

/** 列表卡（无参查看态 + 带参执行后重绘态共用）：两级位置清单 + 装配告警 + 用法行 */
function agentsListing(ctrl: SessionController): void {
  const listing = readListing(ctrl, () => listAgents(ctrl.root));
  if (listing === undefined) return; // 读面遏制已出错误行
  const lines = [t(`Subagents (${listing.entries.length}):`, `子智能体（${listing.entries.length} 个）：`)];
  if (listing.entries.length === 0) {
    lines.push(t(
      'No subagents defined — project .sunshinex/agents/<id>/agent.md or global ~/.sunshinex/agents/<id>/agent.md; add via: sunshinex agents add',
      '未定义子智能体——项目 .sunshinex/agents/<id>/agent.md 或全局 ~/.sunshinex/agents/<id>/agent.md；新增经：sunshinex agents add',
    ));
  }
  for (const e of listing.entries) lines.push(agentRow(e));
  for (const w of listing.warnings) lines.push(t(`warning: ${w}`, `警告：${w}`));
  lines.push(t('Usage: /agents enable|disable <id>', '用法：/agents enable|disable <id>'));
  ctrl.pushMsg('system', lines.join('\n'));
}

/** catalog 写面收口：CatalogWriteError → 错误行（消息面，不抛死会话），成功 true */
function runAgentWrite(ctrl: SessionController, fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (e) {
    ctrl.pushMsg('system', e instanceof CatalogWriteError ? t(`${e.code}: ${e.message}`, `${e.code}：${e.message}`) : t(
      `Agent write failed: ${e instanceof Error ? e.message : String(e)}`,
      `子智能体写入失败：${e instanceof Error ? e.message : String(e)}`,
    ), { level: 'error' });
    return false;
  }
}

/** /agents [enable|disable <id>]：无参两级位置列表卡；带参启停写条目所在作用域 agent.md enabled 行（就地手术）。 */
export function agentsPanel(ctrl: SessionController, rest: string): void {
  if (ctrl.state.status !== 'idle') {
    ctrl.pushMsg('system', t('A task is running; /agents unavailable now', '当前有任务进行中，暂不能执行 /agents'), { level: 'warn' });
    return;
  }
  if (rest === '') return agentsListing(ctrl);
  const parts = rest.split(/\s+/);
  const action = parts[0]!;
  const id = parts[1] ?? '';
  if ((action !== 'enable' && action !== 'disable') || id === '' || parts.length !== 2) {
    ctrl.pushMsg('system', t('Usage: /agents enable|disable <id>', '用法：/agents enable|disable <id>'), { level: 'warn' });
    return;
  }
  // 读面一次 + 就地定位（同一遏制单点）：读失败 warn 已出即短路，不落写、不误报 not-found
  const listing = readListing(ctrl, () => listAgents(ctrl.root));
  if (listing === undefined) return;
  const entry = effectiveEntry(listing.entries, id);
  if (entry === undefined) {
    ctrl.pushMsg('system', t(`Subagent not found: ${id}`, `找不到子智能体：${id}`), { level: 'warn' });
    return;
  }
  const enabled = action === 'enable';
  const scope = entry.scope;
  const ok = runAgentWrite(ctrl, () => setAgentEnabled(ctrl.root, scope, id, enabled));
  if (!ok) return;
  ctrl.pushMsg('system', t(
    `ok: subagent ${id} ${enabled ? 'enabled' : 'disabled'} (${scope}); takes effect on next assembly`,
    `ok：子智能体 ${id} 已${enabled ? '启用' : '停用'}（${scope}）；下次装配生效`,
  ));
  agentsListing(ctrl);
}

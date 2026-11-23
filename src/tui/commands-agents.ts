import { listAgents, setAgentEnabled } from '../catalog/agents';
import type { AgentEntry } from '../catalog/agents';
import { t } from '../i18n';
import { idleGuard, readListing, runCatalogWriteTui } from './commands-common';
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

/** 读面/写面遏制与 idle 守卫走 commands-common 单点（D87：原本文件手写三件退役）；名词注入 */
const NOUN = { en: 'Subagent', zh: '子智能体' };

/** 列表卡（无参查看态 + 带参执行后重绘态共用）：两级位置清单 + 装配告警 + 用法行 */
function agentsListing(ctrl: SessionController): void {
  const listing = readListing(ctrl, NOUN, () => listAgents(ctrl.root));
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
  // agents-teams P1（Task 5）：$ 软引用点名用法提示（与 /teams 的 #<team-id> 用法行对偶——
  // spec §3.2「发起不设斜杠命令：$id 任务点名、#id 目标拉队，直打即达」）
  lines.push(t('Usage: name a single agent in your message as $<agent-id>', '用法：在消息中以 $<agent-id> 点名单个智能体'));
  ctrl.pushMsg('system', lines.join('\n'));
}

/** /agents [enable|disable <id>]：无参两级位置列表卡；带参启停写条目所在作用域 agent.md enabled 行（就地手术）。 */
export function agentsPanel(ctrl: SessionController, rest: string): void {
  if (!idleGuard(ctrl, 'agents')) return;
  if (rest === '') return agentsListing(ctrl);
  const parts = rest.split(/\s+/);
  const action = parts[0]!;
  const id = parts[1] ?? '';
  if ((action !== 'enable' && action !== 'disable') || id === '' || parts.length !== 2) {
    ctrl.pushMsg('system', t('Usage: /agents enable|disable <id>', '用法：/agents enable|disable <id>'), { level: 'warn' });
    return;
  }
  // 读面一次 + 就地定位（同一遏制单点）：读失败 warn 已出即短路，不落写、不误报 not-found
  const listing = readListing(ctrl, NOUN, () => listAgents(ctrl.root));
  if (listing === undefined) return;
  const entry = effectiveEntry(listing.entries, id);
  if (entry === undefined) {
    ctrl.pushMsg('system', t(`Subagent not found: ${id}`, `找不到子智能体：${id}`), { level: 'warn' });
    return;
  }
  const enabled = action === 'enable';
  const scope = entry.scope;
  const ok = runCatalogWriteTui(ctrl, NOUN, () => setAgentEnabled(ctrl.root, scope, id, enabled));
  if (!ok) return;
  ctrl.pushMsg('system', t(
    `ok: subagent ${id} ${enabled ? 'enabled' : 'disabled'} (${scope}); takes effect on next assembly`,
    `ok：子智能体 ${id} 已${enabled ? '启用' : '停用'}（${scope}）；下次装配生效`,
  ));
  agentsListing(ctrl);
}

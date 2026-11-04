import { listTeams } from '../catalog/teams';
import type { TeamEntry } from '../catalog/teams';
import { listAgentDefs } from '../harness/subagent';
import { t } from '../i18n';
import type { SessionController } from './session';

// agents-teams P1（Task 5）拆分件：/teams 命令族函数体 + $/# 未知引用提示（commands-agents/
// commands-mcp 先例——handleSlash 骨架只留分发）。读走 catalog 单点（listTeams），TUI 零自管盘上
// 形态；面板只读（spec §6.3 写引导 GUI/CLI——TUI 不做表单惯例）：带参一律回写引导行，不执行任何写。
// 未知引用提示（spec §3.2 TUI 面，GUI ref-palette unknownRefTokens 同语义同词法）：普通文本派发前
// 只读对照在册集合，未命中聚合一条普通 system 行（R6：无 warn 级），原文照发不拦截不改写。

/** 列表卡行（无参清单共用单点，镜像 agentRow）：id/来源/启停状态点/遮蔽标注 + name·description + 成员清单 */
function teamRow(e: TeamEntry): string {
  const state = e.enabled ? 'on' : 'off';
  const origin = e.shadowedBy ? ` · ${t('shadowed', '被遮蔽')}` : '';
  return `- ${e.id} [${e.source}] ${state}${origin} — ${e.name}: ${e.description} (${t('members', '成员')}: ${e.members.join(', ')})`;
}

/** 读面遏制单点（镜像 commands-agents readListing）：catalog 读面失败（目录竞态不可读等）统一
 *  try/catch → warn 错误行（与写面错误行同形状），不抛死会话（submit 是 fire-and-forget，
 *  handleSlash 拒绝即未处理拒绝杀进程） */
function readListing<T>(ctrl: SessionController, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    ctrl.pushMsg('system', t(
      `Teams listing failed: ${e instanceof Error ? e.message : String(e)}`,
      `团队清单读取失败：${e instanceof Error ? e.message : String(e)}`,
    ), { level: 'warn' });
    return undefined;
  }
}

/** 列表卡（无参查看态）：两级位置清单（global → project，项目遮蔽全局标 shadowed）+ missing 成员
 *  警示行 + 装配告警 + 用法行 */
function teamsListing(ctrl: SessionController): void {
  const listing = readListing(ctrl, () => listTeams(ctrl.root));
  if (listing === undefined) return; // 读面遏制已出错误行
  const lines = [t(`Teams (${listing.entries.length}):`, `团队（${listing.entries.length} 个）：`)];
  if (listing.entries.length === 0) {
    lines.push(t(
      'No teams defined — project .sunshinex/teams/<id>/team.md or global ~/.sunshinex/teams/<id>/team.md; manage via GUI settings (Agent Teams)',
      '未定义团队——项目 .sunshinex/teams/<id>/team.md 或全局 ~/.sunshinex/teams/<id>/team.md；管理经 GUI 设置（Agent Teams）',
    ));
  }
  for (const e of listing.entries) {
    lines.push(teamRow(e));
    if (e.missing.length > 0) {
      lines.push(t(`  ⚠ missing agents: ${e.missing.join(', ')}`, `  ⚠ 缺失智能体：${e.missing.join(', ')}`));
    }
  }
  for (const w of listing.warnings) lines.push(t(`warning: ${w}`, `警告：${w}`));
  lines.push(t(
    'Usage: reference a team in your message as #<team-id> — manage in GUI settings (Agent Teams)',
    '用法：在消息中以 #<team-id> 引用团队——管理经 GUI 设置（Agent Teams）',
  ));
  ctrl.pushMsg('system', lines.join('\n'));
}

/** /teams：无参两级清单卡（只读）；带参一律回写引导行——spec §6.3：TUI 不做写表单，编辑在 GUI
 *  设置（Agent Teams）/CLI catalog API，面板零写盘（与 /providers 只读惯例同款）。 */
export function teamsPanel(ctrl: SessionController, rest: string): void {
  if (ctrl.state.status !== 'idle') {
    ctrl.pushMsg('system', t('A task is running; /teams unavailable now', '当前有任务进行中，暂不能执行 /teams'), { level: 'warn' });
    return;
  }
  if (rest === '') return teamsListing(ctrl);
  ctrl.pushMsg('system', t(
    'Team edits live in the GUI settings (Agent Teams) / CLI catalog API — TUI panel is read-only',
    '团队编辑在 GUI 设置（Agent Teams）/ CLI catalog API——TUI 面板只读',
  ));
}

/**
 * 未知 $/# 引用聚合提示（spec §3.2 TUI 面；GUI ref-palette R5 同语义）：普通文本派发入口（submit
 * 纯文本路径 + G14.95 未知斜杠词落点 + 排队行真正发送时刻）在 runTaskFlow 前调用本函数。只读对照
 * 在册集合 = harness listAgentDefs ids（内建四角色 + 两级磁盘，现读——团队成员引用的注册表口径）
 * ∪ catalog listTeams entry ids；未命中 token（GUI unknownRefTokens 同词法：(^|\s) 起手 + 小写
 * 首字符，a$b / PATH=$PATH / #L30 / #Title 天然不命中）去重保序聚合一条普通 system 行（R6），
 * 原文照发不拦截不改写。两读面各自 try/catch——任一读失败整个检查跳过（fail-soft：读面失败时
 * 照检会让每条含 $/# 消息吃到假「未匹配」提示，GUI Chat.tsx 评审 2026-11-04 同裁定）；无候选
 * token 快速门零读盘（词法必要条件先行，纯文本发送零开销）。
 */
export function pushUnknownRefHint(ctrl: SessionController, text: string): void {
  if (!/(^|\s)[#$][a-z]/.test(text)) return; // 快速门：无候选 token 不读盘
  const ids = new Set<string>();
  try {
    for (const a of listAgentDefs(ctrl.root)) ids.add(a.id);
  } catch {
    return; // agents 读面失败 → 跳过整个提示（fail-soft，不误报）
  }
  try {
    for (const e of listTeams(ctrl.root).entries) ids.add(e.id);
  } catch {
    return; // teams 读面失败 → 同上
  }
  const unknown: string[] = [];
  for (const m of text.matchAll(/(^|\s)([$#][a-z][a-z0-9-]*)/g)) {
    const tok = m[2] ?? '';
    if (ids.has(tok.slice(1))) continue; // 在册（符号不敏感与 GUI 同：id 集合并集对照）
    if (!unknown.includes(tok)) unknown.push(tok); // 同 token 去重保序
  }
  if (unknown.length === 0) return;
  const list = unknown.join(' ');
  ctrl.pushMsg('system', t(
    `No registered match for ${list} — sent as-is (see /agents, /teams)`,
    `${list} 未匹配到在册条目——已按原文发送（/agents /teams 查看在册）`,
  ));
}

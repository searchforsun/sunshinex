import { listMcpServers, setMcpServerEnabled } from '../catalog/mcp';
import type { McpServerEntry } from '../catalog/mcp';
import { approveMcpServer, denyMcpServer } from '../catalog/approvals';
import { CatalogWriteError } from '../catalog/io';
import { t } from '../i18n';
import type { SessionController } from './session';

// Task 20（Phase E）拆分件：/mcp 命令族函数体（commands-model/D52 commands-* 先例——handleSlash 骨架
// 只留分发）。读写全走 catalog 单点（listMcpServers/setMcpServerEnabled/approveMcpServer/denyMcpServer），
// TUI 零自管盘上形态；TUI 不做表单（缺省裁定）：add/remove/端点编辑引导 CLI（sunshinex mcp ...），
// 面板只承载清单 + 启停 + 项目批准阀三件高频操作。

/** 生效条目定位单点：entries 排布 global 前 project 后、同名项目遮蔽全局（catalog 视图口径），
 *  倒序取首个同名 = 装载面就近生效条目（CLI test 子命令同款裁定）；shadowed 条目定位到的是其生效同名份 */
function effectiveEntry(entries: McpServerEntry[], name: string): McpServerEntry | undefined {
  return entries.slice().reverse().find((e) => e.name === name);
}

/** 列表卡行（无参清单与带参回执重绘共用单点）：名称/scope/启停状态点/遮蔽标注/审批态；
 *  pending 附待确认徽标 + approve 指引（项目条目未审不装载——安全阀可见性），全局条目恒 none 不标注 */
function mcpRow(e: McpServerEntry): string {
  const state = e.server.enabled === false ? 'off' : 'on';
  const shadowed = e.shadowed ? ` · ${t('shadowed', '被遮蔽')}` : '';
  const approval = e.approval === 'none'
    ? ''
    : e.approval === 'pending'
      ? ` · ${t('approval: pending (awaiting approval — /mcp approve ' + e.name + ')', '审批：待确认（/mcp approve ' + e.name + ' 批准后装载）')}`
      : ` · ${t('approval: ' + e.approval, '审批：' + (e.approval === 'approved' ? '已批准' : '已拒绝'))}`;
  return `- ${e.name} [${e.scope}] ${state}${shadowed}${approval}`;
}

/** 读面遏制单点（T20 评审修补）：catalog 列举读面对畸形 settings fail-fast throw（approvalState →
 *  parseSettingsFile 与装载链同纪律），而 submit 是 fire-and-forget（use-line-edit void 无 await）——
 *  handleSlash 拒绝即未处理拒绝杀进程。面板「不抛死会话」契约读面与写面同履：统一 try/catch →
 *  warn 错误行（与写面错误行同形状），undefined = 已出错误行，调用方短路后续定位/写路径 */
function readListing<T>(ctrl: SessionController, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    ctrl.pushMsg('system', t(
      `MCP listing failed: ${e instanceof Error ? e.message : String(e)}`,
      `MCP 清单读取失败：${e instanceof Error ? e.message : String(e)}`,
    ), { level: 'warn' });
    return undefined;
  }
}

/** 列表卡（无参查看态 + 带参执行后重绘态共用）：两级清单（global 先 project 后）+ 装配告警 + 用法行 */
function mcpListing(ctrl: SessionController): void {
  const listing = readListing(ctrl, () => listMcpServers(ctrl.root));
  if (listing === undefined) return; // 读面遏制已出错误行
  const lines = [t(`MCP servers (${listing.entries.length}):`, `MCP 服务器（${listing.entries.length} 台）：`)];
  if (listing.entries.length === 0) {
    lines.push(t(
      'No servers configured — global ~/.sunshinex/mcp.json or project .sunshinex/mcp.json (see MANUAL); add via: sunshinex mcp add',
      '未配置服务器——全局 ~/.sunshinex/mcp.json 或项目 .sunshinex/mcp.json（见 MANUAL）；新增经：sunshinex mcp add',
    ));
  }
  for (const e of listing.entries) lines.push(mcpRow(e));
  for (const w of listing.warnings) lines.push(t(`warning: ${w}`, `警告：${w}`));
  lines.push(t('Usage: /mcp enable|disable|approve|deny <name>', '用法：/mcp enable|disable|approve|deny <名称>'));
  ctrl.pushMsg('system', lines.join('\n'));
}

/** catalog 写面收口：CatalogWriteError（COMMENTS/INVALID）→ 错误行（消息面，不抛死会话），成功 true */
function runMcpWrite(ctrl: SessionController, fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (e) {
    ctrl.pushMsg('system', e instanceof CatalogWriteError ? t(`${e.code}: ${e.message}`, `${e.code}：${e.message}`) : t(
      `MCP write failed: ${e instanceof Error ? e.message : String(e)}`,
      `MCP 写入失败：${e instanceof Error ? e.message : String(e)}`,
    ), { level: 'error' });
    return false;
  }
}

/**
 * /mcp [enable|disable|approve|deny <name>]：无参两级列表卡；带参执行后回显结果行并重绘列表。
 * 启停写条目所在作用域 mcp.json（就地手术——列表即事实源）；approve/deny 是项目级批准阀
 * （写全局 settings mcpApprovals/mcpDenied，全局条目不适用——恒不过阀）。
 */
export function mcpPanel(ctrl: SessionController, rest: string): void {
  if (ctrl.state.status !== 'idle') {
    ctrl.pushMsg('system', t('A task is running; /mcp unavailable now', '当前有任务进行中，暂不能执行 /mcp'), { level: 'warn' });
    return;
  }
  if (rest === '') return mcpListing(ctrl);
  const parts = rest.split(/\s+/);
  const action = parts[0]!;
  const name = parts[1] ?? '';
  if ((action !== 'approve' && action !== 'deny' && action !== 'enable' && action !== 'disable') || name === '' || parts.length !== 2) {
    ctrl.pushMsg('system', t('Usage: /mcp enable|disable|approve|deny <name>', '用法：/mcp enable|disable|approve|deny <名称>'), { level: 'warn' });
    return;
  }
  // 读面一次 + 就地定位（同一遏制单点）：读失败 warn 已出即短路，不落写、不误报 not-found
  const listing = readListing(ctrl, () => listMcpServers(ctrl.root));
  if (listing === undefined) return;
  const entry = effectiveEntry(listing.entries, name);
  if (entry === undefined) {
    ctrl.pushMsg('system', t(`MCP server not found: ${name}`, `找不到 mcp server：${name}`), { level: 'warn' });
    return;
  }
  if (action === 'approve' || action === 'deny') {
    // 批准阀按项目根 slug 记账（approveMcpServer root 必传）；全局条目恒不过阀（用户手配非仓库供给）
    if (entry.scope !== 'project') {
      ctrl.pushMsg('system', t(
        `Approval applies to project-scope servers only; ${name} is global (user-configured, loads without the gate)`,
        `批准阀只适用项目作用域；${name} 是全局条目（用户手配，装载不过阀）`,
      ), { level: 'warn' });
      return;
    }
    const ok = runMcpWrite(ctrl, () => (action === 'approve' ? approveMcpServer(ctrl.root, name) : denyMcpServer(ctrl.root, name)));
    if (!ok) return;
    ctrl.pushMsg('system', t(
      `ok: mcp server ${name} ${action}d for project; takes effect on next assembly`,
      `ok：mcp server ${name} 已${action === 'approve' ? '批准' : '拒绝'}（项目）；下次装配生效`,
    ));
    return mcpListing(ctrl);
  }
  const enabled = action === 'enable';
  const scope = entry.scope;
  const ok = runMcpWrite(ctrl, () => setMcpServerEnabled(ctrl.root, scope, name, enabled));
  if (!ok) return;
  ctrl.pushMsg('system', t(
    `ok: mcp server ${name} ${enabled ? 'enabled' : 'disabled'} (${scope}); takes effect on next assembly`,
    `ok：mcp server ${name} 已${enabled ? '启用' : '停用'}（${scope}）；下次装配生效`,
  ));
  mcpListing(ctrl);
}

/**
 * 项目 MCP 未批准提示（TUI 启动装配后 push 一行，非阻塞——entry.ts 控制器创建后调用）：
 * 项目 mcp.json 有 approval=pending 条目时提示待确认数量与 /mcp 入口；零 pending 静默（零噪声）。
 * 启动路径单独遏制（T20 评审修补）：读面失败降级 console.warn 诊断面——提示面绝不炸启动（不走
 * pushMsg：App 未挂载，诊断归 stderr 外观通道，与 entry.ts providers warnings 透出同面）。
 */
export function pushPendingMcpHint(ctrl: SessionController): void {
  let pending: McpServerEntry[];
  try {
    pending = listMcpServers(ctrl.root).entries.filter((e) => e.scope === 'project' && e.approval === 'pending');
  } catch (e) {
    console.warn(t(
      `pending MCP hint skipped (project MCP listing failed): ${e instanceof Error ? e.message : String(e)}`,
      `跳过项目 MCP 未批准提示（清单读取失败）：${e instanceof Error ? e.message : String(e)}`,
    ));
    return;
  }
  if (pending.length === 0) return;
  const names = pending.map((e) => e.name).join(', ');
  ctrl.pushMsg('system', t(
    `Project MCP has ${pending.length} server(s) awaiting approval (${names}) — /mcp to review; unapproved servers stay unloaded`,
    `项目 MCP 有 ${pending.length} 个待确认服务器（${names}）——/mcp 查看；未批准不装载`,
  ), { level: 'warn' });
}

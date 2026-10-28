/**
 * catalog/approvals：项目级 MCP 服务器批准阀（安全闸读写单点）。
 * 为什么是阀：项目 mcp.json 随仓库分发（<root>/.sunshinex/mcp.json 可由仓库自带），未审先启等于
 * 仓库供给方拿到了本机命令执行权——项目级条目必须经用户批准（approve）或拒绝（deny）后才能进入装载口径。
 * - 状态面 approvalState：只读全局 settings 的 mcpApprovals/mcpDenied 两键（结构化键透传见 settings.SettingsDoc），
 *   键 = projectSlug(root)（按工作区绝对路径隔离，复用 data-dir 单点不另造折叠规则）；
 *   判定序 approved > denied > pending（两键同记以批准为准——该状态经写面互斥维护不可及，仅手改文件可及）；
 *   缺文件/无记录/键形状非法一律 pending（宁拦勿放）。读走 parseSettingsFile 既有口径（注释与 BOM 容忍，
 *   畸形 JSON fail-fast——与装载链同一纪律，静默降级会让「配置没生效」演变成排查泥潭）。
 * - 写面 approve/deny：读原文（readJsoncDoc）→ 改 doc → writeJsonAtomic 原子写回；盘上形态与 daemon
 *   结构化写同款（2-space + 尾随换行；新档补 version:1）。写纪律：
 *   含 JSONC 注释 → CatalogWriteError('COMMENTS')（结构化整写会毁注释，Task 15 映射 409 引流 raw 编辑面）；
 *   畸形 JSON/根非对象 → CatalogWriteError('INVALID')（结构化写不越权覆盖既有内容）；
 *   两键互斥维护：记入一侧同时对向除名（批准/拒绝互为终态，同名不共存两键；对向键形状坏不动——读面宽容）。
 * - 全局级条目不过本阀：全局 mcp.json 在 userConfigDir（用户手配，非仓库供给），恒 'none' 由调用面（catalog/mcp）保证。
 */
import { readJsoncDoc, writeJsonAtomic, CatalogWriteError } from './io';
import { loadGlobalSettings, parseSettingsFile } from '../config/settings';
import { projectSlug } from '../config/data-dir';

/**
 * 项目 MCP 审批态：approved=已批准（可自动装载）；denied=已拒绝；pending=待审（缺记录/缺文件/形状非法）。
 */
export function approvalState(root: string, name: string): 'approved' | 'pending' | 'denied' {
  const doc = parseSettingsFile(loadGlobalSettings()); // 缺文件 → null → pending；畸形 settings fail-fast（装载链同纪律）
  if (doc === null) return 'pending';
  const slug = projectSlug(root);
  if (listHas(doc.mcpApprovals, slug, name)) return 'approved';
  if (listHas(doc.mcpDenied, slug, name)) return 'denied';
  return 'pending';
}

/** mcpApprovals/mcpDenied 槽形状裁决：{ [slug]: 名单数组 }；section 非对象/slug 槽非数组按未记录处理（读面宽容） */
function listHas(section: unknown, slug: string, name: string): boolean {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return false;
  const list = (section as Record<string, unknown>)[slug];
  return Array.isArray(list) && list.includes(name);
}

/** 批准项目 MCP 服务器：记入全局 settings mcpApprovals.<slug>，同时对 mcpDenied.<slug> 除名 */
export function approveMcpServer(root: string, name: string): void {
  setApproval(root, name, 'mcpApprovals', 'mcpDenied');
}

/** 拒绝项目 MCP 服务器：记入全局 settings mcpDenied.<slug>，同时对 mcpApprovals.<slug> 除名 */
export function denyMcpServer(root: string, name: string): void {
  setApproval(root, name, 'mcpDenied', 'mcpApprovals');
}

/**
 * 写面公共体：目标槽记入 name（幂等，已记不重写）+ 对向槽除名；零变化不落盘（无盘上副作用）。
 * 纪律见模块头（COMMENTS/INVALID 两类拒写；原子写；daemon 结构化写同款盘上形态）。
 */
function setApproval(
  root: string,
  name: string,
  key: 'mcpApprovals' | 'mcpDenied',
  opposite: 'mcpApprovals' | 'mcpDenied',
): void {
  const file = loadGlobalSettings();
  const read = readJsoncDoc(file);
  if (read.hasComments) {
    throw new CatalogWriteError('COMMENTS', `${file} 含 JSONC 注释，结构化写会毁注释；请经 raw 编辑面移除注释后重试`);
  }
  if (read.exists && read.warnings.length > 0) {
    // 畸形 JSON/根非对象：readJsoncDoc 降级为空 doc，照写等于毁掉用户既有内容——拒写引流修文件
    throw new CatalogWriteError('INVALID', read.warnings[0]!);
  }
  const doc = read.doc;
  const slug = projectSlug(root);
  let changed = false;
  // 目标槽：section 形状坏 → 整键重置（daemon plugins 键同款先例）；slug 槽非数组 → 该槽重置为 [name]
  let section = doc[key];
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    section = {};
    doc[key] = section;
    changed = true;
  }
  const sec = section as Record<string, unknown>;
  const cur = sec[slug];
  if (!Array.isArray(cur)) {
    sec[slug] = [name];
    changed = true;
  } else if (!cur.includes(name)) {
    sec[slug] = [...cur, name];
    changed = true;
  }
  // 对向槽除名（互斥维护）：对向 section 形状坏不动（读面按未记录处理，写了无害）；仅滤名单数组
  const oppSection = doc[opposite];
  if (typeof oppSection === 'object' && oppSection !== null && !Array.isArray(oppSection)) {
    const opp = oppSection as Record<string, unknown>;
    const oppList = opp[slug];
    if (Array.isArray(oppList) && oppList.includes(name)) {
      opp[slug] = oppList.filter((v) => v !== name);
      changed = true;
    }
  }
  if (!changed) return;
  if (!read.exists && doc['version'] === undefined) doc['version'] = 1; // 新档补 version:1（settings schema 口径，daemon T2/T4 同款）
  writeJsonAtomic(file, JSON.stringify(doc, null, 2) + '\n');
}

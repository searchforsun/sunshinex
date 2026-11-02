/**
 * catalog/permissions（Task 16）：settings.json permissions 键（deny/allow/additionalDirs 三字符串
 * 数组）的两级读视图 + 结构化写单点——/settings/permissions/op 端点（后续 CLI/GUI 同源）的数据基座。
 * - 读面 listPermissions：沿 GET /settings 现形状 {merged, project, global}——merged=全局在前项目在后
 *   拼接去重（config/permissions loadPermissions 同口径合并不遮蔽：项目级不得解除全局 deny）、
 *   project/global 分立、root:null 仅全局（project 面恒空——不伪造 cwd 相对读取，providers 读面先例）。
 *   单级解析复用 config/permissions readLevel 装载单点（本模块零解析逻辑）；坏形状告警跳过（读面宽容）。
 * - 写面 addPermission/removePermission：settings permissions 键对应数组的手术写，纪律沿
 *   catalog/providers（Task 10）/catalog/approvals（Task 3）同款：
 *   · 读原文（readJsoncDoc）→ 改 doc → writeJsonAtomic 原子写回；盘上形态 2-space + 尾随换行，新档补 version:1；
 *   · 目标文件含 JSONC 注释 → CatalogWriteError('COMMENTS')，先于一切内容守卫（value 非法等——守卫
 *     序与 providers 同：先文件位置（project root:null → INVALID），再文件可写性（COMMENTS），后内容）；
 *     COMMENTS 经 Task 15 映射 409 引流 raw 编辑面；
 *   · 畸形 JSON/根非对象 → CatalogWriteError('INVALID')（readJsoncDoc 降级为空 doc，照写等于毁掉用户
 *     既有内容——结构化写不越权覆盖）；
 *   · value 归一：trim 后须非空字符串，否则 INVALID（HTTP 面非字符串由 handler 400 拦，库面防御同拒）；
 *     定位/dedup 对既有条目按 trim 对齐比对（文件里手写未 trim 的条目照样可定位——providers
 *     entryIndexByName 同款），落盘存 trim 后形态；
 *   · add 去重幂等（同值在场零落盘）、remove 缺失 → INVALID（严格语义非幂等——幂等收口属调用面裁量）；
 *     permissions 键形状坏（非对象）→ add 路径整键重置、remove 路径 INVALID（plugins 键先例：装载面
 *     告警忽略坏形状，写面不保留垃圾；remove 无从在坏键中定位，拒写优于静默重置）；
 *   · project 作用域 root:null → INVALID（agentWriteTarget/providerWriteTarget 先例：写面绝不借道 cwd）；
 *   · 写后 notifyCatalogWrite('settings', scope, root)——**resource 恒 'settings'**：写的是 settings.json
 *     物理文件，watcher 对该文件两 scope 均映射 'settings'（watch.mapFilename），notify 三元与 watcher
 *     映射不同构则回声去重失效自触双发（io.ts 钩子注释口径）；approvals 先例：全局写
 *     ('settings','global',null)。'permissions' 无独立物理文件，不经 notify 通道（ResourceKind 预留位）。
 *   · 全部返回 void、零打印。
 */
import { readLevel } from '../config/permissions';
import { t } from '../i18n';
import type { PermissionsConfig } from '../config/permissions';
import { loadGlobalSettings, loadProjectSettings } from '../config/settings';
import type { Scope } from './types';
import { CatalogWriteError, finishCatalogWrite, readWritableDoc, requireProjectRoot, settingsPathOf } from './io';

/** 空 permissions 面（坏形/缺级/缺键统一缺省形态，与 config/permissions EMPTY 同构） */
const EMPTY: PermissionsConfig = { deny: [], allow: [], additionalDirs: [] };

/** permissions 读面：root:null 仅全局（project 面恒空）；warnings=两级形状告警单（坏键/坏槽点名） */
export interface PermissionsView {
  merged: PermissionsConfig;
  project: PermissionsConfig;
  global: PermissionsConfig;
  warnings: string[];
}

export function listPermissions(root: string | null): PermissionsView {
  const warnings: string[] = [];
  const globalPerms = readLevel(loadGlobalSettings(), warnings);
  const projectPerms = root === null ? EMPTY : readLevel(loadProjectSettings(root), warnings);
  return {
    merged: {
      deny: [...new Set([...globalPerms.deny, ...projectPerms.deny])],
      allow: [...new Set([...globalPerms.allow, ...projectPerms.allow])],
      additionalDirs: [...new Set([...globalPerms.additionalDirs, ...projectPerms.additionalDirs])],
    },
    project: projectPerms,
    global: globalPerms,
    warnings,
  };
}

/** 三清单名（settings permissions 键下的数组槽位） */
export type PermissionList = 'deny' | 'allow' | 'additionalDirs';

/** 写面目标文件落位 + project root 必备守卫（providers providerWriteFile 同款）：project 写落位 =
 *  装载读位（loadProjectSettings/loadGlobalSettings 单点） */
function permissionWriteFile(root: string | null, scope: Scope): string {
  return settingsPathOf(scope, requireProjectRoot(scope, root, 'permissions'));
}

/** doc 的 permissions 对象取面：键形状坏（非对象）→ 整键重置（plugins/providers 键同款先例）。
 *  仅改内存 doc，拒写路径不落盘零盘上副作用 */
function permissionsRecordOf(doc: Record<string, unknown>): Record<string, unknown> {
  const cur = doc['permissions'];
  if (typeof cur === 'object' && cur !== null && !Array.isArray(cur)) return cur as Record<string, unknown>;
  const fresh: Record<string, unknown> = {};
  doc['permissions'] = fresh;
  return fresh;
}

/** 写面公共体（add/remove 同门）：value 归一 + 目标数组手术 + 零变化不落盘 + 原子写 + 写通知。
 *  mode='add'：去重幂等（trim 对齐比对）；mode='remove'：缺失（值缺/槽缺/键缺/键形状坏）→ INVALID */
function mutatePermission(root: string | null, scope: Scope, list: PermissionList, value: string, mode: 'add' | 'remove'): void {
  const file = permissionWriteFile(root, scope); // 文件落位守卫在先——但让位目标文件的 COMMENTS（下一守卫）
  // COMMENTS/畸形守卫公共体单点（io readWritableDoc，D60）——COMMENTS 先于一切内容守卫：value 非法等让位
  const read = readWritableDoc(file);
  const rule = typeof value === 'string' ? value.trim() : '';
  if (rule === '') {
    throw new CatalogWriteError('INVALID', t(`permissions.${list} value must be a non-empty string`, `permissions.${list} value 须为非空字符串`));
  }
  const doc = read.doc;
  const perms = permissionsRecordOf(doc);
  const cur = perms[list];
  if (mode === 'remove') {
    // remove：只在「字符串数组且含目标」时手术——槽缺失/形状坏/值不在一律 INVALID（严格语义非幂等；
    // 对形状坏键的 add 才做整键重置，remove 拒写优于静默重置——用户坏数据不被写面顺手清掉）
    if (!Array.isArray(cur) || !cur.some((v) => typeof v === 'string' && v.trim() === rule)) {
      throw new CatalogWriteError('INVALID', t(`permissions.${list} rule not found: ${rule}`, `permissions.${list} 规则不存在: ${rule}`));
    }
    perms[list] = (cur as string[]).filter((v) => !(typeof v === 'string' && v.trim() === rule));
  } else {
    // add：槽缺失/形状坏 → 该槽重置后落值；trim 对齐去重（同值在场零落盘）
    if (Array.isArray(cur) && cur.some((v) => typeof v === 'string' && v.trim() === rule)) return; // 零变化不落盘
    perms[list] = [...(Array.isArray(cur) ? (cur as string[]) : []), rule];
  }
  // 写通知：该 scope settings.json 物理文件 → ('settings', scope, root)（resource 恒 'settings' 与 watcher
  // 映射同构，'permissions' 不经本通道）——收口公共体单点（D60）
  finishCatalogWrite(file, doc, read.exists, { resource: 'settings', scope, root });
}

/** 追加一条规则到指定 scope settings 的 permissions.<list>：去重幂等（同值 trim 对齐在场零落盘） */
export function addPermission(root: string | null, scope: Scope, list: PermissionList, value: string): void {
  mutatePermission(root, scope, list, value, 'add');
}

/** 摘除一条规则：值不在/槽缺失/permissions 键缺失或形状坏 → INVALID（严格语义，幂等收口属调用面裁量） */
export function removePermission(root: string | null, scope: Scope, list: PermissionList, value: string): void {
  mutatePermission(root, scope, list, value, 'remove');
}

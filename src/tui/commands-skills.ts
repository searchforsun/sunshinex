import { SLASH_COMMANDS } from './slash-commands';
import { readSkillUsage } from './skill-usage';
import type { SessionController } from './session';

// D52 拆分件②（D17 commands-* 族先例）：命令面技能清单族——skillCommandIds 注册表与 skillMenuEntries
// 纵向面板源，共用过滤单点防两清单漂移。SessionController 保留同名公开薄委托（调用面零变化）。

/** 技能命令注册表（规格 2026-09-22-skill-as-command D6 单点）：list() 现读磁盘（学习沉淀即时可见）；
 *  按 D2 字符集过滤、D1 内置词排除（内置优先——撞名技能不注册，仅可经 /skill 卡加载），id 字典序 */
export function skillCommandIdsOn(ctrl: SessionController): string[] {
  return skillManifestsForCommandsOn(ctrl).map((m) => m.id).sort();
}

/** 命令面技能清单共用过滤（D1/D2 单点）：字符集合法 + 撞名内置词排除；skillCommandIds 与
 *  skillMenuEntries 同源消费，防两清单漂移 */
function skillManifestsForCommandsOn(ctrl: SessionController) {
  const builtin = new Set(SLASH_COMMANDS.map((c) => c.slice(1)));
  return ctrl.runtime.harness.skills.list().filter((m) => /^[a-z0-9][a-z0-9_-]*$/.test(m.id) && !builtin.has(m.id));
}

/** 纵向命令面板技能源（2026-09-30 对标 CC）：清单口径与 skillCommandIds 同源，附 name/description
 *  与最近使用时间——最近使用在前（用户裁决「skills 默认显示最近常用的」）、平局回落数字典序；
 *  调用方（App）挂载 + 回合边界刷新，不逐键读盘 */
export function skillMenuEntriesOn(ctrl: SessionController): { id: string; name: string; description: string; lastUsedAt?: number }[] {
  const usage = readSkillUsage(ctrl.root);
  return skillManifestsForCommandsOn(ctrl)
    .map((m) => ({ id: m.id, name: m.name, description: m.description, lastUsedAt: usage[m.id] }))
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

import { SLASH_COMMANDS } from './slash-commands';
import { readSkillUsage } from '../catalog/skill-usage';
import { listSkills } from '../catalog/skills';
import type { SkillSource } from '../catalog/skills';
import type { SessionController } from './session';

// D52 拆分件②（D17 commands-* 族先例）：命令面技能清单族——skillCommandIds 注册表与 skillMenuEntries
// 纵向面板源，共用过滤单点防两清单漂移。SessionController 保留同名公开薄委托（调用面零变化）。

/** 技能命令注册表（规格 2026-09-22-skill-as-command D6 单点）：list() 现读磁盘（学习沉淀即时可见）；
 *  按 D2 字符集过滤、D1 内置词排除（内置优先——撞名技能不注册，仅可经 /skill 卡加载），id 字典序 */
export function skillCommandIdsOn(ctrl: SessionController): string[] {
  return skillManifestsForCommandsOn(ctrl).map((m) => m.id).sort();
}

/** 命令面技能清单共用过滤（D1/D2 单点）：字符集合法 + 撞名内置词排除；skillCommandIds 与
 *  skillMenuEntries 同源消费，防两清单漂移。
 *  读面降级（T20 评审修补）：skills.list() 经插件根收集触达 parseSettingsFile（畸形全局 settings
 *  fail-fast throw），而 handleSlash 的裸形式守卫对每条斜杠输入都调本面——不遏制即「一次坏保存后
 *  敲任何斜杠命令都杀会话」（submit fire-and-forget，拒绝即未处理拒绝）。本面只服务「哪些裸命令词
 *  是技能」的匹配判定，读不到就当无技能命令（宁少配不错配，Listing D7 同向）；真实装载/提示词
 *  装配链的 fail-fast 纪律不在此改 */
function skillManifestsForCommandsOn(ctrl: SessionController) {
  const builtin = new Set(SLASH_COMMANDS.map((c) => c.slice(1)));
  try {
    return ctrl.runtime.harness.skills.list().filter((m) => /^[a-z0-9][a-z0-9_-]*$/.test(m.id) && !builtin.has(m.id));
  } catch {
    return [];
  }
}

/** 纵向命令面板技能源（2026-09-30 对标 CC）：清单口径与 skillCommandIds 同源，附 name/description、
 *  最近使用时间与来源/遮蔽标注（Task 20 轻改：catalog 只读视图 listSkills 按 id 补 source/shadowedBy
 *  ——同 id 跨来源遮蔽在面板可见；catalog 视图缺条目（解析口径差异）时缺省无标注，仅展示面损失）——
 *  最近使用在前（用户裁决「skills 默认显示最近常用的」）、平局回落数字典序；
 *  调用方（App）挂载 + 回合边界刷新，不逐键读盘 */
export function skillMenuEntriesOn(ctrl: SessionController): { id: string; name: string; description: string; lastUsedAt?: number; source?: SkillSource; shadowedBy?: SkillSource }[] {
  const usage = readSkillUsage(ctrl.root);
  // 视图读面降级（T20 评审修补）：listSkills 经插件根收集触达 parseSettingsFile（畸形 settings throw）
  // ——本面是渲染层菜单数据源，读失败只损失来源/遮蔽标注（空映射），不拖垮菜单（App 有 RenderBoundary
  // 兜底，但整帧降级为错误行不如菜单照常、仅无标注）
  let catalogById = new Map<string, { source: SkillSource; shadowedBy?: SkillSource }>();
  try {
    catalogById = new Map(listSkills(ctrl.root).entries.map((e) => [e.id, { source: e.source, ...(e.shadowedBy !== undefined ? { shadowedBy: e.shadowedBy } : {}) }]));
  } catch { /* 视图读不到：无标注渲染 */ }
  return skillManifestsForCommandsOn(ctrl)
    .map((m) => {
      const c = catalogById.get(m.id);
      return {
        id: m.id,
        name: m.name,
        description: m.description,
        lastUsedAt: usage[m.id],
        ...(c !== undefined ? { source: c.source, ...(c.shadowedBy !== undefined ? { shadowedBy: c.shadowedBy } : {}) } : {}),
      };
    })
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

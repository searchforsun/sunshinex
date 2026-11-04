import { readSkillUsage } from '../catalog/skill-usage';
import { listSkills } from '../catalog/skills';
import type { SkillSource } from '../catalog/skills';
import type { SessionController } from './session';

// D52 拆分件②（D17 commands-* 族先例）：技能视图读面——skillMenuEntries 纵向面板源。skills 硬载退役
// （spec 2026-11-04 §4.1）后命令面仅剩 /skill 插入卡，skillCommandIds 注册表与撞名内置词排除随之退役，
// 本件收敛为纯视图读面（pool 保留为插入辅助：补全与 /skill 卡数据源同源防漂移）。

/** 纵向命令面板技能源过滤（D2 字符集单点）：字符集合法者入池；读面降级（T20 评审修补）：
 *  skills.list() 经插件根收集触达 parseSettingsFile（畸形全局 settings fail-fast throw），而本面是
 *  渲染层菜单数据源，读失败当无技能（宁少配不错配，Listing D7 同向）；真实装载/提示词装配链的
 *  fail-fast 纪律不在此改 */
function skillManifestsForMenuOn(ctrl: SessionController) {
  try {
    return ctrl.runtime.harness.skills.list().filter((m) => /^[a-z0-9][a-z0-9_-]*$/.test(m.id));
  } catch {
    return []; // 视图读面降级（T20 同款：宁少配不错配）
  }
}

/** 纵向命令面板技能源（2026-09-30 对标 CC）：附 name/description、最近使用时间与来源/遮蔽标注
 *  （Task 20 轻改：catalog 只读视图 listSkills 按 id 补 source/shadowedBy——同 id 跨来源遮蔽在面板可见；
 *  catalog 视图缺条目（解析口径差异）时缺省无标注，仅展示面损失）——
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
  return skillManifestsForMenuOn(ctrl)
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

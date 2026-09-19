/**
 * 运行时数据目录解析（单一权威）：账本/记忆/学习技能/KB 落盘的统一定位面。
 * 形态对标 Claude Code（~/.claude/projects/<项目>/，数据不进工作区）：
 * - ① SUNSHINEX_DATA_DIR 显式覆盖（整目录直指；测试与多实例场景用）
 * - ② <projects 根>/<工作区 slug>/data —— 缺省全局形态，按工作区（项目绝对路径）隔离；
 *      projects 根自身可由 SUNSHINEX_PROJECTS_DIR 指定（大容量盘/外置盘/多盘分置），缺省 userConfigDir()/projects
 * - ③ <root>/.data —— 缺省 projects 根不可建（沙箱/只读家目录）时回退旧形态，零破坏兜底
 * 显式来源（①②）不探测可写性、不回退：用户显式指定的位置即权威，配错要在使用点以真实路径报出来，
 * 不能静默落到别处；只有缺省形态（②的缺省值）才做一次 mkdirSync 探测以决定是否走 ③。
 * 不做模块级缓存——测试与多实例可用 HOME / SUNSHINEX_DATA_DIR / SUNSHINEX_PROJECTS_DIR 自由重定向，无跨用例状态。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { userConfigDir } from './env';

/** 工作区 slug：绝对路径确定性折叠（非安全字符 → '-'，截长 60）+ 8 位摘要尾巴防撞名与超长 */
export function projectSlug(root: string): string {
  const abs = path.resolve(root);
  const base = abs
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  const digest = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 8);
  return `${base.length > 0 ? base : 'project'}-${digest}`;
}

/** 项目数据根（各工作区的数据目录都落在它的下一级）：SUNSHINEX_PROJECTS_DIR 覆盖 > 缺省 userConfigDir()/projects。
 *  覆盖不限于家目录——可指向任意盘（如 D:\sunshinex-projects），逐项目 slug 隔离与冲突防撞语义不变 */
export function projectsRoot(): string {
  const override = process.env.SUNSHINEX_PROJECTS_DIR;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  return path.join(userConfigDir(), 'projects');
}

/** 解析当前工作区数据目录：直指覆盖 > projects 根覆盖 > 缺省全局（HOME 可建）> 项目内回退；子目录由各写入面自行 mkdir */
export function resolveDataDir(root: string): string {
  const override = process.env.SUNSHINEX_DATA_DIR;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  const base = projectsRoot();
  const projectsOverride = process.env.SUNSHINEX_PROJECTS_DIR;
  // 显式指定 projects 根即权威：不探测、不回退（回退会掩盖「指了 D 盘却写在 C 盘」的配置错误）
  if (projectsOverride !== undefined && projectsOverride.length > 0) return path.join(base, projectSlug(root), 'data');
  try {
    fs.mkdirSync(base, { recursive: true });
    return path.join(base, projectSlug(root), 'data');
  } catch {
    return path.join(root, '.data');
  }
}

/**
 * 数据目录真实路径（存在段逐级 realpathSync 归一、新建段字面拼接、异常按字面兜底）：
 * 记忆判界（安全链写窄口）与记忆写入接缝共用本单点——两处各持一份拷贝时，一旦策略漂移，
 * 接缝判类会返回 null → 'pass' → 裸写绕过校验闸门（失效方向 fail-open），故必须共用。
 * 惰性求值（不缓存）：测试可运行期重定向 SUNSHINEX_DATA_DIR / HOME。
 */
export function dataDirReal(root: string): string {
  const dir = resolveDataDir(root);
  try {
    let anchor = dir;
    while (anchor.length > 1 && !fs.existsSync(anchor)) anchor = path.dirname(anchor);
    return fs.realpathSync(anchor) + dir.slice(anchor.length);
  } catch {
    return dir;
  }
}

/** 全局用户技能根（三级技能目录规格 §3）：缺省 ~/.sunshinex/skills，SUNSHINEX_USER_SKILLS_DIR 显式覆盖（测试与多实例）。
 *  人手工放置的技能资产定位，不走 resolveDataDir（学习根按工作区隔离，语义不同）；不 mkdir、不做模块级缓存——技能根缺失是常态，装载面靠 existsSync 容忍 */
export function userSkillsDir(): string {
  const override = process.env.SUNSHINEX_USER_SKILLS_DIR;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  return path.join(userConfigDir(), 'skills');
}

/**
 * 运行时数据目录解析（单一权威）：账本/记忆/学习技能/KB 落盘的统一定位面。
 * 形态对标 Claude Code（~/.claude/projects/<项目>/，数据不进工作区）：
 * - ① SUNSHINEX_DATA_DIR 显式覆盖（整目录直指；测试与多实例场景用）
 * - ② ~/.sunshinex/projects/<工作区 slug>/data —— 缺省全局形态，按工作区（项目绝对路径）隔离
 * - ③ <root>/.data —— HOME 不可写（沙箱/只读家目录）时回退旧形态，零破坏兜底
 * 解析含一次 mkdirSync 幂等探测（把全局基目录建出来），不做模块级缓存——
 * 测试可用 HOME / SUNSHINEX_DATA_DIR 自由重定向，无跨用例状态。
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

/** 解析当前工作区数据目录：覆盖 > 全局（HOME 可写）> 项目内回退；子目录由各写入面自行 mkdir */
export function resolveDataDir(root: string): string {
  const override = process.env.SUNSHINEX_DATA_DIR;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  const globalBase = userConfigDir();
  try {
    fs.mkdirSync(globalBase, { recursive: true });
    return path.join(globalBase, 'projects', projectSlug(root), 'data');
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

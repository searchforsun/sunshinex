/**
 * 运行时数据目录解析（单一权威）：账本/记忆/学习技能/KB 落盘的统一定位面。
 * 形态对标 Claude Code（~/.claude/projects/<项目>/，数据不进工作区）：
 * - ① SUNSHINEX_DATA_DIR 显式覆盖（整目录直指；**开发与测试专用**重定向口——测试钉数据目录、
 *      CI 隔离运行时数据；已从 settings.json 语义键表退役——留在用户配置面会诱导跨项目共用一份记忆与账本）
 * - ② <projects 根>/<工作区 slug>/data —— 缺省全局形态，按工作区（项目绝对路径）隔离；
 *      projects 根自身可由 SUNSHINEX_PROJECTS_DIR 指定（大容量盘/外置盘/多盘分置），缺省 userConfigDir()/projects
 * - ③ <root>/.data —— 缺省 projects 根不可建（沙箱/只读家目录）时回退旧形态，零破坏兜底
 * 显式来源（①②）不探测可写性、不回退：用户显式指定的位置即权威，配错要在使用点以真实路径报出来，
 * 不能静默落到别处；只有缺省形态（②的缺省值）才做一次 mkdirSync 探测以决定是否走 ③。
 * 不做模块级缓存——开发与测试可用 HOME / SUNSHINEX_DATA_DIR / SUNSHINEX_PROJECTS_DIR 自由重定向，无跨用例状态。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { userConfigDir } from './env';

/** 工作区 slug：绝对路径确定性折叠（非安全字符 → '-'，截长 60）+ 12 位摘要尾巴防撞名与超长。
 *  2026-10-23 用户裁定：项目 id 不做旧档兼容（8→12 位，老工作区目录整删重注册即可） */
export function projectSlug(root: string): string {
  const abs = path.resolve(root);
  const base = abs
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  const digest = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 12);
  return `${base.length > 0 ? base : 'project'}-${digest}`;
}

/** 项目数据根（各工作区的数据目录都落在它的下一级）：SUNSHINEX_PROJECTS_DIR 覆盖 > 缺省 userConfigDir()/projects。
 *  覆盖不限于家目录——可指向任意盘（如 D:\sunshinex-projects），逐项目 slug 隔离与冲突防撞语义不变 */
export function projectsRoot(): string {
  const override = process.env.SUNSHINEX_PROJECTS_DIR;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  return path.join(userConfigDir(), 'projects');
}

/** 会话级团队/任务板根：`<dataDir>/teams/<journalId>/`（注册表、板事件、inbox 同会话隔离；不跨会话）。 */
export function sessionTeamsRoot(dataDir: string, journalId: string): string {
  return path.join(dataDir, 'teams', journalId);
}

/** sunx 域容器根（2026-11-15 sunx P3 Task 3 枚举面单点）：`~/.sunshinex/sunx/`——GET /sunx/sessions
 *  扫描面用（各 `<journalId>/data` 域逐个 listSessions 归并）。与 sunxDomainDir 同根推导（后者即
 *  本单点下拼 journalId）；不 mkdir（空容器=扫描面 readdir 失败回空列，合法空态不建目录） */
export function sunxContainerDir(): string {
  // 显式覆盖（2026-11-15 sunx P3：SUNSHINEX_SUNX_DIR ≡ settings 语义键 sunxDir，userSkillsDir 同款
  // 惰性求值——测试可运行期重定向）：缺省 ~/.sunshinex/sunx/；切换容器对新建 Sunx 生效，既有域不迁移
  const override = process.env.SUNSHINEX_SUNX_DIR;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  return path.join(userConfigDir(), 'sunx');
}

/** sunx 持久化域目录（2026-11-15 sunx P3 Task 2 落位单点）：`~/.sunshinex/sunx/<journalId>/data`——
 *  一 Sunx 一持久化项目域（链/转录/品性/台账/板/记忆/调度/挂起审计全落域内）；容器 `~/.sunshinex/sunx/`
 *  独立于 projects/（workspaces 枚举/birth-only 清扫/归档边界天然不波及）。journalId 即域键（出生即铸档
 *  先铸 id——域路径依赖它），同 root 多实体各自独立目录零共享。显式不读 SUNSHINEX_DATA_DIR/SUNSHINEX_PROJECTS_DIR
 *  （域容器锚用户配置根——测试经 HOME 重定向），不 mkdir（写入面各自 recursive 建目录）。GUI 不感知
 *  物理路径——端点寻址 journalId 即可 */
export function sunxDomainDir(journalId: string): string {
  return path.join(sunxContainerDir(), journalId, 'data');
}

/** channels 域容器根（2026-11-21 channels spec §4 存储总览：IM 聊天持久化独立容器）：`~/.sunshinex/channels/`——
 *  各聊天专属域 `im-<channelSlug>-<chatSlug>/{workspace,data}` 逐域落位（config/channels.ts
 *  channelChatDomainDir 同根推导）；GET 侧栏「通道」扫描面用（Task 9 与 sunxContainerDir 扫描同构）。
 *  严格三分容器（projects/sunx/channels 各自独立、不混居）；不 mkdir（空容器=扫描面 readdir 失败回空列，合法空态） */
export function channelsContainerDir(): string {
  // 显式覆盖（sunxContainerDir :47 同款惯例：惰性求值——测试可运行期重定向）：缺省 ~/.sunshinex/channels/
  const override = process.env.SUNSHINEX_CHANNELS_DIR;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  return path.join(userConfigDir(), 'channels');
}

/** worktree 树识别(2026-11-10):树根 .git 是**文件**(gitdir: 指针→主仓 .git/worktrees/<name>/)
 *  且旁边有 sunshinex-mainroot 标记(建树时写入主项目根)→ 返回主项目根;普通工作区/主仓(.git 是
 *  目录)undefined。resolveDataDir 据此重定向(会话档/记忆/技能归主项目),session-lifecycle 据此
 *  跳过 workspace.json 注册(树会话不另立伪工作区) */
export function worktreeMainRootOf(root: string): string | undefined {
  if (process.env.SUNSHINEX_DATA_DIR !== undefined) return undefined; // 显式覆盖=权威,不重定向
  try {
    const dotGit = fs.readFileSync(path.join(root, '.git'), 'utf8');
    const m = /^gitdir:\s*(.+)$/m.exec(dotGit);
    if (m === null) return undefined;
    const mainRoot = fs.readFileSync(path.join(m[1]!.trim(), 'sunshinex-mainroot'), 'utf8').trim();
    if (mainRoot === '' || path.resolve(mainRoot) === path.resolve(root)) return undefined;
    return mainRoot;
  } catch {
    return undefined; // 非树工作区(主仓 .git 是目录/无标记)
  }
}

/** channels 域工作区判定（resolveDataDir channels 分支单点谓词）：root 位于 channels 容器内的
 *  im-* 域目录（workspace 的父目录）之下。纯路径谓词——SUNSHINEX_DATA_DIR 显式覆盖时 resolveDataDir
 *  走权威分支不经本判定。2026-11-23 二轮裁定：数据域事实行对 channels 域同给（隔离裁定只防目录
 *  误踩，不防知情），本谓词不再作装配缝缺席依据，回归模块内部实现 */
function isChannelsDomainRoot(root: string): boolean {
  const container = channelsContainerDir();
  const rel = path.relative(container, root);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 解析当前工作区数据目录：直指覆盖 > channels 域分支 > projects 根覆盖 > 缺省全局（HOME 可建）> 项目内回退；子目录由各写入面自行 mkdir */
export function resolveDataDir(root: string): string {
  const held = worktreeMainRootOf(root);
  if (held !== undefined) return resolveDataDir(held);
  const override = process.env.SUNSHINEX_DATA_DIR;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  // ②′ channels 聊天域分支（2026-11-21 channels spec §4 绑定解析；用户裁定：data 与 agent 脚下平级隔离、
  // 不嵌套——full-access agent 不得踩到自己的会话账本；常规项目 root 与 data 异树、sunx 域为纯持久化域，
  // 均无此问题，channels 不做嵌套形态）：root 位于 channels 容器内 → <容器>/<首段>/data（首段 = im-* 域
  // 目录，即 agent 工作区 workspace 的父目录）；置于 SUNSHINEX_DATA_DIR 检查之后=最小侵入（开发与测试
  // 专用直指口仍最高优先，常规路径行为零变动）；容器自身（rel 空串）非域目录，不命中走常规路径。
  // 域内判定收口 isChannelsDomainRoot 单点（2026-11-23 数据域事实行装配缝同源消费）
  if (isChannelsDomainRoot(root)) {
    const rel = path.relative(channelsContainerDir(), root);
    return path.join(channelsContainerDir(), rel.split(path.sep)[0]!, 'data');
  }
  const base = projectsRoot();
  const projectsOverride = process.env.SUNSHINEX_PROJECTS_DIR;
  // 显式指定 projects 根即权威：不探测、不回退（回退会掩盖「指了 D 盘却写在 C 盘」的配置错误）
  if (projectsOverride !== undefined && projectsOverride.length > 0) return path.join(base, projectSlug(root), 'data');
  try {
    fs.mkdirSync(base, { recursive: true });
    return path.join(base, projectSlug(root), 'data');
  } catch {
    // projects 根建目失败（盘缺席/权限）：降级仓内 .data 保数据可写；显式 override 走前置权威分支不降级
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
  return dirReal(resolveDataDir(root));
}

/** 目录真实路径归一（dataDirReal 归一段单点，2026-11-15 终审 Fix 2 提取）：安全链域绑定注入缝
 *  对**显式域目录**（非 root 推导）同法归一——注入域与推导区两界判据同源，归一策略零漂移 */
export function dirReal(dir: string): string {
  try {
    let anchor = dir;
    while (anchor.length > 1 && !fs.existsSync(anchor)) anchor = path.dirname(anchor);
    return fs.realpathSync(anchor) + dir.slice(anchor.length);
  } catch {
    return dir;
  }
}

/** 全局用户技能根（三级技能目录规格 §3）：缺省 ~/.sunshinex/skills，SUNSHINEX_USER_SKILLS_DIR 显式覆盖（开发与测试）。
 *  人手工放置的技能资产定位，不走 resolveDataDir（学习根按工作区隔离，语义不同）；不 mkdir、不做模块级缓存——技能根缺失是常态，装载面靠 existsSync 容忍 */
export function userSkillsDir(): string {
  const override = process.env.SUNSHINEX_USER_SKILLS_DIR;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  return path.join(userConfigDir(), 'skills');
}

/** 全局团队目录（预定义智能体团队用户级根，spec 2026-11-04 §1.1；SUNSHINEX_USER_SKILLS_DIR 不影响本目录） */
export function userTeamsDir(): string {
  return path.join(userConfigDir(), 'teams');
}

/**
 * sunshinex skills install <来源> [--force]
 * 技能一键安装到全局技能根（userSkillsDir，缺省 ~/.sunshinex/skills）：
 * - 来源形态：git URL（https://… 或 git@… ）、owner/repo 简写（缺省按 GitHub 展开为 https URL）、本地目录路径
 * - 仓库内技能目录定位序：skills/ → 五兼容根（.sunshinex/.claude/.agents/.codex/.cursor 下的 skills/）→ 仓库根自身
 *   直接含 {id}/SKILL.md 时整仓即技能集（对标 superpowers 这类「整仓就是一包技能」的组织）
 * - 落盘形态与装载器同口径：{目标}/skills/{id}/SKILL.md（SKILL.md 优先、skill.md 兜底）；同名已存在缺省跳过，
 *   --force 覆盖；id 仅认 [A-Za-z0-9._-]，拒绝来源仓内的任意路径片段
 * 纯节点实现零 shell 语法：git 经 spawnSync 直调（.exe 免 shell，§14 启动形态）
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { userSkillsDir } from '../../config/data-dir';
import { t } from '../../i18n';
import type { CliArgs } from '../index';

/** 仓库内候选技能目录（先命先止；skills/ 置顶对齐 superpowers 主形态） */
const REPO_SKILL_DIR_CANDIDATES = [
  'skills',
  path.join('.sunshinex', 'skills'),
  path.join('.claude', 'skills'),
  path.join('.agents', 'skills'),
  path.join('.codex', 'skills'),
  path.join('.cursor', 'skills'),
] as const;

const SKILL_ID_RE = /^[A-Za-z0-9._-]+$/;

/** 技能目录判据（与装载面 skillFileIn 同口径：SKILL.md 优先、skill.md 兜底） */
export function hasSkillFile(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'SKILL.md')) || fs.existsSync(path.join(dir, 'skill.md'));
}

function isGitUrl(src: string): boolean {
  return /^https?:\/\//.test(src) || /^git@[\w.-]+:/.test(src) || src.endsWith('.git');
}

function isOwnerRepoShorthand(src: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(src);
}

/**
 * 定位来源根下的技能目录清单：显式候选目录命中即用（含其下全部 {id}/ 子目录）；
 * 都未命中且根自身直接含 {id}/SKILL.md 时整仓即技能集；两不沾返回空（由调用方报错）。
 */
export function locateSkillDirs(sourceRoot: string): { dirs: string[]; layout: 'candidate' | 'flat-root' } {
  for (const rel of REPO_SKILL_DIR_CANDIDATES) {
    const dir = path.join(sourceRoot, rel);
    if (fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return { dirs: [dir], layout: 'candidate' };
  }
  const root = fs.readdirSync(sourceRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (root.some((e) => hasSkillFile(path.join(sourceRoot, e.name)))) return { dirs: [sourceRoot], layout: 'flat-root' };
  return { dirs: [], layout: 'candidate' };
}

export interface InstallOutcome {
  installed: string[];
  skipped: string[];
}

/** 从单个技能目录把全部 {id}/ 拷入目标技能根；非法 id 与非技能目录跳过并计数，不中断其余安装 */
export function installSkillsFromDir(skillDir: string, targetRoot: string, force: boolean): InstallOutcome {
  const out: InstallOutcome = { installed: [], skipped: [] };
  for (const entry of fs.readdirSync(skillDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SKILL_ID_RE.test(entry.name)) continue;
    const src = path.join(skillDir, entry.name);
    if (!hasSkillFile(src)) continue;
    const dest = path.join(targetRoot, entry.name);
    if (!force && fs.existsSync(dest)) {
      out.skipped.push(entry.name);
      continue;
    }
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    out.installed.push(entry.name);
  }
  return out;
}

/** git 浅克隆到临时目录；返回克隆根（调用方负责清理），失败以含 stderr 摘要的错误抛出 */
export function shallowClone(url: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skills-'));
  const r = spawnSync('git', ['clone', '--depth', '1', url, dest], { encoding: 'utf8', windowsHide: true });
  if (r.error) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error(t(`git clone failed: ${r.error.message}`, `git clone 失败：${r.error.message}`));
  }
  if (r.status !== 0) {
    fs.rmSync(dest, { recursive: true, force: true });
    const detail = String(r.stderr ?? '').trim().split('\n').slice(-2).join(' ');
    throw new Error(t(`git clone failed (exit=${r.status}): ${detail}`, `git clone 失败（exit=${r.status}）：${detail}`));
  }
  return dest;
}

/** 命令入口：skills install <来源> [--force]；输出走外观通道（t() 双语），失败 exitCode=1 */
export async function runSkillsInstall(args: CliArgs): Promise<void> {
  if (args.positional[0] !== 'install') {
    console.error(t('Usage: sunshinex skills install <git-url | owner/repo | local-dir> [--force]', '用法：sunshinex skills install <git-url | owner/repo | 本地目录> [--force]'));
    process.exitCode = 1;
    return;
  }
  const source = args.positional[1];
  if (!source) {
    console.error(t('Missing install source: a git URL, owner/repo shorthand, or local directory.', '缺少安装来源：git URL、owner/repo 简写或本地目录'));
    process.exitCode = 1;
    return;
  }
  const force = args.flags.force === true;
  let sourceRoot: string;
  let cleanup: (() => void) | undefined;
  if (isGitUrl(source) || isOwnerRepoShorthand(source)) {
    const url = isGitUrl(source) ? source : `https://github.com/${source}.git`;
    console.log(t(`[skills] cloning ${url} ...`, `[skills] 克隆 ${url} ...`));
    sourceRoot = shallowClone(url);
    cleanup = () => fs.rmSync(sourceRoot, { recursive: true, force: true });
  } else {
    sourceRoot = path.resolve(source);
    if (!fs.statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(t(`Install source not found: ${sourceRoot}`, `安装来源不存在：${sourceRoot}`));
      process.exitCode = 1;
      return;
    }
  }
  try {
    const { dirs, layout } = locateSkillDirs(sourceRoot);
    if (dirs.length === 0) {
      console.error(t(
        'No skills found: expected skills/, a compat skills root (.sunshinex/.claude/.agents/.codex/.cursor), or {id}/SKILL.md at repo root.',
        '未发现技能：期望 skills/、兼容技能根（.sunshinex/.claude/.agents/.codex/.cursor）或仓库根下直接含 {id}/SKILL.md',
      ));
      process.exitCode = 1;
      return;
    }
    const target = userSkillsDir();
    console.log(t(`[skills] layout=${layout} target=${target}`, `[skills] 布局=${layout} 目标=${target}`));
    const total: InstallOutcome = { installed: [], skipped: [] };
    for (const dir of dirs) {
      const r = installSkillsFromDir(dir, target, force);
      total.installed.push(...r.installed);
      total.skipped.push(...r.skipped);
    }
    for (const id of total.installed) console.log(t(`installed: ${id}`, `已安装：${id}`));
    for (const id of total.skipped) console.log(t(`skipped (exists, use --force): ${id}`, `已跳过（已存在，需 --force）：${id}`));
    console.log(t(
      `[skills] done: ${total.installed.length} installed, ${total.skipped.length} skipped`,
      `[skills] 完成：安装 ${total.installed.length} 个，跳过 ${total.skipped.length} 个`,
    ));
    if (total.installed.length === 0 && total.skipped.length === 0) process.exitCode = 1;
  } finally {
    cleanup?.();
  }
}

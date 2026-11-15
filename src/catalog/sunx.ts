/**
 * catalog/sunx 只读面：品性模板目录（<sunx 目录>/<id>/sunx.md）两级位置合并列举 + 遮蔽标注。
 * 落位单点 sunxDir 镜像 agentsDir/teamsDir：project=<root>/.sunshinex/sunx、global=<userConfigDir>/sunx
 * （globalDir 显式传参 = 测试/重定向口）。frontmatter name/description + 正文=品性章程（charter），
 * 解析词法复用 parseAgentFrontmatter 单点（sunx.md 与 agent.md 同款单行 KV frontmatter 词法——
 * name 必填、description 可选、frontmatter 后正文全量），不另造解析器。
 * 全程宽容（Controller 裁定 2026-11-15，与 agents 的 harness.AgentRegistry 装载 fail-fast 有意不同）：
 * 本目录只喂「创建弹窗挑选」——模板不进任何运行面/装配链，坏档炸装配的连锁不存在；单文件畸形
 * （缺 frontmatter/缺 name/读失败）→ warnings 跳过不抛死，弹窗拿到的清单永远可用（坏档死弹窗比
 * 少一个模板恶劣得多）；agents 目录的 fail-fast 因其条目直接影响运行面（坏 agent.md 会死锁整次
 * 会话装配），两处取舍有意分叉。本面无写面（模板创建走用户手编文件，GUI 只读消费）。
 * 两级层序（高→低，与 listAgents/listTeams 同构）：全局 ~/.sunshinex/sunx 垫底、项目
 * <root>/.sunshinex/sunx 遮蔽——同 id 撞车时被撞全局行保留在列标 shadowed:true（视图口径），
 * 消费面（弹窗挑选）只取未遮蔽行。缺目录 = 空清单零告警（Listing D7 容错口径）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { userConfigDir } from '../config/env';
import { parseAgentFrontmatter } from '../harness/subagent';
import type { Listing, Scope } from './types';

/** sunx 模板落位单点（镜像 agentsDir/teamsDir）：project=<root>/.sunshinex/sunx、global=<userConfigDir>/sunx；
 *  globalDir 显式传参 = 测试/重定向口。project 分支 root:null → cwd 回退仅为签名全整改（沿 agentsDir
 *  同形）；listSunxTemplates 对 root:null 刻意整体跳过项目级（见该函数注释），不经此回退。 */
export function sunxDir(scope: Scope, root: string | null, globalDir?: string): string {
  if (scope === 'global') return path.join(globalDir ?? userConfigDir(), 'sunx');
  return path.join(root ?? process.cwd(), '.sunshinex', 'sunx');
}

/** catalog 品性模板列表条目（ruling 2 行形状）：id/scope 定位 + 遮蔽标注 + frontmatter 元数据 + 章程全量。
 *  无 bodyPreview 帽（agents/teams 清单面的 200 帽为设置面板防击穿；本面唯一消费方是创建弹窗——
 *  选中即回填全文进 textarea，预览键零消费面，裁定不带） */
export interface SunxTemplateEntry {
  id: string;
  name: string;
  /** frontmatter description（可选键：空/缺席省键——弹窗只回填 name/charter，description 随行透出
   *  供清单消费方按需展示） */
  description?: string;
  /** 品性章程正文全量（frontmatter 之后；弹窗选中即全文回填 charter 文本域，可改） */
  charter: string;
  /** 条目来源层级：project = <root>/.sunshinex/sunx/；global = <userConfigDir>/sunx/ */
  source: Scope;
  /** true = 被更高优先同 id 遮蔽（被撞全局行保留在列，沿 listAgents 视图口径；生效条目恒 false） */
  shadowed: boolean;
}

/** parseAgentFrontmatter 包装（词法复用单点不动，只正名错误文案）：坏档 warning 以实际文件名落地——
 *  词法单点原生文案硬编码 'agent.md missing frontmatter'/'agent.md frontmatter missing name'
 *  （agent.md 语料口径），对 sunx.md 用户误导（终审修复波 Fix 4：warning 显示「agent.md 缺
 *  frontmatter」而档实为 sunx.md）。同语义重抛，仅替换文件名词 */
function parseSunxFrontmatter(text: string): ReturnType<typeof parseAgentFrontmatter> {
  try {
    return parseAgentFrontmatter(text);
  } catch (e) {
    throw new Error((e instanceof Error ? e.message : String(e)).replaceAll('agent.md', 'sunx.md'));
  }
}

/**
 * 两级合并列举（层序=装载序：全局 → 项目，各层内按 id 字典序沿 listAgents 口径）。
 * 容错口径沿 Listing（D7）：目录缺 = 空清单不算错；单文件畸形（frontmatter 缺块/缺 name、读失败）
 * 一律降级产 warnings 不抛——全程宽容（模块头裁定：模板只影响表单，不进装配链，宁可少列不可抛死）。
 * 扫描几何镜像 listAgents：仅收 <id>/sunx.md 常规目录（非目录/缺 sunx.md 的目录静默跳过——几何不
 * 合非「坏档」，零告警）。root:null 时项目级整体跳过（只列全局，沿 listAgents 口径：无项目上下文
 * 凭空落 cwd 只会伪扫）。
 * 遮蔽语义（与 listAgents/listTeams 视图逐层同构）：项目最高（同 id 撞全局，被撞全局行 shadowed:true
 * 保留在列）；全局垫底。
 */
export function listSunxTemplates(root: string | null, globalDir?: string): Listing<SunxTemplateEntry> {
  const warnings: string[] = [];
  /** 单目录扫描：仅收 <id>/sunx.md 常规目录（沿 listAgents 几何，无 sunx.md 的目录跳过） */
  const scan = (dir: string, scope: Scope): Map<string, SunxTemplateEntry> => {
    const out = new Map<string, SunxTemplateEntry>();
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'sunx.md');
      if (!fs.existsSync(file)) continue;
      try {
        const meta = parseSunxFrontmatter(fs.readFileSync(file, 'utf8'));
        out.set(entry.name, {
          id: entry.name,
          name: meta.name,
          ...(meta.description !== '' ? { description: meta.description } : {}),
          charter: meta.body,
          source: scope,
          shadowed: false,
        });
      } catch (e) {
        warnings.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  };
  const globalEntries = scan(sunxDir('global', root, globalDir), 'global');
  const projectEntries = root !== null ? scan(sunxDir('project', root, globalDir), 'project') : new Map<string, SunxTemplateEntry>();
  // 项目最高：同 id 撞全局——全局条目保留在列、标 shadowed:true（视图口径，消费面只取未遮蔽行）
  for (const id of projectEntries.keys()) {
    const g = globalEntries.get(id);
    if (g) globalEntries.set(id, { ...g, shadowed: true });
  }
  const byId = (a: SunxTemplateEntry, b: SunxTemplateEntry): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { entries: [...[...globalEntries.values()].sort(byId), ...[...projectEntries.values()].sort(byId)], warnings };
}

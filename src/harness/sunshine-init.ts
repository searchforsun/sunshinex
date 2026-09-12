import * as fs from 'fs';
import * as path from 'path';
import { PerceptionEngine } from './perception';

export interface SunshineInitResult {
  /** true=新生成骨架；false=文件已存在，跳过不覆盖 */
  created: boolean;
  /** SUNSHINE.md 绝对路径 */
  path: string;
}

/** /init 骨架模板（纯函数，独立单测）：分区名与 loadSunshinex 提取口径对齐——「项目名称」供 name、「架构原则」条目供 architecture、「编码规范」下 `- ` 条目供 rules；占位说明行不用 `- ` 开头，避免骨架提示被当作正式规则注入上下文 */
export function sunshineTemplate(name: string, fileCount: number, deps: string[]): string {
  const depLine =
    deps.length === 0
      ? '依赖未检出（无 package.json 或空依赖）'
      : `依赖 ${deps.length} 项：${deps.slice(0, 6).join('、')}${deps.length > 6 ? ' 等' : ''}`;
  return [
    '# 项目名称',
    name,
    '',
    '# 架构原则',
    `- 感知扫描（SunshineX /init 生成）：${fileCount} 个源码文件，${depLine}（本节请按项目实际修订）`,
    '',
    '# 编码规范',
    '（每行一条以 `- ` 开头的规则将注入 Agent 上下文，请按团队约定补充）',
    '',
  ].join('\n');
}

function readPackageName(root: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: unknown };
    return typeof pkg.name === 'string' && pkg.name.trim() !== '' ? pkg.name.trim() : null;
  } catch {
    return null;
  }
}

/** /init 核心：基于项目感知生成 SUNSHINE.md 骨架。走确定性模板而非模型生成——命令零模型调用、结果稳定可测；
 *  「加载到上下文」无需额外装载步骤：ContextLoader 每轮 assemble 时从磁盘读取，写盘即对后续轮次生效 */
export function initSunshine(root: string): SunshineInitResult {
  const p = path.join(root, 'SUNSHINE.md');
  if (fs.existsSync(p)) return { created: false, path: p };
  const perceived = new PerceptionEngine(root).scan();
  const name = readPackageName(root) ?? path.basename(path.resolve(root));
  fs.writeFileSync(p, sunshineTemplate(name, perceived.files.length, perceived.dependencies), 'utf8');
  return { created: true, path: p };
}

import * as fs from 'fs';
import * as path from 'path';
import { resolveDataDir } from '../config/data-dir';

/** 技能最近使用统计（2026-09-30 纵向命令面板「skills 默认显示最近常用的」）：单文件 JSON
 *  { [skillId]: lastUsedAt(ms) }，落全局数据目录（resolveDataDir 单点，随工作区隔离）。
 *  统计属锦上添花面：读失败回落空表、写失败静默（不阻塞命令分发主链） */
const SKILL_USAGE_FILE = 'skill-usage.json';

function usageFile(root: string): string {
  return path.join(resolveDataDir(root), SKILL_USAGE_FILE);
}

/** 读全量使用时间表：文件缺失/损坏回落空表（首用前、并发写半截均不炸主链） */
export function readSkillUsage(root: string): Record<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(usageFile(root), 'utf8'));
    if (raw !== null && typeof raw === 'object') {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
  } catch {
    // 缺失/损坏一律空表
  }
  return {};
}

/** 记一次使用（loadSkill 成功/去重路径调用）：读改写合并，目录按需创建；写失败静默零影响 */
export function recordSkillUsage(root: string, id: string, at: number = Date.now()): void {
  try {
    const file = usageFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cur = readSkillUsage(root);
    cur[id] = at;
    fs.writeFileSync(file, JSON.stringify(cur));
  } catch {
    // 统计失败不阻塞命令面
  }
}

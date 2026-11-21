import * as fs from 'node:fs';
import * as path from 'node:path';
import { userConfigDir } from '../config/env';
import { listSunxDataDirs, listWorkspaceDataDirs } from './sessions-list-handlers';

/**
 * 缓存登记表单点(2026-11-21 spec §3,docs/superpowers/specs/2026-11-21-archive-retention-
 * cache-clear-design.md):「正确识别哪些是缓存」的唯一事实源——id/safe 档位/落点三元登记,
 * GET /cache 报体积、POST /cache/clear 受控清理;GUI 双语标签按 id 本地映射(id 稳定)。
 *
 * 三档口径:
 * - safe(一键清,可再生或纯暂存):pty-replay / editor-icons / compaction-archives(会话 jsonl
 *   逐字节权威仍在,归档仅安全镜像)/ tool-outputs(链上留预览)/ plugin-logs / computer-use-screenshots;
 *   http-cache(Chromium)不在本表——归壳 IPC shell:clear-cache,GUI 合成伪行。
 * - unsafe(引用型,仅设置页带警示单独清):images-cache(附件原图唯一副本,journal 只存路径引用)。
 * - 绝不触碰(用户数据,不在登记表):sessions/ memory/ skills/ kb/ teams/ tasks/ workspace.json
 *   serve-token settings.json mcp.json schedules.json retention-state.json gui/ui-state.json 族、
 *   plugins/browser-use/profile/(内置浏览器登录态)、webview 分区 cookie/localStorage。
 */

export interface CacheCategoryDef {
  readonly id: string;
  readonly safe: boolean;
  readonly scope: 'global' | 'per-data-dir';
  /** scope=global:userConfigDir 等价根下相对段;scope=per-data-dir:dataDir 下相对段 */
  readonly segments: readonly string[];
}

export const CACHE_CATEGORIES: readonly CacheCategoryDef[] = [
  { id: 'pty-replay', safe: true, scope: 'global', segments: ['pty-replay'] },
  { id: 'editor-icons', safe: true, scope: 'global', segments: ['gui', 'editor-icons'] },
  { id: 'compaction-archives', safe: true, scope: 'per-data-dir', segments: ['archives'] },
  { id: 'tool-outputs', safe: true, scope: 'per-data-dir', segments: ['tool-outputs'] },
  { id: 'plugin-logs', safe: true, scope: 'per-data-dir', segments: ['plugins', 'logs'] },
  { id: 'computer-use-screenshots', safe: true, scope: 'per-data-dir', segments: ['plugins', 'computer-use', 'screenshots'] },
  { id: 'images-cache', safe: false, scope: 'per-data-dir', segments: ['images-cache'] },
];

/** 扫描根(注入形):globalRoot=userConfigDir 等价根(SUNSHINEX_DATA_DIR 重定向同 schedules.json
 *  口径——开发/测试专用),dataDirs=projectsRoot 全 slug + sunx 容器全域的 data 目录 */
export interface CacheDirs {
  readonly globalRoot: string;
  readonly dataDirs: readonly string[];
}

export function resolveCacheDirs(): CacheDirs {
  const override = process.env.SUNSHINEX_DATA_DIR;
  const globalRoot = override !== undefined && override !== '' ? path.resolve(override) : userConfigDir();
  const dataDirs = [...listWorkspaceDataDirs(), ...listSunxDataDirs()].map((d) => d.dataDir);
  return { globalRoot, dataDirs };
}

/** 目录体积(递归;缺席/竞态消失按 0 计,读侧零副作用不建目录) */
export function dirStats(dir: string): { size: number; files: number } {
  let size = 0;
  let files = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          size += fs.statSync(p).size;
          files += 1;
        } catch {
          /* 枚举与 stat 间消失:按 0 计 */
        }
      }
    }
  };
  walk(dir);
  return { size, files };
}

/** 某 id 的具体目录全集(global=1 个根,per-data-dir=每工作区/域 1 个;未知 id=空表) */
export function categoryDirs(id: string, dirs: CacheDirs = resolveCacheDirs()): string[] {
  const def = CACHE_CATEGORIES.find((c) => c.id === id);
  if (def === undefined) return [];
  const roots = def.scope === 'global' ? [dirs.globalRoot] : dirs.dataDirs;
  return roots.map((r) => path.join(r, ...def.segments));
}

export interface CacheCategoryStatus {
  id: string;
  safe: boolean;
  size: number;
  files: number;
}

export function cacheStatus(dirs: CacheDirs = resolveCacheDirs()): { total: number; categories: CacheCategoryStatus[] } {
  const categories = CACHE_CATEGORIES.map((def) => {
    let size = 0;
    let files = 0;
    for (const d of categoryDirs(def.id, dirs)) {
      const s = dirStats(d);
      size += s.size;
      files += s.files;
    }
    return { id: def.id, safe: def.safe, size, files };
  });
  return { total: categories.reduce((a, c) => a + c.size, 0), categories };
}

export interface CacheClearResult {
  cleared: Array<{ id: string; freed: number }>;
  failed: Array<{ id: string; error: string }>;
}

/** 受控清理(spec §5):rm 目录本身(写面 mkdirSync recursive 惰性重建,幂等);ids 缺省=safe 全档;
 *  显式传 ids 照清(含 unsafe——警示责任在 UI,端点不二次拦截);逐项记账单项目失败不阻断 */
export function clearCacheCategories(ids?: readonly string[], dirs: CacheDirs = resolveCacheDirs()): CacheClearResult {
  const selected = ids === undefined ? CACHE_CATEGORIES.filter((c) => c.safe).map((c) => c.id) : [...ids];
  const out: CacheClearResult = { cleared: [], failed: [] };
  for (const id of selected) {
    if (!CACHE_CATEGORIES.some((c) => c.id === id)) {
      out.failed.push({ id, error: 'unknown cache category' });
      continue;
    }
    let freed = 0;
    let error: string | undefined;
    for (const d of categoryDirs(id, dirs)) {
      try {
        freed += dirStats(d).size;
        fs.rmSync(d, { force: true, recursive: true });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    if (error !== undefined) out.failed.push({ id, error });
    else out.cleared.push({ id, freed });
  }
  return out;
}

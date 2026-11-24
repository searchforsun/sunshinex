/** 注册工作区根清单（channels /workspace 命令候选面,2026-11-24 用户裁定「加切换工作区」）：
 *  扫 projectsRoot 下各 `<slug>/data` 有档者,workspace.json 反解真 root（GET /workspaces 同源
 *  口径——handleWorkspaces 全行版在 workspace-handlers.ts,本文件只取可 attach 的 root 列,独立
 *  小件零 HTTP 依赖,router 经 engine 缺省装配消费）。隐藏档（侧栏「移除」的工作区,机器级视图
 *  偏好）不出列——读取与 workspace-handlers.readHiddenSlugs 同档同语义（该函数未导出,不为此
 *  碰其文件）。缺目录/坏档条目跳过;root 缺档（历史 slug-only）不可 attach,同样不出列。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectsRoot } from '../config/data-dir';
import { userConfigDir } from '../config/env';
import { defaultScratchRootPath, isDefaultWorkspaceSlug } from './session-lifecycle';

/** 隐藏 slug 清单读（workspace-handlers.readHiddenSlugs 同档同语义,见头注）：缺档/坏档回空集 */
function readHiddenSlugs(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userConfigDir(), 'gui', 'workspace-hidden.json'), 'utf8')) as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** 注册工作区根（mtime 降序=最近工作区在前,GET /workspaces 同序）。读盘失败/根未注册 → 空数组 */
export function registeredWorkspaceRoots(): string[] {
  const roots: Array<{ root: string; mtime: number }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  const hidden = readHiddenSlugs();
  for (const ent of entries) {
    if (!ent.isDirectory() || hidden.has(ent.name)) continue;
    const dataDir = path.join(projectsRoot(), ent.name, 'data');
    let st: fs.Stats;
    try {
      st = fs.statSync(dataDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let root: string | undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8')) as { root?: unknown };
      if (typeof raw?.root === 'string' && raw.root.length > 0) root = raw.root;
    } catch {
      // 历史工作区无档/坏档 → root undefined,不可 attach,不出列
    }
    if (root === undefined && isDefaultWorkspaceSlug(ent.name)) root = defaultScratchRootPath(); // G14.96 默认锚点历史档降级,handleWorkspaces 同款
    if (root !== undefined) roots.push({ root, mtime: st.mtimeMs });
  }
  return roots.sort((a, b) => b.mtime - a.mtime).map((r) => r.root);
}

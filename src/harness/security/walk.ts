import * as fs from 'fs';
import * as path from 'path';
import { globMatch } from './rules';

/** 递归遍历期间的感知跳过集：依赖/构建产物/版本库元数据 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.data', '.npm-cache']);

/** 目录递归收集相对 root 的文件路径（相对路径），跳过 SKIP_DIRS 与隐藏目录 */
export function walkFiles(root: string, relDir = ''): string[] {
  const abs = relDir ? path.join(root, relDir) : root;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...walkFiles(root, rel));
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/** basename 级 glob 过滤（'*.md' 匹配任意层级的文件名；为空 = 全部匹配） */
export function filterByGlob(files: string[], glob?: string): string[] {
  if (!glob) return files;
  const base = glob.includes('/') ? glob.slice(glob.lastIndexOf('/') + 1) : glob;
  return files.filter((f) => globMatch(base, f.slice(f.lastIndexOf('/') + 1)));
}

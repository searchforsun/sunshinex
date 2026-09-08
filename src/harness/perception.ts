import * as fs from 'fs';
import * as path from 'path';
import { loadSunshinex } from '../config';
import { ProjectContext } from '../types';

export interface Perceived {
  files: string[];
  dependencies: string[];
  project: ProjectContext | null;
  gitBranch: string | null;
}

/** 感知扫描跳过目录（单一事实源）：依赖/构建产物/包管理器 store/运行时数据/过程物料/长任务演示目标不入感知；与仓库 .gitignore 的目录条目由 perception.test.ts 绑定测试锚定——.gitignore 新增目录须同步此处，否则绑定测试红 */
export const SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.pnpm-store', '.npm-cache', '.data', '.superpowers', '.longtask']);

/** 项目感知引擎：目录扫描 + 依赖解析 + SUNSHINE.md + Git 分支（降级不抛） */
export class PerceptionEngine {
  constructor(private root: string) {}

  scan(): Perceived {
    return {
      files: this.scanFiles(),
      dependencies: this.readDeps(),
      project: loadSunshinex(this.root),
      gitBranch: this.readGitBranch(),
    };
  }

  private scanFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SCAN_SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else out.push(path.relative(this.root, full));
      }
    };
    walk(this.root);
    return out;
  }

  private readDeps(): string[] {
    try {
      const p = path.join(this.root, 'package.json');
      if (!fs.existsSync(p)) return [];
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Object.keys({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) });
    } catch {
      return []; // 依赖解析失败降级为「依赖未知」
    }
  }

  private readGitBranch(): string | null {
    try {
      const head = fs.readFileSync(path.join(this.root, '.git', 'HEAD'), 'utf8').trim();
      const m = /refs\/heads\/(.+)$/.exec(head);
      return m ? m[1] : head;
    } catch {
      return null;
    }
  }
}

import * as fs from 'fs';
import * as path from 'path';
import { ContextItem } from '../../types';
import { userConfigDir } from '../../config/env';

/** 全局约定文件路径：SUNSHINEX_GLOBAL_SUNSHINE 覆盖（测试钉扎/多配置并存），缺省 ~/.sunshinex/SUNSHINE.md（对标 ~/.claude/CLAUDE.md，跨工作区个人标准） */
export function globalSunshinePath(): string {
  const override = (process.env.SUNSHINEX_GLOBAL_SUNSHINE ?? '').trim();
  return override.length > 0 ? override : path.join(userConfigDir(), 'SUNSHINE.md');
}

/** 分层指令加载：全局 ~/.sunshinex/SUNSHINE.md → 项目 SUNSHINE.md（全局在前、项目更近模型注意力）；均支持 @path import 展开（递归 4 层） */
export class ContextLoader {
  constructor(private root: string, private globalFile: string = globalSunshinePath()) {}

  load(): ContextItem[] {
    const items: ContextItem[] = [];
    if (fs.existsSync(this.globalFile)) this.collect(this.globalFile, items, 0);
    const p = path.join(this.root, 'SUNSHINE.md');
    if (fs.existsSync(p)) this.collect(p, items, 0);
    return items;
  }

  /** SUNSHINE.md 原始文本（漂移检测基线与比对用；不存在或不可读返回 null——检测须永不因文件缺失而抛） */
  readSunshinex(): string | null {
    try {
      return fs.readFileSync(path.join(this.root, 'SUNSHINE.md'), 'utf8');
    } catch {
      return null;
    }
  }

  /** 全局层原始文本（漂移检测基线与比对用，语义同 readSunshinex） */
  readGlobalSunshine(): string | null {
    try {
      return fs.readFileSync(this.globalFile, 'utf8');
    } catch {
      return null;
    }
  }

  /** 全局层绝对路径（漂移说明 read 指针用） */
  get globalPath(): string {
    return this.globalFile;
  }

  private collect(file: string, items: ContextItem[], depth: number): void {
    if (depth > 4) return;
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^@([\w./-]+\.md)$/.exec(line.trim());
      if (m) {
        const target = path.resolve(path.dirname(file), m[1]);
        if (fs.existsSync(target)) this.collect(target, items, depth + 1);
        continue;
      }
      if (line.trim().length > 0) items.push({ kind: 'instruction', content: line });
    }
  }
}

/** SUNSHINE.md「Compact Instructions」区提取（规格 E 项，对标 CLAUDE.md 同名区）：
 *  识别 `## Compact Instructions` / `## 压缩指令` 标题，区体在下个二级标题或文件尾终止；
 *  无区或区体为空返回 null——压缩摘要 prompt 无区时与现形态逐字节一致。 */
export function extractCompactInstructions(md: string): string | null {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+(Compact Instructions|压缩指令)\s*$/.test(l.trim()));
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) break;
    body.push(lines[i]);
  }
  const text = body.join('\n').trim();
  return text.length > 0 ? text : null;
}

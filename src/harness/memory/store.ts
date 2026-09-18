import * as fs from 'fs';
import * as path from 'path';
import { Result, ok, fail } from '../../result';
import { resolveDataDir } from '../../config/data-dir';

/** 容量与阈值常量（规格 §2：代码内钉住不加 env） */
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25_000;
export const MEMORY_CONSOLIDATE_THRESHOLD = 10;

/** 归一化（去重比对口径）：trim + 小写 + 连续空白折叠为单空格（s09 _normalized_memory_text 同款） */
export function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 标题确定性折叠：非字母数字 Unicode → '-'，掐头尾，截长 40，全折叠回退 memo（learned slugify 同款形态） */
export function slugifyMemory(title: string): string {
  const slug = title
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'memo';
}

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

export interface MemoryRecord {
  slug: string;
  type: MemoryType;
  /** 绝对日期 YYYY-MM-DD：整理判 stale 的唯一时效依据（时间只以绝对形式存在） */
  created: string;
  description: string;
  body: string;
}

const INDEX_NAME = 'MEMORY.md';

/** 解析记录文件（frontmatter 四行 + 正文）；坏文件返回 null 不中断整表扫描 */
function parseRecord(file: string, slug: string): MemoryRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const type = MEMORY_TYPES.includes(meta.type as MemoryType) ? (meta.type as MemoryType) : 'project';
  return { slug, type, created: meta.created ?? '', description: meta.description ?? '', body: m[2].replace(/\n$/, '') };
}

/**
 * 陈述性记忆存储底座（规格 §2）：记录文件 <slug>.md 为单一事实源，MEMORY.md 索引是派生物（每次写操作全量重建，不维护增量）。
 * 容量纪律对标 CC：索引超 200 行或 25KB → 记录已写盘但报错勒令精简（不静默丢、不静默挤）。
 * 旁路纪律：本类任何 fs 异常都不该倒灌任务收口（调用方 settle 面再兜一层，本类只保证原语语义清晰）。
 */
export class MemoryStore {
  private readonly dirPath: string;

  constructor(root: string) {
    this.dirPath = path.join(resolveDataDir(root), 'memory');
    fs.mkdirSync(this.dirPath, { recursive: true });
  }

  dir(): string {
    return this.dirPath;
  }

  /** 记录文件为单一事实源：每次全量扫描解析（用户手改记录文件即刻可见） */
  list(): MemoryRecord[] {
    const out: MemoryRecord[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dirPath, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name === INDEX_NAME) continue;
      const rec = parseRecord(path.join(this.dirPath, e.name), e.name.slice(0, -3));
      if (rec) out.push(rec);
    }
    return out;
  }

  count(): number {
    return this.list().length;
  }

  has(slug: string): boolean {
    return fs.existsSync(path.join(this.dirPath, `${slug}.md`));
  }

  indexText(): string {
    try {
      return fs.readFileSync(path.join(this.dirPath, INDEX_NAME), 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * 写入一条记录：归一化三级去重（slug / description / body 任一归一相同即拒）→ 撞名追加 -2/-3… →
   * 写记录文件 → 全量重建索引 → 超限判定（已写盘但返回 MEMORY_INDEX_OVER_LIMIT，CC 语义）。
   */
  add(input: { type: MemoryType; description: string; body: string; created?: string }): Result<MemoryRecord> {
    const description = input.description.trim();
    const body = input.body.trim();
    if (!description || !body) return fail('MEMORY_EMPTY', '记忆描述与正文均不得为空');
    const candidate = slugifyMemory(description);
    const duplicate = this.list().find(
      (r) =>
        r.slug === candidate ||
        normalizeText(r.description) === normalizeText(description) ||
        normalizeText(r.body) === normalizeText(body),
    );
    if (duplicate) return fail('MEMORY_DUPLICATE', `duplicate: ${candidate}`);

    let slug = candidate;
    for (let n = 2; this.has(slug); n += 1) slug = `${candidate}-${n}`;
    const created = input.created ?? new Date().toISOString().slice(0, 10);
    const md = ['---', `type: ${input.type}`, `created: ${created}`, `description: ${description}`, '---', body, ''].join('\n');
    fs.writeFileSync(path.join(this.dirPath, `${slug}.md`), md);
    this.rebuildIndex();

    const record: MemoryRecord = { slug, type: input.type, created, description, body };
    const over = this.overLimit();
    if (over !== null) return fail('MEMORY_INDEX_OVER_LIMIT', over);
    return ok(record);
  }

  remove(slug: string): Result<void> {
    const file = path.join(this.dirPath, `${slug}.md`);
    if (!fs.existsSync(file)) return fail('MEMORY_NOT_FOUND', `no such memory: ${slug}`);
    fs.rmSync(file);
    this.rebuildIndex();
    return ok(undefined);
  }

  /** 索引全量重建（派生物语义：空集写空文件，保持文件存在形态统一） */
  rebuildIndex(): void {
    const lines = this.list().map((r) => `- ${r.slug} — ${r.description} [${r.type}]`);
    fs.writeFileSync(path.join(this.dirPath, INDEX_NAME), lines.length > 0 ? `${lines.join('\n')}\n` : '');
  }

  /** 容量纪律：超 200 行或 25KB 返回勒令精简报错文本（含当前行数/字节数与上限），否则 null */
  overLimit(): string | null {
    const text = this.indexText();
    const lines = text.split('\n').filter((l: string) => l.length > 0).length;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (lines > MEMORY_INDEX_MAX_LINES) {
      return `索引 ${lines} 行（上限 ${MEMORY_INDEX_MAX_LINES} 行），当前 ${bytes} 字节——请合并条目或把细节挪进记录正文后重建索引`;
    }
    if (bytes > MEMORY_INDEX_MAX_BYTES) {
      return `索引 ${lines} 行、当前 ${bytes} 字节（上限 ${MEMORY_INDEX_MAX_BYTES} 字节）——请合并条目或把细节挪进记录正文后重建索引`;
    }
    return null;
  }
}

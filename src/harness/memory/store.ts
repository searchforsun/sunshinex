import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
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
/** 合法记忆类型集（R7 单点）：extractor 工具入口自校验与 writer 接缝校验共用 import，防三处清单漂移 */
export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

export interface MemoryRecord {
  slug: string;
  type: MemoryType;
  /** 绝对日期 YYYY-MM-DD：整理判 stale 的唯一时效依据（时间只以绝对形式存在） */
  created: string;
  /** 最近写入时间（ISO 8601，每次写入刷新）；缺该字段的旧记录解析回退 created */
  modified: string;
  description: string;
  body: string;
  /** 相关记录 slug 列表（Wiki 互联，整理面写入；缺省=无链接——存量记录零变化） */
  links?: string[];
  /** 被哪条记录取代（整理 supersede 语义的显式承载；被标记记录不进索引） */
  supersededBy?: string;
}

/** 近满阈值（规格 §6）：上限的 80%，行数与字节数任一先到即提醒 */
const NEAR_LIMIT_RATIO = 0.8;

/** frontmatter 序列化（键集单一来源：add 与 put 共用，防两处格式漂移）。links/superseded_by 为可选键：
 *  空则不写——存量记录（四键形态）逐字节不变 */
function serialize(rec: { type: MemoryType; created: string; modified: string; description: string; body: string; links?: string[]; supersededBy?: string }): string {
  const lines = [
    '---',
    `type: ${rec.type}`,
    `created: ${rec.created}`,
    `modified: ${rec.modified}`,
    `description: ${rec.description}`,
  ];
  if (rec.links !== undefined && rec.links.length > 0) lines.push(`links: ${rec.links.join(', ')}`);
  if (rec.supersededBy !== undefined && rec.supersededBy.length > 0) lines.push(`superseded_by: ${rec.supersededBy}`);
  lines.push('---', rec.body, '');
  return lines.join('\n');
}

/** Wiki 字段归一（add/put 共用）：links 去重滤非法 slug，空数组/空串视为无——返回可直接展开进记录与 serialize 的形态 */
function wikiFields(links: string[] | undefined, supersededBy: string | undefined): { links?: string[]; supersededBy?: string } {
  const ls = [...new Set((links ?? []).map((s) => s.trim()).filter((s) => isSafeSlug(s)))];
  const sb = supersededBy !== undefined && isSafeSlug(supersededBy.trim()) ? supersededBy.trim() : undefined;
  return { ...(ls.length > 0 ? { links: ls } : {}), ...(sb !== undefined ? { supersededBy: sb } : {}) };
}

/** 主题页子目录名（Wiki 层，派生物）：<memory>/topics/<topic>.md——子目录天然不进 list() 记录扫描与 .bak 快照 */
export const TOPICS_DIR = 'topics';

/** 主题页输入（整理面产出）：name=主题名、description=一句话（进索引）、summary=综述正文、slugs=归属记录 */
export interface MemoryTopic {
  name: string;
  description: string;
  summary: string;
  slugs: string[];
}

/** 派生索引文件名（R7 单点）：store 重建/读盘、writer 接缝索引排他、pipeline 说明行指针共用 */
export const INDEX_NAME = 'MEMORY.md';

/** 索引名的 slug 排他口径（大小写不敏感比较用：`MEMORY.md` 去扩展名即 `memory`） */
const INDEX_SLUG = 'memory';

/** 变更历史文件名（OKF log 件）：追加只增的事件账本，五写原语单点收口追加；list() 的 .md 口径天然排除，
 *  backup/restore 须显式保护（备份对象是记录文件集，log 自身追加只增无需快照、也不可被还原清退） */
export const LOG_NAME = 'log.jsonl';

/** 变更事件来源面：标注该条事件由哪个调用面触发（appendLog 收口的调用方透传，缺省 system） */
export type MemoryLogSource = 'tool' | 'extractor' | 'consolidate' | 'system';

/** 变更事件（摘要指纹粒度）：正文只记 sha256 前 12 位指纹，全文恢复走 .bak 快照 */
export interface MemoryLogEvent {
  ts: string;
  op: 'add' | 'put' | 'remove' | 'backup' | 'restore' | 'topics';
  slug?: string;
  prevDigest?: string;
  newDigest?: string;
  source: MemoryLogSource;
}

function bodyDigest(body: string): string {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12);
}

/** 整理回滚快照目录名前缀（backup 原语单点，D26/J10）：.bak-<epoch-ms> 子目录——.bak 命名与清退/清空范围等
 *  目录级 fs 知识全部收敛进 store，调用方（consolidate）只持句柄不做目录手术 */
const BAK_PREFIX = '.bak-';

/**
 * slug 安全校验（写入/删除前拼 `<slug>.md` 的唯一收口，供后续任务复用）：非空 **且** 已是规范化形态
 * （`slugifyMemory(slug) === slug`，天然排除 `/`、`..`、空白等越界形态）**且** 不等于索引名 `MEMORY`
 * （大小写不敏感——Windows/macOS 文件系统不区分大小写，记录一旦落到 `MEMORY.md` 会覆盖派生索引，
 * 且该记录随后被 `list()` 当索引跳过 → 静默不可见）。
 */
export function isSafeSlug(slug: string): boolean {
  if (slug.length === 0) return false;
  if (slugifyMemory(slug) !== slug) return false;
  return slug.toLowerCase() !== INDEX_SLUG;
}

/** 非法 slug 的统一失败结果（put/remove 共用，文案单点防漂移） */
function failSlugInvalid<T>(): Result<T> {
  return fail('MEMORY_SLUG_INVALID', 'invalid memory slug: must be in normalized form and must not be the index name');
}

/** 记忆记录 frontmatter 词法单点（R6·memory 族）：`---` 块内首个 ':' 切分的 kv 行抽取，body 原样返回
 *  （尾部换行剥除等后处理归调用方）。两严格度刻意分立——strict（磁盘读）：开界逐字 `---\n`、行切 '\n'，
 *  CRLF/尾空白形态不匹配即按坏文件处理（磁盘记录全部经 serialize 落盘为 LF，偏离即损坏信号，宁可跳过）；
 *  lenient（模型写）：`\s*` 缓冲 + /\r?\n/ 行切，模型产出容错（CRLF/尾空白不拒——读严写宽防手抖形态回流磁盘） */
export function parseMemoryFrontmatter(raw: string, opts: { lenient: boolean }): { meta: Record<string, string>; body: string } | null {
  const m = (opts.lenient ? /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/ : /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/).exec(raw);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(opts.lenient ? /\r?\n/ : '\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

/** 主记忆目录定位单点（R12 收敛）：<dataDir(root)>/memory——store 构造、context 快照/漂移、pipeline 说明行共用 */
export function memoryDir(root: string): string {
  return path.join(resolveDataDir(root), 'memory');
}

/** 索引读盘无副作用形态（R12 收敛）：MemoryStore 构造含 mkdirSync 副作用，context 快照装载/漂移比对
 *  只读不建目录，经此独立函数复用同一读盘口径；无文件为空串 */
export function readMemoryIndex(dir: string): string {
  try {
    return fs.readFileSync(path.join(dir, INDEX_NAME), 'utf8');
  } catch {
    return '';
  }
}

/** 解析记录文件（frontmatter 四行 + 正文，词法走 parseMemoryFrontmatter strict 形）；坏文件返回 null 不中断整表扫描 */
function parseRecord(file: string, slug: string): MemoryRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseMemoryFrontmatter(raw, { lenient: false });
  if (parsed === null) return null;
  const meta = parsed.meta;
  const type = MEMORY_TYPES.includes(meta.type as MemoryType) ? (meta.type as MemoryType) : 'project';
  // Wiki 字段（frontmatter `links: a, b` 逗号单行 / `superseded_by: slug`）：非法 slug 逐项滤除，缺键=无
  const links = (meta.links ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => isSafeSlug(s));
  const supersededBy = meta.superseded_by !== undefined && isSafeSlug(meta.superseded_by) ? meta.superseded_by : undefined;
  return {
    slug,
    type,
    created: meta.created ?? '',
    modified: meta.modified ?? meta.created ?? '',
    description: meta.description ?? '',
    body: parsed.body.replace(/\n$/, ''),
    ...(links.length > 0 ? { links } : {}),
    ...(supersededBy !== undefined ? { supersededBy } : {}),
  };
}

/**
 * 陈述性记忆存储底座（规格 §2）：记录文件 <slug>.md 为单一事实源，MEMORY.md 索引是派生物（每次写操作全量重建，不维护增量）。
 * 容量纪律对标 CC：索引超 200 行或 25KB → 记录已写盘但报错勒令精简（不静默丢、不静默挤）。
 * 旁路纪律：本类任何 fs 异常都不该倒灌任务收口（调用方 settle 面再兜一层，本类只保证原语语义清晰）。
 */
export class MemoryStore {
  private readonly dirPath: string;
  private readonly source: MemoryLogSource;

  constructor(root: string, opts?: { subdir?: string; source?: MemoryLogSource }) {
    const base = memoryDir(root);
    // 子目录形态（规格 §5）：子智能体自有记忆 memory/agents/<id>，与主目录互不干扰
    this.dirPath = opts?.subdir === undefined ? base : path.join(base, opts.subdir);
    this.source = opts?.source ?? 'system';
    fs.mkdirSync(this.dirPath, { recursive: true });
  }

  /** 变更历史追加（OKF log 件收口）：追加只增、失败旁路降级不阻断主写路径（记忆模块旁路纪律同款） */
  private appendLog(op: MemoryLogEvent['op'], extra?: { slug?: string; prevDigest?: string; newDigest?: string }): void {
    const event: MemoryLogEvent = { ts: new Date().toISOString(), op, source: this.source, ...extra };
    try {
      fs.appendFileSync(path.join(this.dirPath, LOG_NAME), `${JSON.stringify(event)}\n`);
    } catch (e) {
      console.error(`[memory] log append failed (op=${op}):`, e);
    }
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
    return readMemoryIndex(this.dirPath);
  }

  /**
   * 写入一条记录：归一化三级去重（slug / description / body 任一归一相同即拒）→ 撞名追加 -2/-3… →
   * 写记录文件 → 全量重建索引 → 超限判定（已写盘但返回 MEMORY_INDEX_OVER_LIMIT，CC 语义）。
   */
  add(input: { type: MemoryType; description: string; body: string; created?: string; links?: string[]; supersededBy?: string }): Result<MemoryRecord> {
    const description = input.description.trim();
    const body = input.body.trim();
    if (!description || !body) return fail('MEMORY_EMPTY', 'Memory description and body must not be empty');
    const candidate = slugifyMemory(description);
    const duplicate = this.list().find(
      (r) =>
        r.slug === candidate ||
        normalizeText(r.description) === normalizeText(description) ||
        normalizeText(r.body) === normalizeText(body),
    );
    if (duplicate) return fail('MEMORY_DUPLICATE', `duplicate: ${candidate}`);

    // 索引名避让（Fix round 1）：空目录下 `has('MEMORY')` 为假、既有避让循环不生效，故起始候选先改 memo
    const base = isSafeSlug(candidate) ? candidate : 'memo';
    let slug = base;
    for (let n = 2; this.has(slug); n += 1) slug = `${base}-${n}`;
    const created = input.created ?? new Date().toISOString().slice(0, 10);
    const modified = new Date().toISOString();
    const wiki = wikiFields(input.links, input.supersededBy);
    fs.writeFileSync(path.join(this.dirPath, `${slug}.md`), serialize({ type: input.type, created, modified, description, body, ...wiki }));
    this.rebuildIndex();
    this.appendLog('add', { slug, newDigest: bodyDigest(body) });

    const record: MemoryRecord = { slug, type: input.type, created, modified, description, body, ...wiki };
    const over = this.overLimit();
    if (over !== null) return fail('MEMORY_INDEX_OVER_LIMIT', over);
    return ok(record);
  }

  /**
   * 按既有 slug 写入（会中自写路径，规格 §5）：同 slug 视为**更新**（去重自排除、保留 created、刷新 modified），
   * 不存在则创建。存在的价值：模型改写一条记忆不产生 -2 副本。超限语义与 add 一致（写成功 + 报错勒令精简）。
   * Wiki 字段（links/supersededBy）未传=保留既有值（update/整理路径不抹链接）；显式传空数组/空串=清除。
   */
  put(input: { slug: string; type: MemoryType; description: string; body: string; created?: string; modified?: string; links?: string[]; supersededBy?: string }): Result<MemoryRecord> {
    const slug = input.slug.trim();
    const description = input.description.trim();
    const body = input.body.trim();
    if (!slug) return fail('MEMORY_EMPTY', 'slug must not be empty');
    // 校验先于任何去重/写盘/路径拼接：slug 直接拼进文件名，未净化入口可越出记忆目录或撞索引名
    if (!isSafeSlug(slug)) return failSlugInvalid<MemoryRecord>();
    if (!description || !body) return fail('MEMORY_EMPTY', 'Memory description and body must not be empty');
    const existing = this.list().find((r) => r.slug === slug);
    const duplicate = this.list().find(
      (r) =>
        r.slug !== slug &&
        (normalizeText(r.description) === normalizeText(description) || normalizeText(r.body) === normalizeText(body)),
    );
    if (duplicate) return fail('MEMORY_DUPLICATE', `duplicate: ${duplicate.slug}`);

    const created = input.created ?? existing?.created ?? new Date().toISOString().slice(0, 10);
    const modified = input.modified ?? new Date().toISOString();
    const wiki = wikiFields(input.links ?? existing?.links, input.supersededBy ?? existing?.supersededBy);
    fs.writeFileSync(path.join(this.dirPath, `${slug}.md`), serialize({ type: input.type, created, modified, description, body, ...wiki }));
    this.rebuildIndex();
    this.appendLog('put', { slug, prevDigest: existing ? bodyDigest(existing.body) : undefined, newDigest: bodyDigest(body) });

    const record: MemoryRecord = { slug, type: input.type, created, modified, description, body, ...wiki };
    const over = this.overLimit();
    if (over !== null) return fail('MEMORY_INDEX_OVER_LIMIT', over);
    return ok(record);
  }

  remove(slug: string): Result<void> {
    // 删除同为拼名入口（Fix round 1）：防逃逸删除；合法 slug 但不存在仍走 MEMORY_NOT_FOUND
    if (!isSafeSlug(slug)) return failSlugInvalid<void>();
    const file = path.join(this.dirPath, `${slug}.md`);
    if (!fs.existsSync(file)) return fail('MEMORY_NOT_FOUND', `no such memory: ${slug}`);
    const existing = this.list().find((r) => r.slug === slug);
    fs.rmSync(file);
    this.rebuildIndex();
    this.appendLog('remove', { slug, prevDigest: existing ? bodyDigest(existing.body) : undefined });
    return ok(undefined);
  }

  /**
   * 整理回滚备份原语（D26/J10，收编自 consolidate 的 .bak 裸 fs 手术，控制流逐字节等价）：
   * 先清退旧快照（只保留本次一份）→ 建本次 .bak-<时间戳> 目录 → 拷入当前目录全部普通文件
   * （子目录与 .bak-* 一概不拷——备份对象是记录文件集）。返回备份目录绝对路径句柄，
   * 供 restore（失败回滚）或 clearBackup（成功清理）消费。
   */
  backup(): string {
    for (const f of fs.readdirSync(this.dirPath)) {
      if (f.startsWith(BAK_PREFIX)) fs.rmSync(path.join(this.dirPath, f), { recursive: true, force: true });
    }
    const bak = path.join(this.dirPath, `${BAK_PREFIX}${Date.now()}`);
    fs.mkdirSync(bak, { recursive: true });
    for (const f of fs.readdirSync(this.dirPath)) {
      if (f.startsWith(BAK_PREFIX) || f === LOG_NAME) continue;
      const p = path.join(this.dirPath, f);
      if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(bak, f));
    }
    this.appendLog('backup', { slug: path.basename(bak) });
    return bak;
  }

  /**
   * 从备份精确还原（失败回滚路径）：清空当前目录非 .bak 项（含失败半成品与异形条目如被占位的
   * MEMORY.md 目录，recursive 强删）→ 从备份整体拷回 → 删除备份目录（回滚即消费备份）。
   * 句柄须为 backup() 返回值；还原过程中 fs 意外异常照原样冒泡（与原内联控制流一致）。
   */
  restore(bak: string): void {
    for (const f of fs.readdirSync(this.dirPath)) {
      // topics/ 是派生物不入快照——还原不清退它，否则还原后的 MEMORY.md 主题段指向已删页（整理先回滚再写主题页，二者不交叉）
      if (f.startsWith(BAK_PREFIX) || f === LOG_NAME || f === TOPICS_DIR) continue;
      fs.rmSync(path.join(this.dirPath, f), { recursive: true, force: true });
    }
    for (const f of fs.readdirSync(bak)) {
      if (f === LOG_NAME) continue;
      fs.copyFileSync(path.join(bak, f), path.join(this.dirPath, f));
    }
    fs.rmSync(bak, { recursive: true, force: true });
    this.appendLog('restore', { slug: path.basename(bak) });
  }

  /** 成功路径清理（写入全部落定后由调用方调用）：删备份目录，不留残渣；不动当前目录内容 */
  clearBackup(bak: string): void {
    fs.rmSync(bak, { recursive: true, force: true });
  }

  /** 索引全量重建（派生物语义：空集写空文件，保持文件存在形态统一）。
   *  行形态为 Markdown 链接（2026-10-02 用户裁决「做成这样的 md 链接」）：`- [description](<slug>.md)：正文单行化说明`
   *  ——编辑器浏览时链接可点击直达记录文件；正文空白折叠防多行 body 破坏一行一条纪律（容量两级按非空行计数口径不变，
   *  头部 `# Memory Index` 计 1 行即有效容量 199，量级无感）；type 不进索引行（记录 frontmatter 为单一事实源）。
   *  Wiki 两段（2026-11-09）：topics/ 有页时分「## Topics」主题段（一句话，不内联正文）+「## Records」散条段
   *  （仅未归入任何主题的记录，沿用上述行形态）——归入主题的记录经主题页按需读取，注入体积随主题化收敛；
   *  无主题页时输出与旧形态逐字节一致。supersededBy 非空的记录恒不进索引（已被取代，文件仍在供追溯）。 */
  rebuildIndex(): void {
    const topics = this.listTopics();
    const filed = new Set(topics.flatMap((t) => t.slugs));
    const recordLine = (r: MemoryRecord): string => {
      const note = r.body.replace(/\s+/g, ' ').trim();
      return note.length > 0 ? `- [${r.description}](${r.slug}.md)：${note}` : `- [${r.description}](${r.slug}.md)`;
    };
    const live = this.list().filter((r) => r.supersededBy === undefined);
    let text: string;
    if (topics.length === 0) {
      const lines = live.map(recordLine);
      text = lines.length > 0 ? `# Memory Index\n\n${lines.join('\n')}\n` : '';
    } else {
      const topicLines = topics.map((t) => `- [${t.name}](${TOPICS_DIR}/${t.file})：${t.description}`);
      const scatter = live.filter((r) => !filed.has(r.slug)).map(recordLine);
      text = `# Memory Index\n\n## Topics\n${topicLines.join('\n')}\n` + (scatter.length > 0 ? `\n## Records\n${scatter.join('\n')}\n` : '');
    }
    fs.writeFileSync(path.join(this.dirPath, INDEX_NAME), text);
  }

  /** 主题页清单（读 topics/ 下各页 frontmatter：name/description/slugs）；目录缺失/坏页跳过——派生物读失败不击穿索引 */
  listTopics(): Array<{ file: string; name: string; description: string; slugs: string[] }> {
    const dir = path.join(this.dirPath, TOPICS_DIR);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
    } catch {
      return [];
    }
    const out: Array<{ file: string; name: string; description: string; slugs: string[] }> = [];
    for (const file of names) {
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(dir, file), 'utf8');
      } catch {
        continue;
      }
      const parsed = parseMemoryFrontmatter(raw, { lenient: false });
      if (parsed === null) continue;
      const slugs = (parsed.meta.slugs ?? '').split(',').map((s) => s.trim()).filter((s) => isSafeSlug(s));
      out.push({ file, name: parsed.meta.name ?? file.slice(0, -3), description: parsed.meta.description ?? '', slugs });
    }
    return out;
  }

  /**
   * 主题页整目录重建（Wiki 层写原语，整理面消费）：清空 topics/ → 逐页写 `<slugify(name)>.md`
   * （frontmatter name/description/slugs + 综述正文 + 归属记录链接行）→ 重建索引 → log 记 topics 事件。
   * 归属 slug 只保留真实存在的记录（悬空滤除），归属为空的主题整页不写；同名折叠撞名追加 -2。
   * 主题页是派生物：失败抛出由调用方旁路降级，记录文件零触碰。
   */
  writeTopics(topics: readonly MemoryTopic[]): void {
    const dir = path.join(this.dirPath, TOPICS_DIR);
    fs.rmSync(dir, { recursive: true, force: true });
    const records = new Map(this.list().map((r) => [r.slug, r]));
    const used = new Set<string>();
    let written = 0;
    for (const t of topics) {
      const name = t.name.replace(/\s+/g, ' ').trim();
      const slugs = [...new Set(t.slugs)].filter((s) => records.has(s));
      if (name.length === 0 || slugs.length === 0) continue;
      const base = slugifyMemory(name);
      let file = base;
      for (let n = 2; used.has(file); n += 1) file = `${base}-${n}`;
      used.add(file);
      const links = slugs.map((s) => `- [${records.get(s)!.description}](../${s}.md)`);
      const page = [
        '---',
        `name: ${name}`,
        `description: ${t.description.replace(/\s+/g, ' ').trim()}`,
        `slugs: ${slugs.join(', ')}`,
        '---',
        t.summary.trim(),
        '',
        ...links,
        '',
      ].join('\n');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${file}.md`), page);
      written += 1;
    }
    this.rebuildIndex();
    this.appendLog('topics', { slug: String(written) });
  }

  /** 近满提醒（规格 §6 两级容量：近满=提醒、超限=错误）：行数或字节数任一 ≥80% 返回提醒文本，否则 null */
  capacityNotice(): string | null {
    const text = this.indexText();
    const lines = text.split('\n').filter((l: string) => l.length > 0).length;
    const bytes = Buffer.byteLength(text, 'utf8');
    const nearLines = Math.floor(MEMORY_INDEX_MAX_LINES * NEAR_LIMIT_RATIO);
    const nearBytes = Math.floor(MEMORY_INDEX_MAX_BYTES * NEAR_LIMIT_RATIO);
    if (lines < nearLines && bytes < nearBytes) return null;
    return `Memory index near limit: ${lines}/${MEMORY_INDEX_MAX_LINES} lines, ${bytes}/${MEMORY_INDEX_MAX_BYTES} bytes — merge entries or move detail into record bodies`;
  }

  /** 容量纪律：超 200 行或 25KB 返回勒令精简报错文本（含当前行数/字节数与上限），否则 null */
  overLimit(): string | null {
    const text = this.indexText();
    const lines = text.split('\n').filter((l: string) => l.length > 0).length;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (lines > MEMORY_INDEX_MAX_LINES) {
      return `Index has ${lines} lines (limit ${MEMORY_INDEX_MAX_LINES}) and ${bytes} bytes — merge entries or move detail into record bodies, then rebuild the index`;
    }
    if (bytes > MEMORY_INDEX_MAX_BYTES) {
      return `Index has ${lines} lines, ${bytes} bytes (limit ${MEMORY_INDEX_MAX_BYTES} bytes) — merge entries or move detail into record bodies, then rebuild the index`;
    }
    return null;
  }
}

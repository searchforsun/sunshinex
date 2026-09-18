/**
 * 记忆写入接缝（规格 §4.3，原子工具路径的唯一权威）：模型经既有 `write` 工具写 `<dataDir>/memory/**` 时的
 * 校验 → 落盘 → 规范化 → 重建索引 → 容量回执 单点。非记忆路径一律 `'pass'` 交回常规写入（零副作用）。
 *
 * 落盘口径（编排跨任务决策，2026-09-18）：记录文件一律经调用方传入的 `write` 回调（builtin 传 `backend.writeFile`，
 * 含父目录创建），本模块不直接 `fs.writeFileSync` 落记录——后端抽象（process/docker/ssh）不得被绕开。
 * 索引 `MEMORY.md` 是派生物，仍由 `MemoryStore.rebuildIndex()` 单点重建；规范化/去重/容量口径复用 MemoryStore 原语。
 * 校验**先于**写入（不落盘即无需回滚），杜绝垃圾文件进索引。
 *
 * 旁路纪律：接缝失败以带码失败或异常形式浮出（builtin 转 CodedToolError → 工具侧可读错误），**绝不吞成 `'pass'`**
 * ——那会让未校验的原文绕过闸门落进记忆目录（fail-closed：接缝异常即写入被拒）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { pick } from '../../i18n';
import { Result, ok, fail } from '../../result';
import { resolveDataDir } from '../../config/data-dir';
import { MEMORY_INDEX_MAX_LINES, MemoryStore, MemoryType, normalizeText, slugifyMemory } from './store';
import { scanMemoryText } from './extractor';
import { isMemoryPath, MemoryScope } from './paths';

const INDEX_NAME = 'MEMORY.md';
const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

export interface MemoryWriteRequest {
  root: string;
  absPath: string;
  content: string;
  /** 记忆写 scope：仅接 `safety.memoryScope`（`undefined | agents/<id>`）；**禁止传 `'main'`**（等价全拒，非设计意图） */
  scope?: MemoryScope;
  /** 落盘回调（builtin 传 backend.writeFile）：接缝负责顺序与校验，落盘走后端接缝 */
  write: (absPath: string, content: string) => void;
}

export interface MemoryWriteOutcome {
  slug: string;
  kind: 'main' | `agents/${string}`;
  observation: string;
}

export type MemoryWriteSeam = (req: MemoryWriteRequest) => Result<MemoryWriteOutcome | 'pass'>;

/**
 * 数据目录真实路径（与安全链判界口径同源，2026-09-18 M3 审查裁决）：存在段逐级 realpathSync 归一、新建段字面拼接、异常按字面兜底。
 * **不得**直接用字面 `resolveDataDir(req.root)` 比对——链注入的 `req.absPath` 是 realpath 归一后的真实路径（chain.resolveSafe 的 safePath），
 * 数据目录自身含符号链接段（macOS /var、HOME 经链接）时字面比对不命中，会把合法记忆写入误判成 `'pass'` 而绕开校验。
 * 安全链的 `SafetyChain` 已有同语义私有单点；本模块独立实现同一策略（不导出私有方法，避免安全层反向暴露）。
 */
function dataDirReal(root: string): string {
  const dir = resolveDataDir(root);
  try {
    let anchor = dir;
    while (anchor.length > 1 && !fs.existsSync(anchor)) anchor = path.dirname(anchor);
    return fs.realpathSync(anchor) + dir.slice(anchor.length);
  } catch {
    return dir;
  }
}

/** 窄 frontmatter 解析（记忆记录四键；无 frontmatter 返回 null） */
function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } | null {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(md);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

/**
 * 记录序列化（四键顺序 type/created/modified/description + 正文，与 `MemoryStore` 的私有 `serialize` 同形）：
 * 落盘经后端回调（决策口径）后无法复用 store 内部写盘路径，故此处复制同一形态；
 * `MEMORY.md` 索引由 store 单点重建、记录解析亦由 store 单点完成，两模块格式一致性由 writer.test「store 解析回读」用例钉住。
 */
function serializeRecord(rec: { type: MemoryType; created: string; modified: string; description: string; body: string }): string {
  return ['---', `type: ${rec.type}`, `created: ${rec.created}`, `modified: ${rec.modified}`, `description: ${rec.description}`, '---', rec.body, ''].join('\n');
}

/** 索引有效行数（空行不计；回执与容量口径同 store） */
function indexLines(store: MemoryStore): number {
  return store.indexText().split('\n').filter((l) => l.length > 0).length;
}

export function guardMemoryWrite(req: MemoryWriteRequest): Result<MemoryWriteOutcome | 'pass'> {
  const dataDir = dataDirReal(req.root);
  const kind = isMemoryPath(dataDir, req.absPath, req.scope);
  if (kind === null) return ok('pass'); // 非记忆路径：交回常规写入

  const name = path.basename(req.absPath);
  if (!name.endsWith('.md')) {
    return fail('MEMORY_WRITE_EXT', pick('Memory records must be .md files', '记忆记录必须是 .md 文件'));
  }
  // 索引名排他（大小写不敏感）：不区分大小写的文件系统上 `memory.md` 与派生索引是同一文件，写进去即覆盖索引
  if (name === INDEX_NAME || name.toLowerCase() === INDEX_NAME.toLowerCase()) {
    return fail(
      'MEMORY_WRITE_INDEX',
      pick(
        'MEMORY.md is a derived index — write one record file per fact instead (delete or merge records to shrink it)',
        'MEMORY.md 是派生索引——请每条事实写一个记录文件（要精简就删或合并记录）',
      ),
    );
  }
  const slug = name.slice(0, -3);
  if (slug.length === 0 || slugifyMemory(slug) !== slug) {
    return fail(
      'MEMORY_WRITE_SLUG',
      pick(`Record file name must be a canonical slug (got "${slug}"; e.g. "prefers-pnpm")`, `记录文件名必须是规范化 slug（当前 "${slug}"；形如 "prefers-pnpm"）`),
    );
  }
  const flagged = scanMemoryText(req.content);
  if (flagged) {
    return fail(
      'MEMORY_WRITE_SCAN',
      pick(`Rejected: session-scoped or unsafe content (${flagged}); nothing written`, `已拒绝：会话性内容或含注入特征（${flagged}），未写入`),
    );
  }
  const parsed = parseFrontmatter(req.content);
  if (parsed === null) {
    return fail(
      'MEMORY_WRITE_FRONTMATTER',
      pick('Record must start with YAML frontmatter: type, description', '记录必须以 YAML frontmatter 开头：type、description'),
    );
  }
  const type = parsed.meta.type as MemoryType | undefined;
  if (type === undefined || !MEMORY_TYPES.includes(type)) {
    return fail(
      'MEMORY_WRITE_TYPE',
      pick(`frontmatter type must be one of ${MEMORY_TYPES.join('|')}`, `frontmatter type 必须是 ${MEMORY_TYPES.join('|')} 之一`),
    );
  }
  const description = (parsed.meta.description ?? '').trim();
  if (!description) {
    return fail('MEMORY_WRITE_DESCRIPTION', pick('frontmatter description is required', 'frontmatter 缺少 description'));
  }
  const body = parsed.body.trim();
  if (!body) return fail('MEMORY_WRITE_BODY', pick('Record body is empty', '记录正文为空'));

  const subdir = kind === 'main' ? undefined : kind;
  const store = new MemoryStore(req.root, subdir === undefined ? undefined : { subdir });
  const records = store.list();
  const existing = records.find((r) => r.slug === slug);
  // 跨记录三级去重（与 MemoryStore.put 同一闸门与文案）：同 slug 为更新（自排除），他名同 description/正文即拒
  const duplicate = records.find(
    (r) => r.slug !== slug && (normalizeText(r.description) === normalizeText(description) || normalizeText(r.body) === normalizeText(body)),
  );
  if (duplicate) return fail('MEMORY_DUPLICATE', `duplicate: ${duplicate.slug}`);

  const created = existing !== undefined && existing.created.length > 0 ? existing.created : new Date().toISOString().slice(0, 10);
  const modified = new Date().toISOString();
  // 落点＝本记录面内的规范路径 <记录目录>/<slug>.md（记录面由 kind 定：主记忆目录或 agents/<id>/ 一层；
  // 其下嵌套不构成独立记录面，故一律归拢回本面记录目录——保证「索引与记录一致」不变式（重建索引只扫本面直属文件）
  // 与「同 slug 更新不产副本」语义在嵌套请求下同样成立）
  req.write(path.join(store.dir(), `${slug}.md`), serializeRecord({ type, created, modified, description, body }));
  store.rebuildIndex();

  // 容量两级（规格 §6）：超限=记录已写盘但报错勒令精简（CC 语义）；近满=照写并在回执追加提醒
  const over = store.overLimit();
  if (over !== null) return fail('MEMORY_INDEX_OVER_LIMIT', over);
  const near = store.capacityNotice();
  const observation = [
    pick(`Saved memory: ${slug} [${type}] — ${indexLines(store)}/${MEMORY_INDEX_MAX_LINES} index lines`, `已保存记忆：${slug} [${type}] — 索引 ${indexLines(store)}/${MEMORY_INDEX_MAX_LINES} 行`),
    ...(near !== null ? [near] : []),
  ].join('\n');
  return ok({ slug, kind, observation });
}

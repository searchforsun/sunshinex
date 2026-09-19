/**
 * 记忆写入接缝（规格 §4.3，原子工具路径的唯一权威）：模型经既有 `write` 工具写 `<dataDir>/memory/**` 时的
 * 校验 → 落盘 → 规范化 → 重建索引 → 容量回执 单点。非记忆路径一律 `'pass'` 交回常规写入（零副作用）。
 *
 * 落盘口径（2026-09-18 用户裁决「单一实现、最简实现、不要兼容」）：记录落盘**只有一条**实现——`MemoryStore.put`
 * （规范化四键 / 同 slug 更新语义 / 三级去重 / 容量两级 / 索引重建全在其中），接缝不复制这些语义、也不引入落盘回调参数。
 * 校验先于写入（不落盘即无需回滚）；`put` 内部写盘走该项目既有的记录落盘路径（本项目 process 后端即 fs）。
 *
 * 旁路纪律：接缝失败以带码失败或异常形式浮出（builtin 转 CodedToolError → 工具侧可读错误），**绝不吞成 `'pass'`**
 * ——那会让未校验的原文绕过闸门落进记忆目录（fail-closed：接缝异常即写入被拒）。
 */
import * as path from 'path';
import { Result, ok, fail } from '../../result';
import { dataDirReal } from '../../config/data-dir';
import { MEMORY_INDEX_MAX_LINES, MemoryStore, MemoryType, slugifyMemory } from './store';
import { scanMemoryText } from './guards';
import { isMemoryPath, MemoryScope } from './paths';

const INDEX_NAME = 'MEMORY.md';
const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

export interface MemoryWriteRequest {
  root: string;
  absPath: string;
  content: string;
  /**
   * 记忆写 scope：只接 `safety.memoryScope`——`undefined`（主链，可写 memory/** 整子树）或 `agents/<id>`（子代理收窄）。
   * **类型上排除 `'main'`**：`'main'` 在 `isMemoryPath` 下等价全拒 → 接缝判类返回 `null` → `'pass'` → 裸写绕过六道闸门
   * （失效方向 fail-open），故把契约从注释升为编译期约束，不靠 `as` 掩盖。
   */
  scope?: Exclude<MemoryScope, 'main'>;
}

export interface MemoryWriteOutcome {
  slug: string;
  kind: 'main' | `agents/${string}`;
  observation: string;
}

export type MemoryWriteSeam = (req: MemoryWriteRequest) => Result<MemoryWriteOutcome | 'pass'>;

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

export function guardMemoryWrite(req: MemoryWriteRequest): Result<MemoryWriteOutcome | 'pass'> {
  const dataDir = dataDirReal(req.root);
  const kind = isMemoryPath(dataDir, req.absPath, req.scope);
  if (kind === null) return ok('pass'); // 非记忆路径：交回常规写入

  const name = path.basename(req.absPath);
  if (!name.endsWith('.md')) {
    return fail('MEMORY_WRITE_EXT', 'Memory records must be .md files');
  }
  // 索引名排他（大小写不敏感）：不区分大小写的文件系统上 `memory.md` 与派生索引是同一文件，写进去即覆盖索引
  if (name === INDEX_NAME || name.toLowerCase() === INDEX_NAME.toLowerCase()) {
    return fail(
      'MEMORY_WRITE_INDEX',
      'MEMORY.md is a derived index — write one record file per fact (merge or delete records to slim it down)',
    );
  }
  const slug = name.slice(0, -3);
  if (slug.length === 0 || slugifyMemory(slug) !== slug) {
    return fail(
      'MEMORY_WRITE_SLUG',
      `Record file name must be a canonical slug (got "${slug}"; e.g. "prefers-pnpm")`,
    );
  }
  const flagged = scanMemoryText(req.content);
  if (flagged) {
    return fail(
      'MEMORY_WRITE_SCAN',
      `Rejected: session-scoped or unsafe content (${flagged}); nothing written`,
    );
  }
  const parsed = parseFrontmatter(req.content);
  if (parsed === null) {
    return fail(
      'MEMORY_WRITE_FRONTMATTER',
      'Record must start with YAML frontmatter: type, description',
    );
  }
  const type = parsed.meta.type as MemoryType | undefined;
  if (type === undefined || !MEMORY_TYPES.includes(type)) {
    return fail(
      'MEMORY_WRITE_TYPE',
      `frontmatter type must be one of ${MEMORY_TYPES.join('|')}`,
    );
  }
  const description = (parsed.meta.description ?? '').trim();
  if (!description) {
    return fail('MEMORY_WRITE_DESCRIPTION', 'frontmatter description is required');
  }
  const body = parsed.body.trim();
  if (!body) return fail('MEMORY_WRITE_BODY', 'Record body is empty');

  const subdir = kind === 'main' ? undefined : kind;
  const store = new MemoryStore(req.root, subdir === undefined ? undefined : { subdir });
  // 落盘唯一实现（2026-09-18 用户裁决「单一实现」）：记录面由 kind 定（主记忆目录或 agents/<id>/ 一层），`put` 只写本面
  // `<slug>.md`，故其下嵌套请求天然归拢回本面记录目录——「索引＝本面记录派生物」不变式与「同 slug 更新不产 -2 副本」
  // 在嵌套请求下同样成立；规范化四键 / 同 slug=更新（保留 created、刷新 modified）/ 三级去重 / 超限判定 / 索引重建全在 put 单点完成。
  const existing = store.list().find((r) => r.slug === slug);
  const put = store.put({
    slug,
    type,
    description,
    body,
    ...(existing ? { created: existing.created } : {}),
    modified: new Date().toISOString(),
  });
  // put 失败码原样浮出（跨记录去重 MEMORY_DUPLICATE；超限 MEMORY_INDEX_OVER_LIMIT＝记录已写盘 + 勒令精简，CC 语义）
  if (!put.ok) return fail(put.error.code, put.error.message);

  // 容量近满（规格 §6）：照写，回执追加提醒（超限已由 put 定论并浮出）
  const lines = store.indexText().split('\n').filter((l) => l.length > 0).length;
  const near = store.capacityNotice();
  const observation = [
    `Saved memory: ${slug} [${type}] — ${lines}/${MEMORY_INDEX_MAX_LINES} index lines`,
    ...(near !== null ? [near] : []),
  ].join('\n');
  return ok({ slug, kind, observation });
}

import type { ModelAdapter } from '../../model/adapter';
import { isModelSummarizer } from '../context/summarizer';
import { buildConsolidationPrompt, CONSOLIDATE_TOOLS } from '../prompts/memory';
import { MemoryStore, MemoryTopic, MemoryType, MEMORY_CONSOLIDATE_THRESHOLD, normalizeText, slugifyMemory, isSafeSlug } from './store';
/**
 * 整理管线（auto memory 规格 §5）：任务收口（settleMemory 尾部）与 /memory gc 双入口共用本函数。
 * 语义=模型清洗合并（一行一条/合并重复/冲突以新覆旧 supersede/消解残留指代——防线③二次清洗），
 * 并随整理生成 Wiki 组织：条目 links 互联、superseded_by 显式保留链、topics/ 主题综述页（均派生物）。
 * 保护闸：输出条数 > 输入拒绝（整理只减不增）、畸形载荷拒绝、落盘意外异常从 .bak 快照回滚；
 * 未应用（模型不出牌/载荷畸形/只减不增违反/回滚）经 notify 浮出一行说明——否则阈值以上每次收口
 * 静默重试注定失败的整理，白烧模型调用且无人知晓（2026-10-02 修复）。
 * 模型引用协议：模型不知真实 slug，载荷内以自造短 id 句柄互引（links/superseded_by/topics.ids），
 * 落盘时映射为最终 slug（description 折叠），悬空引用滤除。
 */

interface MergedCandidate {
  id?: unknown;
  type?: unknown;
  description?: unknown;
  body?: unknown;
  links?: unknown;
  superseded_by?: unknown;
}

export async function consolidateMemory(opts: {
  model: ModelAdapter;
  root: string;
  force?: boolean;
  notify?: (line: string) => void;
}): Promise<void> {
  const skipped = (reason: string): void => {
    opts.notify?.(`[memory] consolidation not applied (${reason}); the store is unchanged — it retries on the next task settle or via /memory gc`);
  };
  try {
    if (!isModelSummarizer(opts.model)) return; // 门禁同提取：Stub/Scripted 静默跳过
    const store = new MemoryStore(opts.root, { source: 'consolidate' });
    const before = store.list();
    if (before.length === 0) return;
    if (!opts.force && before.length < MEMORY_CONSOLIDATE_THRESHOLD) return; // 阈值未达零调用零副作用（force=/memory gc 显式入口）
    const chat = opts.model.chat;
    if (!chat) return; // 门禁同提取：无 chat 面静默跳过
    const res = await chat.call(opts.model, {
      messages: [{ role: 'user', content: buildConsolidationPrompt(before, new Date().toISOString().slice(0, 10)) }],
      tools: CONSOLIDATE_TOOLS,
    });
    const call = res.toolCalls.find((t) => t.name === 'submit_memory_items');
    const parsed = call ? parseMergedPayload(call.argsJson) : null;
    if (!parsed) return skipped(call ? 'malformed consolidation payload' : 'model returned no consolidation payload');
    const valid = parsed.items.map(normalizeEntry).filter((e): e is ConsolidatedEntry => e !== null);
    if (valid.length === 0) return skipped('empty merged set');
    if (valid.length > before.length) return skipped('merged set larger than input (only-reduce violated)'); // 只减不增
    applyMerged(store, valid, parsed.topics);
    applyTopics(store, valid, parsed.topics, opts.notify);
  } catch {
    skipped('apply failed and was rolled back');
  }
}

/** 应用合并集（差分应用，2026-10-02 修复）：先经 store.backup() 整目录快照 → 删除未被输出集代表的既有记录 →
 *  逐条 put 回写。三处针对性修正——
 *  ① 保 created：输出条目按 slug/归一 description/归一 body 命中既有记录即继承其 created（created 是
 *     整理判 stale 的唯一时效依据，全删全写会把它抹平成整理当天，摧毁时效信号）；
 *  ② 保 slug：命中既有记录的原位 put 更新（同 slug 语义），未变条目文件名不换——上下文冻结快照里的
 *     slug 继续有效，slug 失联只发生在真正被合并改写的条目；
 *  ③ 单条失败跳过不回滚：跨例目重复（MEMORY_DUPLICATE）等条目级失败只丢该条，不再整批回滚——
 *     旧实现的 throw→回滚会让同一失败在阈值以上每次收口重演（静默重试循环）。
 *  意外 fs 异常仍走 store.restore() 回滚（清当前→拷回→删备份），成功后 clearBackup 清快照——
 *  .bak 命名与目录级 fs 手术已收编为 store 原语（D26/J10），本函数只持句柄编排控制流。 */
function applyMerged(store: MemoryStore, records: ConsolidatedEntry[], topics: unknown): void {
  const before = store.list();
  const bak = store.backup(); // 旧快照清退 + 全量普通文件拷入（目录级知识归 store）
  try {
    // 输出集 → 既有记录的承接关系（slug 命中或归一 description/body 命中即同一事实）：承接者继承 created
    // （时效信号），slug 相异时旧文件随差分删除——同事实换名 = 原位换稿不并存（否则旧记录留下、新记录
    // 被三级去重挡掉，模型改写的事实会静默丢失）；「不在 keep 集」的既有记录删除（只减不增上限已守住）
    const keep = new Set<string>();
    const createdOf: Array<string | undefined> = records.map((r) => {
      const slug = slugifyMemory(r.description);
      const ex = before.find(
        (e) =>
          e.slug === slug ||
          normalizeText(e.description) === normalizeText(r.description) ||
          normalizeText(e.body) === normalizeText(r.body),
      );
      if (ex === undefined) return undefined;
      if (ex.slug === slug) keep.add(ex.slug);
      return ex.created;
    });
    for (const e of before) {
      if (!keep.has(e.slug)) store.remove(e.slug);
    }
    // Wiki 引用映射：id → 最终 slug（与落盘同一折叠源，落盘前即可解析；未知 id/自引在此天然滤除——落盘后再滤悬空）
    const idToSlug = new Map<string, string>();
    for (const r of records) {
      if (typeof r.id === 'string' && r.id.length > 0) {
        const candidate = slugifyMemory(r.description);
        idToSlug.set(r.id, isSafeSlug(candidate) ? candidate : 'memo');
      }
    }
    const resolveIds = (ids: string[], self: string | undefined): string[] => {
      // 按「计划 slug 全集」解析（条目落盘顺序无关）；条目级失败留下的死链由落盘后的清偿 pass 滤除
      const planned = new Set(records.map((r) => {
        const candidate = slugifyMemory(r.description);
        return isSafeSlug(candidate) ? candidate : 'memo';
      }));
      return [...new Set(ids)].filter((id) => id !== self && idToSlug.has(id)).map((id) => idToSlug.get(id)!).filter((s) => planned.has(s));
    };
    records.forEach((r, i) => {
      const candidate = slugifyMemory(r.description);
      const slug = isSafeSlug(candidate) ? candidate : 'memo'; // 索引名避让与 add 同口径（如 description 折叠出 memory）
      const created = createdOf[i];
      // put 条目级失败（跨例目重复 MEMORY_DUPLICATE / 超限勒令精简=已写盘）一律跳过该条继续——
      // 不回滚整批（见函数注释③）；只有 fs 意外异常走 throw→.bak 回滚。
      // Wiki 字段显式传（空=清除）：整理是 Wiki 组织的唯一权威，旧链接不继承、以本次载荷为准
      store.put({
        slug,
        type: coerceType(r.type), // 模型幻觉 type 收编（旧路径不校验会原样写进 frontmatter）
        description: r.description,
        body: r.body,
        ...(created !== undefined ? { created } : {}),
        links: resolveIds(r.links ?? [], r.id),
        supersededBy: r.supersededBy !== undefined ? resolveIds([r.supersededBy], r.id)[0] : undefined,
      });
    });
    store.rebuildIndex();
    // 死链清偿：条目级失败被跳过的目标 slug 在链接里留下的悬空引用，此处一次性滤除（多数落盘全部成功时零开销）
    const present = new Set(store.list().map((r) => r.slug));
    for (const rec of store.list()) {
      if (rec.links === undefined) continue;
      const pruned = rec.links.filter((s) => present.has(s));
      if (pruned.length !== rec.links.length) {
        store.put({ slug: rec.slug, type: rec.type, description: rec.description, body: rec.body, created: rec.created, links: pruned, supersededBy: rec.supersededBy });
      }
    }
    void topics; // 主题页在记录面落定后单独重建（applyTopics），失败旁路不回滚记录面
  } catch (e) {
    store.restore(bak); // 精确还原（清当前→拷回→删备份），目录级知识归 store
    throw e instanceof Error ? e : new Error(String(e)); // 外层 catch 收编为 notify 说明行
  }
  store.clearBackup(bak); // 成功：不留备份残渣
}

/** 主题页重建（记录面落定之后；失败旁路降级不回滚——主题页是派生物，下次整理重写即可）。
 *  topics 缺省/畸形=保持既有主题页不动（不因一次未出牌清空）；ids 映射与 applyMerged 同折叠口径 */
function applyTopics(store: MemoryStore, records: ConsolidatedEntry[], topics: unknown, notify?: (line: string) => void): void {
  if (!Array.isArray(topics)) return;
  const idToSlug = new Map<string, string>();
  for (const r of records) {
    if (typeof r.id === 'string' && r.id.length > 0) {
      const candidate = slugifyMemory(r.description);
      idToSlug.set(r.id, isSafeSlug(candidate) ? candidate : 'memo');
    }
  }
  const pages: MemoryTopic[] = [];
  for (const t of topics as unknown[]) {
    const o = (t ?? {}) as { name?: unknown; description?: unknown; summary?: unknown; ids?: unknown };
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const description = typeof o.description === 'string' ? o.description.trim() : '';
    const ids = Array.isArray(o.ids) ? o.ids.filter((x): x is string => typeof x === 'string') : [];
    if (name.length === 0 || description.length === 0 || ids.length === 0) continue;
    pages.push({ name, description, summary: typeof o.summary === 'string' ? o.summary : '', slugs: ids.flatMap((id) => (idToSlug.has(id) ? [idToSlug.get(id)!] : [])) });
  }
  if (pages.length === 0) return;
  try {
    store.writeTopics(pages);
  } catch (e) {
    notify?.(`[memory] topic pages not updated (${e instanceof Error ? e.message : String(e)}); records are committed — topics rebuild on the next consolidation`);
  }
}

/** 结构化载荷解析（items + 可选 topics）；畸形返回 null（静默保持原状）。
 *  topics 缺省（模型未出牌）= 保持既有主题页不动——主题页是派生物，不因一次未出牌的整理而清空 */
function parseMergedPayload(argsJson: string): { items: MergedCandidate[]; topics: unknown } | null {
  try {
    const obj = JSON.parse(argsJson) as { items?: unknown; topics?: unknown };
    if (!Array.isArray(obj.items)) return null;
    return { items: obj.items as MergedCandidate[], topics: obj.topics };
  } catch {
    return null;
  }
}

/** 整理条目有效形态（normalizeEntry 产物） */
interface ConsolidatedEntry {
  id?: string;
  type: unknown;
  description: string;
  body: string;
  links?: string[];
  supersededBy?: string;
}

/** 整理条目归一（有效性校验 + Wiki 字段容错一体）：description/body 非空字符串才收；
 *  id/links/superseded_by 形态不合法即视为未给（宁缺毋错，不因坏 Wiki 字段废整条） */
function normalizeEntry(c: MergedCandidate): ConsolidatedEntry | null {
  const description = typeof c.description === 'string' ? c.description.trim() : '';
  const body = typeof c.body === 'string' ? c.body.trim() : '';
  if (!description || !body) return null;
  if (normalizeText(description).length === 0 || normalizeText(body).length === 0) return null;
  const id = typeof c.id === 'string' && c.id.trim().length > 0 ? c.id.trim() : undefined;
  const links = Array.isArray(c.links) ? c.links.filter((x): x is string => typeof x === 'string') : undefined;
  const supersededBy = typeof c.superseded_by === 'string' && c.superseded_by.trim().length > 0 ? c.superseded_by.trim() : undefined;
  return {
    type: c.type,
    description,
    body,
    ...(id !== undefined ? { id } : {}),
    ...(links !== undefined && links.length > 0 ? { links } : {}),
    ...(supersededBy !== undefined ? { supersededBy } : {}),
  };
}

/** 类型归一：非法类型落 project（与 extractor 同口径；applyMerged 落盘前收编，frontmatter 恒四选一） */
export function coerceType(t: unknown): MemoryType {
  return t === 'user' || t === 'feedback' || t === 'reference' ? t : 'project';
}

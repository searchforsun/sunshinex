import * as fs from 'fs';
import * as path from 'path';
import type { ModelAdapter } from '../../model/adapter';
import { isModelSummarizer } from '../context/summarizer';
import { buildConsolidationPrompt, CONSOLIDATE_TOOLS } from '../prompts/memory';
import { MemoryStore, MemoryType, MEMORY_CONSOLIDATE_THRESHOLD, normalizeText, slugifyMemory, isSafeSlug } from './store';

/**
 * 整理管线（auto memory 规格 §5）：任务收口（settleMemory 尾部）与 /memory gc 双入口共用本函数。
 * 语义=模型清洗合并（一行一条/合并重复/冲突以新覆旧 supersede/消解残留指代——防线③二次清洗）。
 * 保护闸：输出条数 > 输入拒绝（整理只减不增）、畸形载荷拒绝、落盘意外异常从 .bak 快照回滚；
 * 未应用（模型不出牌/载荷畸形/只减不增违反/回滚）经 notify 浮出一行说明——否则阈值以上每次收口
 * 静默重试注定失败的整理，白烧模型调用且无人知晓（2026-10-02 修复）。
 */

interface MergedCandidate {
  type?: unknown;
  description?: unknown;
  body?: unknown;
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
    const store = new MemoryStore(opts.root);
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
    const valid = parsed.filter(isValidCandidate);
    if (valid.length === 0) return skipped('empty merged set');
    if (valid.length > before.length) return skipped('merged set larger than input (only-reduce violated)'); // 只减不增
    applyMerged(store, valid);
  } catch {
    skipped('apply failed and was rolled back');
  }
}

/** 应用合并集（差分应用，2026-10-02 修复）：先整目录 .bak 快照 → 删除未被输出集代表的既有记录 →
 *  逐条 put 回写。三处针对性修正——
 *  ① 保 created：输出条目按 slug/归一 description/归一 body 命中既有记录即继承其 created（created 是
 *     整理判 stale 的唯一时效依据，全删全写会把它抹平成整理当天，摧毁时效信号）；
 *  ② 保 slug：命中既有记录的原位 put 更新（同 slug 语义），未变条目文件名不换——上下文冻结快照里的
 *     slug 继续有效，slug 失联只发生在真正被合并改写的条目；
 *  ③ 单条失败跳过不回滚：跨例目重复（MEMORY_DUPLICATE）等条目级失败只丢该条，不再整批回滚——
 *     旧实现的 throw→回滚会让同一失败在阈值以上每次收口重演（静默重试循环）。
 *  意外 fs 异常仍走 .bak 回滚（快照→清当前→拷回），成功后清快照。 */
function applyMerged(store: MemoryStore, records: { type: unknown; description: string; body: string }[]): void {
  const before = store.list();
  // 旧快照清退（只保留本次一份）
  for (const f of fs.readdirSync(store.dir())) {
    if (f.startsWith('.bak-')) fs.rmSync(path.join(store.dir(), f), { recursive: true, force: true });
  }
  const bak = path.join(store.dir(), `.bak-${Date.now()}`);
  fs.mkdirSync(bak, { recursive: true });
  for (const f of fs.readdirSync(store.dir())) {
    if (f.startsWith('.bak-')) continue;
    const p = path.join(store.dir(), f);
    if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(bak, f));
  }
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
    records.forEach((r, i) => {
      const candidate = slugifyMemory(r.description);
      const slug = isSafeSlug(candidate) ? candidate : 'memo'; // 索引名避让与 add 同口径（如 description 折叠出 memory）
      const created = createdOf[i];
      // put 条目级失败（跨例目重复 MEMORY_DUPLICATE / 超限勒令精简=已写盘）一律跳过该条继续——
      // 不回滚整批（见函数注释③）；只有 fs 意外异常走 throw→.bak 回滚
      store.put({
        slug,
        type: coerceType(r.type), // 模型幻觉 type 收编（旧路径不校验会原样写进 frontmatter）
        description: r.description,
        body: r.body,
        ...(created !== undefined ? { created } : {}),
      });
    });
    store.rebuildIndex();
  } catch (e) {
    // 精确还原：先清当前目录内容（含失败半成品与异形条目如被占位的 MEMORY.md 目录），再从 .bak 整体拷回
    for (const f of fs.readdirSync(store.dir())) {
      if (f.startsWith('.bak-')) continue;
      fs.rmSync(path.join(store.dir(), f), { recursive: true, force: true });
    }
    for (const f of fs.readdirSync(bak)) fs.copyFileSync(path.join(bak, f), path.join(store.dir(), f));
    fs.rmSync(bak, { recursive: true, force: true });
    throw e instanceof Error ? e : new Error(String(e)); // 外层 catch 收编为 notify 说明行
  }
  fs.rmSync(bak, { recursive: true, force: true }); // 成功：不留备份残渣
}

/** 结构化载荷解析；畸形返回 null（静默保持原状） */
function parseMergedPayload(argsJson: string): MergedCandidate[] | null {
  try {
    const obj = JSON.parse(argsJson) as { items?: unknown };
    return Array.isArray(obj.items) ? (obj.items as MergedCandidate[]) : null;
  } catch {
    return null;
  }
}

function isValidCandidate(c: MergedCandidate): c is { type: unknown; description: string; body: string } {
  const description = typeof c.description === 'string' ? c.description.trim() : '';
  const body = typeof c.body === 'string' ? c.body.trim() : '';
  if (!description || !body) return false;
  if (normalizeText(description).length === 0 || normalizeText(body).length === 0) return false;
  return true;
}

/** 类型归一：非法类型落 project（与 extractor 同口径；applyMerged 落盘前收编，frontmatter 恒四选一） */
export function coerceType(t: unknown): MemoryType {
  return t === 'user' || t === 'feedback' || t === 'reference' ? t : 'project';
}

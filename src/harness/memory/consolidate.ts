import * as fs from 'fs';
import * as path from 'path';
import { pick } from '../../i18n';
import type { ModelAdapter } from '../../model/adapter';
import { isModelSummarizer } from '../context/summarizer';
import { MemoryStore, MemoryType, MEMORY_CONSOLIDATE_THRESHOLD, normalizeText } from './store';

/**
 * 整理管线（auto memory 规格 §5）：任务收口（settleMemory 尾部）与 /memory gc 双入口共用本函数。
 * 语义=模型清洗合并（一行一条/合并重复/冲突以新覆旧 supersede/消解残留指代——防线③二次清洗），
 * 保护三闸：输出条数 > 输入拒绝（整理只减不增）、畸形 JSON 拒绝、落盘抛错从 .bak 快照回滚。
 */

interface MergedCandidate {
  type?: unknown;
  description?: unknown;
  body?: unknown;
}

export async function consolidateMemory(opts: { model: ModelAdapter; root: string }): Promise<void> {
  try {
    if (!isModelSummarizer(opts.model)) return; // 门禁同提取：Stub/Scripted 静默跳过
    const store = new MemoryStore(opts.root);
    const before = store.list();
    if (before.length < MEMORY_CONSOLIDATE_THRESHOLD) return; // 阈值未达零调用零副作用
    const out = await opts.model.complete(buildConsolidationPrompt(before));
    const parsed = parseEnvelope(out);
    if (!parsed) return;
    const valid = parsed.filter(isValidCandidate);
    if (valid.length === 0 || valid.length > before.length) return; // 只减不增
    applyMerged(store, valid);
  } catch {
    // 旁路纪律：整理任何失败静默降级，调用方收口不受影响
  }
}

/** 应用合并集：先整目录 .bak 快照 → 清旧记录 → 逐条写入 → 重建索引；任一步抛错回滚并清快照，成功后清快照 */
function applyMerged(store: MemoryStore, records: { type: MemoryType; description: string; body: string }[]): void {
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
    for (const f of fs.readdirSync(store.dir())) {
      if (f.endsWith('.md') && f !== 'MEMORY.md') fs.rmSync(path.join(store.dir(), f), { force: true });
    }
    for (const r of records) {
      const rr = store.add({ type: r.type, description: r.description, body: r.body });
      if (!rr.ok) throw new Error(rr.ok === false ? rr.error.code : 'consolidation apply failed');
    }
    store.rebuildIndex();
  } catch (e) {
    // 精确还原：先清当前目录内容（含失败半成品与异形条目如被占位的 MEMORY.md 目录），再从 .bak 整体拷回
    for (const f of fs.readdirSync(store.dir())) {
      if (f.startsWith('.bak-')) continue;
      fs.rmSync(path.join(store.dir(), f), { recursive: true, force: true });
    }
    for (const f of fs.readdirSync(bak)) fs.copyFileSync(path.join(bak, f), path.join(store.dir(), f));
    fs.rmSync(bak, { recursive: true, force: true });
    throw e instanceof Error ? e : new Error(String(e)); // 外层 catch 静默
  }
  fs.rmSync(bak, { recursive: true, force: true }); // 成功：不留备份残渣
}

/**
 * 整理 prompt（'memory-consolidation' 为固定标记，测试桩据此区分整理调用——对齐 handoff/memory-extraction 先例）：
 * 全量记录清单 + 当前日期 + 清洗指令（防线③：消解残留指代、统一术语）+ 产出格式；输出条数不得超过输入（只减不增）。
 */
function buildConsolidationPrompt(records: { slug: string; type: string; created: string; description: string; body: string }[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const listing = records.map((r) => `- [${r.type}] (created: ${r.created}) ${r.description} — ${r.body}`).join('\n');
  return pick(
    [
      'You are consolidating a persistent memory store (memory-consolidation) for an engineering project.',
      `Today is ${today}.`,
      'Merge duplicates, drop stale or superseded entries (a newer observation replaces the old), keep one entry per fact, keep details inside the entry body.',
      'Rewrite entries to be self-contained: resolve any remaining deictic references ("this", "that") into concrete entity names and use absolute dates only.',
      `You must NOT output more entries than the ${records.length} given. Keep the original language of each entry.`,
      'Output strict JSON only (no preamble, no code fences): {"memories":[{"type":"project","description":"one line","body":"the fact"}]}.',
      'Current records:',
      listing,
    ].join('\n'),
    [
      '你正在整理一个工程项目的持久记忆库（memory-consolidation）。',
      `今天是 ${today}。`,
      '合并重复条目、删除过期或已被取代的条目（新观察覆盖旧结论）、一条记忆一个事实、细节保留在条目正文中。',
      '改写条目使其自包含：把残留的指代（这个/那个/上述）消解为具体实体名，时间只以绝对日期存在。',
      `输出条数不得超过给定的 ${records.length} 条。保持条目原语言。`,
      '只输出严格 JSON（无前言、无代码围栏）：{"memories":[{"type":"project","description":"一句话","body":"事实内容"}]}。',
      '当前记录：',
      listing,
    ].join('\n'),
  );
}

/** 宽容解析：剥代码围栏后 JSON.parse；畸形返回 null（静默保持原状） */
function parseEnvelope(out: string): MergedCandidate[] | null {
  try {
    const text = out.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const obj = JSON.parse(text) as { memories?: unknown };
    return Array.isArray(obj.memories) ? (obj.memories as MergedCandidate[]) : null;
  } catch {
    return null;
  }
}

const TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

function isValidCandidate(c: MergedCandidate): c is { type: MemoryType; description: string; body: string } {
  const description = typeof c.description === 'string' ? c.description.trim() : '';
  const body = typeof c.body === 'string' ? c.body.trim() : '';
  if (!description || !body) return false;
  if (normalizeText(description).length === 0 || normalizeText(body).length === 0) return false;
  return true;
}

/** 类型归一：非法类型落 project（与 extractor 同口径） */
export function coerceType(t: unknown): MemoryType {
  return t === 'user' || t === 'feedback' || t === 'reference' ? t : 'project';
}

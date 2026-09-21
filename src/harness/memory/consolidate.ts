import * as fs from 'fs';
import * as path from 'path';
import type { ModelAdapter } from '../../model/adapter';
import { isModelSummarizer } from '../context/summarizer';
import { buildConsolidationPrompt, CONSOLIDATE_TOOLS } from '../prompts/memory';
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

export async function consolidateMemory(opts: { model: ModelAdapter; root: string; force?: boolean }): Promise<void> {
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

/** 结构化载荷解析；畸形返回 null（静默保持原状） */
function parseMergedPayload(argsJson: string): MergedCandidate[] | null {
  try {
    const obj = JSON.parse(argsJson) as { items?: unknown };
    return Array.isArray(obj.items) ? (obj.items as MergedCandidate[]) : null;
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

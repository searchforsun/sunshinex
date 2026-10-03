import * as fs from 'fs';
import * as path from 'path';
import type { ModelAdapter } from '../../model/adapter';
import { isModelSummarizer } from '../context/summarizer';
import { MemoryRecord, MemoryStore, MEMORY_CONSOLIDATE_THRESHOLD, MEMORY_TYPES as WRITABLE_MEMORY_TYPES, MemoryType, normalizeText, slugifyMemory } from './store';
import { coerceType, consolidateMemory } from './consolidate';
import { scanMemoryText } from './guards';
import { MemoryScope } from './paths';
import { Result, ok, fail } from '../../result';
import { resolveMemoryConfig } from '../../config/memory-config';
import { buildExtractionPrompt, MEMORY_TOOLS } from '../prompts/memory';

/**
 * 记忆提取管线（auto memory 规格 §4）：reactor settle 单点挂载、独立一次性模型调用不进主链。
 * 门禁复用 summarizer 能力位判定（capabilities.chat 显式声明，J2）——Stub/Scripted/未配真实模型零调用零副作用；
 * 提取抛错/空产出/畸形 JSON 一律静默降级，任务收口永不因记忆失败而失败（旁路纪律）。
 * 闸门正则与命中判定归 `./guards` 公共单点（规格 §3.3），本文件不再自带第二份实现。
 *
 * 运行中自主写入（规格 §3.7）：`writeMemoryFact` 为 `memory_write` 工具的落盘单点，与批量提取**共用**
 * `admitMemory` 这一条准入链（写时扫描 → SUNSHINE.md 去重 → store.add 三级归一去重）——闸门顺序与判定集合
 * 只有一份实现，「模型自主写」不可能比「批量提取」松。
 */

interface Candidate {
  type?: unknown;
  description?: unknown;
  content?: unknown;
  scope?: unknown;
}


/**
 * 任务收尾记忆提取入口：goal+reply+digest 材料面（含 SUNSHINE.md 节）→ chat 面 submit_memory_items 出牌
 * → 五重准入闸门 → MemoryStore 落盘。返回本次成功入库的 slug 列表（规格 §10 会话内可见性：
 * 调用方据此发 notice 说明行）；失败路径返回已入库部分。notify 收整理未应用的说明行（防静默重试循环）。
 */
export async function settleMemory(opts: {
  goal: string;
  reply: string;
  digest?: string;
  model: ModelAdapter;
  root: string;
  notify?: (line: string) => void;
}): Promise<string[]> {
  const saved: string[] = [];
  try {
    if (!isModelSummarizer(opts.model)) return saved;
    const chat = opts.model.chat;
    if (!chat) return saved;
    const res = await chat.call(opts.model, {
      messages: [
        {
          role: 'user',
          content: buildExtractionPrompt(
            opts.goal,
            opts.reply,
            new Date().toISOString().slice(0, 10),
            sunshineExcerpt(opts.root),
            (opts.digest ?? '').trim() || '(none)',
          ),
        },
      ],
      tools: MEMORY_TOOLS,
    });
    const call = res.toolCalls.find((t) => t.name === 'submit_memory_items');
    if (!call) return saved;
    const candidates = parseItemsPayload(call.argsJson);
    if (!candidates) return saved;
    const store = new MemoryStore(opts.root);
    const sunshine = sunshineText(opts.root);
    for (const c of candidates) {
      const description = typeof c.description === 'string' ? c.description.trim() : '';
      const content = typeof c.content === 'string' ? c.content.trim() : '';
      if (!description || !content) continue;
      // 闸门 a（会话性内容不落盘）：结构化条目 schema 不含 scope（scope 不暴露给模型，T1 裁决），
      // 条目按 persistent 构造，闸门无第二形态可拦；type 收编谓词与整理管线共用 consolidate.coerceType 单点
      const type = coerceType(c.type);
      try {
        // 闸门 b/c（guards 单点）→ 闸门 e（SUNSHINE.md）→ 闸门 d（store.add 三级去重）全在 admitMemory 内，与 memory_write 工具同链
        const r = admitMemory(store, sunshine, { type, description, body: content });
        // 幂等命中（重复项解析回既有 slug）不算本次新增：批量语义与迁移前逐条一致；超限报错不阻断后续条目
        if (r.ok && !r.value.existed) saved.push(r.value.slug);
      } catch {
        // 旁路纪律：单条落盘失败不影响其余条目与任务收口
      }
    }
    // 整理触发（规格 §5）：同收口串行——先提取入库、后判定阈值整理；阈值未达零调用（consolidateMemory 内部门禁）
    if (store.count() >= MEMORY_CONSOLIDATE_THRESHOLD) {
      await consolidateMemory({ model: opts.model, root: opts.root, notify: opts.notify });
    }
  } catch {
    // 旁路纪律：提取任何失败静默降级（saved 保留已入库部分，调用方照常可见）
  }
  return saved;
}

/** 宽容解析：剥代码围栏后 JSON.parse；畸形/缺 memories 返回 null（静默降级） */
function parseItemsPayload(argsJson: string): Candidate[] | null {
  try {
    const obj = JSON.parse(argsJson) as { items?: unknown };
    return Array.isArray(obj.items) ? (obj.items as Candidate[]) : null;
  } catch {
    return null;
  }
}

/** SUNSHINE.md 全文截断水位（单一来源，context 漂移块 DRIFT_MAX_CHARS 同水位 import 锚定——
 *  材料节与漂移说明同属「SUNSHINE 全文进提示词」预算面，两处水位须同进退） */
export const SUNSHINE_EXCERPT_MAX_CHARS = 4096;

/** SUNSHINE.md 材料节（提取 prompt 用）：skip 指令的可执行数据；缺文件/空文件给确定态占位，模板形态恒定 */
function sunshineExcerpt(root: string): string {
  try {
    const t = fs.readFileSync(path.join(root, 'SUNSHINE.md'), 'utf8').trim();
    if (t.length === 0) return '(empty)';
    return t.length > SUNSHINE_EXCERPT_MAX_CHARS ? `${t.slice(0, SUNSHINE_EXCERPT_MAX_CHARS)}\n…(truncated)` : t;
  } catch {
    return '(no SUNSHINE.md found)';
  }
}

/** SUNSHINE.md 归一全文（闸门 e 包含比对基准；无文件为空串） */
function sunshineText(root: string): string {
  try {
    return normalizeText(fs.readFileSync(path.join(root, 'SUNSHINE.md'), 'utf8'));
  } catch {
    return '';
  }
}

/** 闸门 e 包含口径的最短 description 归一长度：短语包含需防碎片误伤——"pnpm"/"memory" 这类短词
 *  是常见词不是「已写明的事实」，低于门槛不做包含判定（宁漏判不误杀，残余交整理收敛） */
const MEMORY_SUNSHINE_OVERLAP_MIN_CHARS = 8;

/** 合法记忆类型集（R7 单点）：import 别名沿用 WRITABLE 语义——工具入口自校验口径（落盘与三级去重仍归 store.add 单点） */

/** 准入链产出：slug + 本次是否新建（幂等命中为既有项）+ 容量近满提醒（仅新建路径给出） */
export interface MemoryAdmission {
  slug: string;
  existed: boolean;
  notice: string | null;
}

/**
 * 准入链单点（规格 §3.3/§3.7）：写时扫描 → SUNSHINE.md 去重 → store.add（三级归一去重 / 落盘 / 索引重建 / 容量两级）。
 * 复用方：批量提取 `settleMemory` 与 `memory_write` 工具 `writeMemoryFact`——闸门顺序、判定集合与失败码只有这一份实现。
 * 失败一律带码返回（调用方决定浮出还是静默降级），不在本函数内抛异常。
 */
function admitMemory(
  store: MemoryStore,
  sunshine: string,
  input: { type: MemoryType; description: string; body: string },
): Result<MemoryAdmission> {
  // 闸门 b/c：临时措辞与注入/不可见 Unicode（guards 单点，判定集合与迁移前等价）
  const hit = scanMemoryText(`${input.description}\n${input.body}`);
  if (hit !== null) return fail('MEMORY_WRITE_SCAN', `Rejected: session-scoped or unsafe content (${hit}); nothing written`);
  // 闸门 e：SUNSHINE.md 已写明项（CC 同款精神）。2026-10-02 口径修正：旧「整行相等」在「散文长行 vs 单行摘要」
  // 形态下恒不命中=闸门形同虚设（当日实据：3 条与 SUNSHINE.md 重复记录全部穿过），改为归一短语包含——
  // description 是 SUNSHINE.md 的连续子串即判已覆盖（跨行命中由归一空白折叠承载）
  const desc = normalizeText(input.description);
  if (desc.length >= MEMORY_SUNSHINE_OVERLAP_MIN_CHARS && sunshine.includes(desc)) {
    return fail('MEMORY_SUNSHINE_OVERLAP', 'Already covered by SUNSHINE.md; nothing written');
  }
  // 闸门 d：三级归一去重由 add 承载（slug / description / body 任一归一相同即拒）
  const added = store.add(input);
  if (added.ok) return ok({ slug: added.value.slug, existed: false, notice: store.capacityNotice() });
  // 重复写幂等（规格 §3.7）：add 定论为重复后解析既有项，返回既有 slug（零新增、零二次落盘），而非把重复当失败
  if (added.error.code === 'MEMORY_DUPLICATE') {
    const existing = findExistingDuplicate(store, input);
    if (existing !== undefined) return ok({ slug: existing.slug, existed: true, notice: null });
  }
  return fail(added.error.code, added.error.message);
}

/**
 * 重复项解析（只读，无判定权）：判定权威始终是 `store.add` 的三级归一去重——本函数只在 add 已报 MEMORY_DUPLICATE 之后，
 * 按**同一口径**（slug 折叠 / description 归一 / body 归一）定位既有记录，供幂等路径返回既有 slug。
 * 口径漂移（如 store 将来新增第四级）时解析不到即原样浮出 MEMORY_DUPLICATE——fail-closed，不会把非重复当重复。
 */
function findExistingDuplicate(store: MemoryStore, input: { description: string; body: string }): MemoryRecord | undefined {
  const slug = slugifyMemory(input.description);
  const description = normalizeText(input.description);
  const body = normalizeText(input.body);
  return store.list().find(
    (r) => r.slug === slug || normalizeText(r.description) === description || normalizeText(r.body) === body,
  );
}

/**
 * `memory_write` 工具落盘单点（规格 §3.7 运行中自主写入主通道）：与批量提取共用 `admitMemory` 这一条准入链。
 * 与 `writer.ts`（write 工具的记忆路径接缝）入口形态分立而基座同源：接缝收文件内容，slug 由模型写的文件名定（`put`，同 slug 即更新）；
 * 本单点收结构化事实（type/content/description），slug 由 description 折叠（`add`）。两者共用同一组闸门单点（`./guards`）
 * 与同一落盘基座（`MemoryStore`：去重/规范化/索引重建/容量两级），不各自拼装——闸门不会因入口不同而放宽。
 *
 * 语义：off 或 scope/类型非法/正文空 → 带码失败且零副作用（off 判门先于 store 构造，连记忆目录都不建）；
 * 重复写幂等返回既有 slug（`existed: true`）；成功附容量近满提醒（超限仍由 `store.add` 报 MEMORY_INDEX_OVER_LIMIT 浮出）。
 *
 * `scope`（规格 §4.2 记忆隔离）：缺省/`'main'` = 主记忆目录；`agents/<id>` = 该子代理自有目录（落盘走
 * `new MemoryStore(root, { subdir })`，与 `subagent.agentMemory` 同一目录形态）。**链侧收窄对 memory_write 不生效**
 * （canonical 同族 Write、入参无 path → `PATH_TOOLS` 归一为 root，`isMemoryPath` 恒不命中），故 scope 只能由本接缝承载：
 * 装配层把安全链的 `memoryScope` 透传进来（builtin 第 8 参执行期注入），子代理链的 `agents/<id>` 才真正落到自有目录。
 */
export function writeMemoryFact(opts: {
  root: string;
  type: string;
  content: string;
  description?: string;
  scope?: MemoryScope;
}): Result<MemoryAdmission> {
  // 总开关最先判（规格 §7「不注入 / 不提取 / 不整理 / 写被拒」四贯通之一）：关闭即零副作用——不 mkdir、不扫描、不落盘
  if (!resolveMemoryConfig().autoMemory) return fail('MEMORY_DISABLED', 'memory write denied: auto memory is off');
  const subdir = memorySubdir(opts.scope);
  if (!subdir.ok) return subdir;
  if (!WRITABLE_MEMORY_TYPES.includes(opts.type as MemoryType)) {
    return fail('MEMORY_TYPE_INVALID', `unknown memory type: ${opts.type} (expect one of ${WRITABLE_MEMORY_TYPES.join('|')})`);
  }
  const content = opts.content.trim();
  if (!content) return fail('MEMORY_EMPTY', 'memory content must not be empty');
  // description 缺省取正文首行、截 80（单行口径与 MemoryRecord.description 一致；正文去掉首尾空白后首行必非空）
  const description = (opts.description?.trim() || content.split('\n')[0].trim()).slice(0, 80);
  const store = subdir.value === undefined ? new MemoryStore(opts.root) : new MemoryStore(opts.root, { subdir: subdir.value });
  return admitMemory(store, sunshineText(opts.root), {
    type: opts.type as MemoryType,
    description,
    body: content,
  });
}

/**
 * 记忆 scope → `MemoryStore` 子目录（规格 §4.2）：`undefined`/`'main'` 为主记忆目录，`agents/<id>` 为子代理自有子目录。
 * 子目录字符串直接拼进落盘路径，故此处 fail-closed 校验形态：只接受单段合法 `agents/<id>`（拒 `/`、`\`、`.`、`..`），
 * 越界 scope 宁可带码失败也不落盘（不把分支判断留给 MemoryStore 的路径拼接）。
 */
function memorySubdir(scope: MemoryScope | undefined): Result<string | undefined> {
  if (scope === undefined || scope === 'main') return ok(undefined);
  const id = /^agents\/([^/\\]+)$/.exec(scope)?.[1] ?? '';
  if (id === '' || id === '.' || id === '..') {
    return fail('MEMORY_SCOPE_INVALID', `invalid memory scope: ${scope} (expect main or agents/<id>)`);
  }
  return ok(scope);
}

import * as path from 'path';
import { t } from '../i18n';
import { MemoryStore } from '../harness/memory/store';
import { resolveMemoryConfig } from '../config/memory-config';
import { scanMemoryText } from '../harness/memory/guards';
import { consolidateMemory } from '../harness/memory/consolidate';
import { isModelSummarizer } from '../harness/context/summarizer';
import { resolveKbEnv } from '../config/env';
import { indexKnowledgeDir } from '../harness/knowledge';
import type { SessionController } from './session';

// D17 拆分件步3（docs/TECH-DEBT-SURVEY.md H1）：持久存储类命令族——memory 六方法 + kbIndex（知识库同为
// 持久库族）函数体迁出，handleSlash 骨架留 session 只做分发；经 ctrl 公开成员访问，不为迁出复制状态。

/** /memory：无参列索引（查看态） */
export function memoryList(ctrl: SessionController): void {
  if (ctrl.state.status !== 'idle') {
    ctrl.pushMsg('system', t('A task is running; /memory unavailable now', '当前有任务进行中，暂不能执行 /memory'), { level: 'warn' });
    return;
  }
  const store = new MemoryStore(ctrl.root);
  const records = store.list();
  const capacity = store.capacityNotice();
  if (records.length === 0) {
    ctrl.pushMsg('system', [t('No memories yet — /memory-add <text> to add one', '暂无记忆——用 /memory-add <内容> 添加一条'), memoryStateLine(ctrl), ...(capacity ? [capacity] : [])].join('\n'));
    return;
  }
  const lines = records.map((r) => `- ${r.slug} [${r.type}] (${r.created}) ${r.description}`);
  ctrl.pushMsg('system', [t(`Persistent memories (${records.length}):`, `持久记忆（${records.length} 条）：`), ...lines, memoryStateLine(ctrl), ...(capacity ? [capacity] : [])].join('\n'));
}

/** /memory-add：自由文本内容写入（与自动提取同一写时闸门）；空内容按规格 D2 落统一无法识别文案 */
export function memoryAdd(ctrl: SessionController, rest: string): void {
  if (ctrl.state.status !== 'idle') {
    ctrl.pushMsg('system', t('A task is running; /memory-add unavailable now', '当前有任务进行中，暂不能执行 /memory-add'), { level: 'warn' });
    return;
  }
  if (!rest) {
    ctrl.pushMsg('system', t('Unrecognized command. Use /help to see available commands', '无法识别命令，使用 /help 查看使用方法'), { level: 'warn' });
    return;
  }
  const store = new MemoryStore(ctrl.root);
  const flagged = scanMemoryText(rest);
  if (flagged) {
    ctrl.pushMsg('system', t(`Rejected: session-scoped or unsafe content (${flagged}); not persisted`, `已拒绝：会话性内容或含注入特征（${flagged}），不落盘`), { level: 'warn' });
    return;
  }
  const r = store.add({ type: 'project', description: rest, body: rest });
  if (r.ok) {
    ctrl.pushMsg('system', t(`Added memory: ${r.value.slug} (applies from the next session or refresh point)`, `已添加记忆：${r.value.slug}（下个会话或刷新点生效）`));
  } else if (r.error.code === 'MEMORY_DUPLICATE') {
    ctrl.pushMsg('system', t(`Duplicate memory rejected: ${rest}`, `重复记忆已拒绝：${rest}`), { level: 'warn' });
  } else {
    ctrl.pushMsg('system', r.error.message, { level: 'error' });
  }
}

/** /memory-rm：多选卡批删（规格 D5/D6）：Space 勾选、Enter 批删、Esc 取消零删除；>8 条 filterable 全量卡（渲染层筛选）；翻页统一渲染层滑窗（2026-09-30 口径） */
export async function memoryRm(ctrl: SessionController): Promise<void> {
  if (ctrl.state.status !== 'idle') {
    ctrl.pushMsg('system', t('A task is running; /memory-rm unavailable now', '当前有任务进行中，暂不能执行 /memory-rm'), { level: 'warn' });
    return;
  }
  const store = new MemoryStore(ctrl.root);
  const records = store.list();
  if (records.length === 0) {
    ctrl.pushMsg('system', t('No memories yet — /memory-add <text> to add one', '暂无记忆——用 /memory-add <内容> 添加一条'), { level: 'warn' });
    return;
  }
  const items = records.map((r) => ({ label: r.slug, description: `${r.type} · ${r.description} (${r.created})` }));
  // >8 条切 filterable 卡（规格 D6/D8）：一次问询勾选批删；≤8 条全量直出（翻页由渲染层滑窗承载）
  if (items.length > 8) {
    const answer = await ctrl.askUser({
      question: t('Select memories to delete (Space to toggle, Enter to delete; type to filter)', '选择要删除的记忆（Space 勾选，Enter 批量删除；输入即筛选）'),
      options: items,
      multiple: true,
      filterable: true,
    });
    if (answer.type !== 'selected' || answer.labels.length === 0) {
      ctrl.pushMsg('system', t('No memories removed', '未删除任何记忆'));
      return;
    }
    applyMemoryRemoval(ctrl, store, answer.labels);
    return;
  }
  // ≤8 条全量直出（2026-09-30 翻页口径统一：滑窗自动翻页由渲染层承载，More…/Back… 跨页累积循环退役）
  const answer = await ctrl.askUser({
    question: t('Select memories to delete (Space to toggle, Enter to delete)', '选择要删除的记忆（Space 勾选，Enter 批量删除）'),
    options: items,
    multiple: true,
  });
  if (answer.type !== 'selected') {
    ctrl.pushMsg('system', t('No memories removed', '未删除任何记忆'));
    return;
  }
  applyMemoryRemoval(ctrl, store, answer.labels);
}

/** 批删执行面（/memory-rm 两形态共用单点）：去重→逐条删除→回执 */
function applyMemoryRemoval(ctrl: SessionController, store: MemoryStore, picked: string[]): void {
  const unique = [...new Set(picked)];
  if (unique.length === 0) {
    ctrl.pushMsg('system', t('No memories removed', '未删除任何记忆'));
    return;
  }
  let ok = 0;
  let fail = 0;
  for (const slug of unique) {
    const r = store.remove(slug);
    if (r.ok) ok += 1;
    else fail += 1;
  }
  const capacity = store.capacityNotice();
  ctrl.pushMsg('system', [
    t(ok === 1 ? `Removed 1 memory${fail ? ` (${fail} failed)` : ''}` : `Removed ${ok} memories${fail ? ` (${fail} failed)` : ''}`, `已删除 ${ok} 条${fail ? `（失败 ${fail} 条）` : ''}`),
    ...(capacity ? [capacity] : []),
  ].join('\n'));
}

/** /memory-gc：显式整理入口（阈值外 force），与自动整理同一 consolidate 函数 */
export async function memoryGc(ctrl: SessionController): Promise<void> {
  if (ctrl.state.status !== 'idle') {
    ctrl.pushMsg('system', t('A task is running; /memory-gc unavailable now', '当前有任务进行中，暂不能执行 /memory-gc'), { level: 'warn' });
    return;
  }
  const store = new MemoryStore(ctrl.root);
  if (!isModelSummarizer(ctrl.runtime.harness.model)) {
    ctrl.pushMsg('system', t('Consolidation requires a real model (current channel is stub/scripted)', '整理需要真实模型（当前通道为 stub/scripted）'), { level: 'warn' });
    return;
  }
  if (store.count() === 0) {
    ctrl.pushMsg('system', t('No memories yet — nothing to consolidate', '暂无记忆——没有可整理的内容'), { level: 'warn' });
    return;
  }
  await consolidateMemory({ model: ctrl.runtime.harness.model, root: ctrl.root, force: true });
  ctrl.pushMsg('system', t(`Consolidated persistent memory: ${store.count()} records`, `持久记忆已整理：${store.count()} 条`));
}

/** 记忆开关状态行（/memory 无参列表尾追；外观面 t() 双语） */
function memoryStateLine(ctrl: SessionController): string {
  const on = ctrl.memoryOverride ?? resolveMemoryConfig().autoMemory;
  if (ctrl.memoryOverride !== undefined) {
    return ctrl.memoryOverride
      ? t('Persistent memory: ON for this session (session override, not persisted)', '持久记忆：本会话开启（会话内覆盖，不落盘）')
      : t('Persistent memory: OFF for this session (session override, not persisted)', '持久记忆：本会话关闭（会话内覆盖，不落盘）');
  }
  return on
    ? t('Persistent memory: ON', '持久记忆：开启')
    : t('Persistent memory: OFF', '持久记忆：关闭');
}

/** /kb-index（D28）：显式构建 KB 索引——与 CLI kb-index 子命令共用 knowledge 层单点 indexKnowledgeDir，
 *  索引对目录内全部 md/txt 走真实计费 embedding（用户显式触发，成本可控性由文件数决定）；
 *  经会话装配的同一实例写入，kb_search 本会话即时可见（不因实例过期需重启） */
export async function kbIndex(ctrl: SessionController, dirArg: string): Promise<void> {
  if (ctrl.state.status !== 'idle') {
    ctrl.pushMsg('system', t('A task is running; /kb-index unavailable now', '当前有任务进行中，暂不能执行 /kb-index'), { level: 'warn' });
    return;
  }
  const target = dirArg === '' ? ctrl.root : path.resolve(ctrl.root, dirArg);
  ctrl.pushMsg('system', t(`Indexing ${target} (embedding md/txt files…)`, `正在为 ${target} 构建索引（md/txt 文件 embedding…）`));
  let r;
  try {
    r = await indexKnowledgeDir(resolveKbEnv(process.env as Record<string, string | undefined>), ctrl.root, target);
  } catch (e) {
    ctrl.pushMsg('system', t(`Knowledge base assembly failed: ${e instanceof Error ? e.message : String(e)}`, `知识库装配失败：${e instanceof Error ? e.message : String(e)}`), { level: 'error' });
    return;
  }
  if (!r.ok) {
    if (r.reason === 'not-configured') {
      ctrl.pushMsg('system', t(
        `Knowledge base not configured — missing ${r.missing.join(', ')}. Set the embedding env (see MANUAL.md section 2), then rerun /kb-index.`,
        `知识库未配置——缺 ${r.missing.join('、')}。请配置 embedding 环境变量（见 MANUAL.md 第二节）后重跑 /kb-index。`,
      ), { level: 'warn' });
    } else {
      ctrl.pushMsg('system', t(`Not a directory: ${r.dir}`, `目录不存在或不是目录：${r.dir}`), { level: 'error' });
    }
    return;
  }
  ctrl.pushMsg('system', t(
    `Knowledge base index built: ${r.chunks} chunks (backend=${r.backend}, dataDir=${r.dataDir}) — kb_search sees it this session`,
    `知识库索引已构建：${r.chunks} 块（backend=${r.backend}，数据目录 ${r.dataDir}）——kb_search 本会话即时可用`,
  ));
}

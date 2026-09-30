import { ChatItem } from './session';
import { bandLines, elideByWidth, wrapByWidth } from './text-band';
import { markdownRowCount } from './markdown';
import { ansiLineCount } from './md-ansi';

/**
 * 尾部原位重写账本（2026-09-30 方案 A——段折叠闪屏消除）：
 * ink3 Static 打印过的行不可修改，折叠/富化历史行必须重放；旧路径「卸载→清屏(2J/3J)→整屏重放」
 * 在不支持 DEC 2026 的终端（Windows Terminal）上即清屏空白帧 + 全量重印闪屏。
 * 本模块以「打印时账本」驱动替代：逐条目记录打印时的渲染形态（条目引用 + visible/full + 行数），
 * 与当前决策精确比对得首个变化条目与其上方已打印行数——变化尾部几乎恒在视口内，
 * tui-loop 据此光标上移 + \x1b[J 就地擦写重放尾部（前缀滚动缓冲原样保留、零空白帧）。
 *
 * 行数口径与 MessageRow 渲染分支一一对应（marginBottom 1 计入）；不可数形态（如 SPAWN 展开转录）
 * 返回 undefined → 账本置 forceFull，重绘回落全量路径（安全降级，永不错位）。
 */

/** 已打印条目的账本槽位：item 引用恒等 + 渲染形态键（visible/full）+ 打印时行数 */
export interface LedgerSlot {
  item: ChatItem;
  visible: boolean;
  full: boolean;
  /** 打印时渲染行数（含 marginBottom 1；不可见条目为 0——渲染 null 零行） */
  lines: number;
}

/** 跨重挂存续的打印账本（App 经 retain 持有、MessageList 逐渲染记账、tui-loop 读取定夺） */
export interface TailLedger {
  slots: LedgerSlot[];
  /** 当前「屏上形态 vs 当前决策」的尾部重写计划；null=无差异（零重绘） */
  plan: { from: number; suffixLines: number } | null;
  /** 不可数形态闩：置位后本次挂载期内一律回落全量路径（重放后重建账本自动复位） */
  forceFull: boolean;
}

export function createTailLedger(): TailLedger {
  return { slots: [], plan: null, forceFull: false };
}

/** 单条目打印行数（不含 marginBottom；不可数=undefined）。与 MessageRow/ToolRow/ThinkingRow
 *  渲染分支同构——改渲染形态必须同步本函数，tail-rewrite.test 以「真实渲染行数差分」钉住漂移 */
export function printedEntryLines(item: ChatItem, full: boolean, columns: number): number | undefined {
  // ansi 条目（markdansi 流式通道）：MessageRow 直嵌 <Text>{item.text}</Text> 零加工——
  // 行数即剥码后行数，不得再走 markdownRowCount（ANSI 被当源 markdown 解析计宽）
  if ((item as { ansi?: true }).ansi) return ansiLineCount(item.text);
  const wrap1 = (s: string): number => Math.max(1, wrapByWidth(s, columns).length);
  switch (item.role) {
    case 'user':
      return bandLines(item.text, columns).length;
    case 'assistant':
      return markdownRowCount(item.text, columns);
    case 'system': {
      const prefix = item.level === 'error' ? '✗ ' : item.level === 'warn' ? '! ' : '';
      return wrap1(prefix + item.text);
    }
    case 'thinking': {
      const head = wrap1(`✻ ${item.text}`);
      if (full && item.detail !== undefined && item.detail.length > 0) {
        return head + item.detail.split('\n').reduce((n, l) => n + Math.max(1, wrapByWidth(`    ${l}`, columns).length), 0);
      }
      return head;
    }
    case 'step':
      return Math.max(1, markdownRowCount(item.text, Math.max(16, columns - 3)));
    default:
      return item.kind === 'call' ? printedCallLines(item, full, columns) : printedResultLines(item, full, columns);
  }
}

/** 工具调用行：● [VERB] target（按列宽省略）+ 展开态 detail 逐行；SPAWN 展开转录（detail 在场即
 *  走 TranscriptLines，与 meta 无关）不可数——常态已被时间线过滤剔除，此处防御兜底 */
function printedCallLines(item: ChatItem, full: boolean, columns: number): number | undefined {
  const sp = item.text.indexOf(' ');
  const verb = sp > 0 ? item.text.slice(0, sp) : item.text;
  const target = sp > 0 ? item.text.slice(sp + 1) : '';
  if (item.detail !== undefined && verb === 'SPAWN') return undefined;
  const expanded = item.detail !== undefined && full;
  const shown = target ? elideByWidth(target, Math.max(16, columns - 10)) : '';
  const head = Math.max(1, wrapByWidth(`● [${verb}] ${shown}`, columns).length);
  if (!expanded) return head;
  return head + (item.detail ?? '').split('\n').reduce((n, l) => n + Math.max(1, wrapByWidth(`    ${l}`, columns).length), 0);
}

/** 工具结果行：折叠=⎿ ✓ 首行单行省略；展开=⎿ 行 + detail/text 逐行 4 空格缩进 */
function printedResultLines(item: ChatItem, full: boolean, columns: number): number {
  if (!full && item.detail !== undefined) return 1;
  const body = (item.detail ?? item.text).split('\n');
  return 1 + body.reduce((n, l) => n + Math.max(1, wrapByWidth(`    ${l}`, columns).length), 0);
}

/** 重算尾部重写计划：屏上账本 vs 当前条目/决策逐位比对（引用恒等 + visible/full 形态），
 *  首个失配位即重写起点、其后账本行数之和即需擦写的屏上行数；条目数收缩（/rewind 等）不可
 *  就地重写 → forceFull */
export function recomputeTailPlan(ledger: TailLedger, items: ChatItem[], decisions: readonly { visible: boolean; full: boolean }[]): void {
  if (ledger.slots.length > items.length) {
    ledger.forceFull = true;
    ledger.plan = null;
    return;
  }
  let from = -1;
  for (let i = 0; i < items.length; i++) {
    const s = ledger.slots[i];
    const d = decisions[i];
    if (s === undefined || d === undefined || s.item !== items[i] || s.visible !== d.visible || s.full !== d.full) {
      from = i;
      break;
    }
  }
  if (from < 0) {
    ledger.plan = null;
    return;
  }
  let suffixLines = 0;
  for (let i = from; i < ledger.slots.length; i++) suffixLines += ledger.slots[i]!.lines;
  ledger.plan = { from, suffixLines };
}

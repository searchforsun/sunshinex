/** 跨重挂保留的输入/视图现场（resize 整屏重绘时由 App 实时回写、下次挂载恢复——打字过半不丢、输入历史可续、两层展开视图不回落） */
import type { TailLedger } from './tail-rewrite';

export interface RetainedUiState {
  buffer: string;
  cursor: number;
  /** 第一层（Tab）行折叠开关：清屏重挂后保持同一视图模式，避免重放回落到折叠态 */
  expandAll: boolean;
  /** 第二层（Ctrl+O）内容深度开关：最近正文锚点阶段的思考与工具结果全文展开 */
  latestFull: boolean;
  /** 子代理浏览模式（Ctrl+B）：选中列表动态区自绘，重挂后须原样恢复 */
  browseMode: boolean;
  browseCursor: number;
  /** 全屏查看态（规格 §3.3）：Enter 选中与退浏览的整屏重绘同帧发生，不入 retain 即重挂丢失
   *  （真机「Enter 闪一下屏回主界面」病根），跨重挂保留 */
  inspect?: { kind: 'live'; label: string } | { kind: 'archived'; seq: number };
  /** 全屏查看 Tab 两态（2026-09-28 用户裁决）：true=完整时间线（缺省）/ false=正文形态，跨重挂保留 */
  inspectExpanded: boolean;
  history: string[];
  histIdx: number;
  /** 打印账本（2026-09-30 方案 A）：跨重挂存续——tui-loop 读其 plan 定夺尾部原位重写，
   *  MessageList 逐渲染记账；全量重放路径由挂载端重建 */
  tailLedger?: TailLedger;
  /** tui-loop 预置的尾部重写起点（重挂前写入、App 挂载一次性消费）：本挂载中该下标以前的
   *  Static 条目不再重放（屏上原样保留）；undefined=整屏重放 */
  rewriteFrom?: number;
}

export function initialRetained(): RetainedUiState {
  return { buffer: '', cursor: 0, expandAll: false, latestFull: false, browseMode: false, browseCursor: 0, inspect: undefined, inspectExpanded: false, history: [], histIdx: -1 };
}

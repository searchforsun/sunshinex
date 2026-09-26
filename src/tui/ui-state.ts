/** 跨重挂保留的输入/视图现场（resize 整屏重绘时由 App 实时回写、下次挂载恢复——打字过半不丢、输入历史可续、两层展开视图不回落） */
export interface RetainedUiState {
  buffer: string;
  cursor: number;
  /** 第一层（Tab）行折叠开关：清屏重挂后保持同一视图模式，避免重放回落到折叠态 */
  expandAll: boolean;
  /** 第二层（Ctrl+O）内容深度开关：最近正文锚点阶段的思考与工具结果全文展开 */
  latestFull: boolean;
  /** 子代理行逐行展开集合（Ctrl+B 浏览模式 Enter 切换，存 SPAWN 调用行 seq）：跨重挂保留、瞬态 UI 态不进 journal */
  spawnExpanded: number[];
  /** 子代理浏览模式（Ctrl+B）：行高亮走 Static 历史重放（repaint 依赖含 browseMode），重挂后须原样恢复 */
  browseMode: boolean;
  browseCursor: number;
  /** 全屏查看态（规格 §3.3）：Enter 选中与退浏览的整屏重绘同帧发生，不入 retain 即重挂丢失
   *  （真机「Enter 闪一下屏回主界面」病根），跨重挂保留 */
  inspect?: { kind: 'live'; label: string } | { kind: 'archived'; seq: number };
  history: string[];
  histIdx: number;
}

export function initialRetained(): RetainedUiState {
  return { buffer: '', cursor: 0, expandAll: false, latestFull: false, spawnExpanded: [], browseMode: false, browseCursor: 0, inspect: undefined, history: [], histIdx: -1 };
}

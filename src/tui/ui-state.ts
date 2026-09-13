/** 跨重挂保留的输入/视图现场（resize 整屏重绘时由 App 实时回写、下次挂载恢复——打字过半不丢、输入历史可续、两层展开视图不回落） */
export interface RetainedUiState {
  buffer: string;
  cursor: number;
  /** 第一层（Tab）行折叠开关：清屏重挂后保持同一视图模式，避免重放回落到折叠态 */
  expandAll: boolean;
  /** 第二层（Ctrl+O）内容深度开关：最近正文锚点阶段的思考与工具结果全文展开 */
  latestFull: boolean;
  history: string[];
  histIdx: number;
}

export function initialRetained(): RetainedUiState {
  return { buffer: '', cursor: 0, expandAll: false, latestFull: false, history: [], histIdx: -1 };
}

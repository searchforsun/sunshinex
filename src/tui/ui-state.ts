/** 跨重挂保留的输入/视图现场（resize 整屏重绘时由 App 实时回写、下次挂载恢复——打字过半不丢、输入历史可续、展开模式不回落） */
export interface RetainedUiState {
  buffer: string;
  cursor: number;
  /** Tab 展开模式开关：清屏重挂后保持同一视图模式，避免重放回落到折叠态 */
  expandAll: boolean;
  history: string[];
  histIdx: number;
}

export function initialRetained(): RetainedUiState {
  return { buffer: '', cursor: 0, expandAll: false, history: [], histIdx: -1 };
}

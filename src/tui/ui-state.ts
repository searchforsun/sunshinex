import { ChatItem } from './session';

/** 跨重挂保留的输入/视图现场（resize 整屏重绘时由 App 实时回写、下次挂载恢复——打字过半不丢、历史可续翻、展开打印可重放） */
export interface RetainedUiState {
  buffer: string;
  cursor: number;
  /** Tab 展开打印的整段 transcript：已滚入终端滚动缓冲，清屏重挂后须重放否则内容丢失 */
  dumps: Array<{ seq: number; anchorSeq: number; items: ChatItem[] }>;
  history: string[];
  histIdx: number;
}

export function initialRetained(): RetainedUiState {
  return { buffer: '', cursor: 0, dumps: [], history: [], histIdx: -1 };
}

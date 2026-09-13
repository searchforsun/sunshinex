import { ChatItem } from './session';

export interface ItemRenderDecision {
  /** 行折叠维度下该条目是否上屏 */
  visible: boolean;
  /** 内容深度维度：思考/工具结果 true 展开全文、false 单行摘要 */
  full: boolean;
}

/**
 * 锚点折叠视图决策（纯函数：消息流 → 逐条渲染决策）：
 * 以 ▶ 阶段行为锚点切组——每条 step 开启一个阶段组，正文锚点 = assistant 条目；
 * 默认态最近锚点所在组全行可见，更早的每组折叠为「正文 + 组内首个思考行 + 首个工具调用对」；
 * expandAll（Tab，第一层）解除全部行折叠；latestFull（Ctrl+O，第二层）把最近锚点组的
 * 思考与工具结果展开为全文。首个 ▶ 行之前的内容（用户输入、系统卡、无阶段轮次）不参与分组，
 * 沿用 expandAll 口径折叠（无阶段轮次保持单步任务摘要折叠语义）。
 */
export function buildTranscriptDecisions(
  messages: ChatItem[],
  view: { expandAll: boolean; latestFull: boolean },
): ItemRenderDecision[] {
  const foldable = (item: ChatItem): boolean => item.role === 'thinking' || item.role === 'tool';
  const n = messages.length;
  const out: ItemRenderDecision[] = messages.map((item) => ({
    visible: true,
    full: !foldable(item) || view.expandAll,
  }));
  const groupOf: number[] = new Array(n).fill(-1);
  let g = -1;
  for (let i = 0; i < n; i++) {
    if (messages[i].role === 'step') g += 1;
    groupOf[i] = g;
  }
  if (g < 0) return out; // 无阶段组：序组口径即最终口径
  let latestGroup = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      latestGroup = groupOf[i];
      break;
    }
  }
  if (latestGroup < 0) latestGroup = g;
  const firstThinking = new Map<number, number>();
  const firstCall = new Map<number, number>();
  const resultOfCall = new Map<number, number>();
  let pendingCall = -1;
  for (let i = 0; i < n; i++) {
    const item = messages[i];
    const gi = groupOf[i];
    if (gi < 0) continue;
    if (item.role === 'thinking') {
      if (!firstThinking.has(gi)) firstThinking.set(gi, i);
    } else if (item.role === 'tool' && item.kind === 'call') {
      if (!firstCall.has(gi)) firstCall.set(gi, i);
      pendingCall = i;
    } else if (item.role === 'tool' && item.kind === 'result' && pendingCall >= 0) {
      resultOfCall.set(pendingCall, i);
      pendingCall = -1;
    }
  }
  for (let i = 0; i < n; i++) {
    const item = messages[i];
    const gi = groupOf[i];
    if (gi < 0) continue;
    // 最近锚点组与其后尚未产出正文的进行中组均保持全行（进行中组的动作行不能在流式期间被折叠）
    const isLatest = gi >= latestGroup;
    const keepIdx = firstCall.get(gi);
    const kept =
      firstThinking.get(gi) === i ||
      keepIdx === i ||
      (keepIdx !== undefined && resultOfCall.get(keepIdx) === i);
    const visible = item.role === 'step' || item.role === 'assistant' || isLatest || view.expandAll || kept;
    const full = isLatest && view.latestFull && foldable(item);
    out[i] = { visible, full };
  }
  return out;
}

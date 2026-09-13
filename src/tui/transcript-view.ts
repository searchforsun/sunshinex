import { ChatItem } from './session';

export interface ItemRenderDecision {
  /** 行折叠维度下该条目是否上屏 */
  visible: boolean;
  /** 内容深度维度：思考/工具结果 true 展开全文、false 单行摘要 */
  full: boolean;
}

/**
 * 锚点折叠视图决策（纯函数：消息流 → 逐条渲染决策）：
 * 以「▶ 阶段行与正文回复」为锚点切分阶段组——▶ 行开启新组，正文收编当前组（连续流式切块并入同组），
 * 已收正文后的新过程行开启下一组；每个组独立保留折叠概要，过程行不再挤进单一桶导致中间阶段概要丢失。
 * 默认视图：最近正文组及其后的进行中组全行可见，更早的每组折叠为「▶ 行 + 正文 + 首个工具调用对 + 首个思考行」；
 * expandAll（Tab，第一层）解除全部行折叠、不改变内容深度；
 * latestFull（Ctrl+O，第二层）把最近正文组及其后阶段的思考与工具结果展开为全文。
 * 会话尚无任何正文时全部视作进行中（全行摘要）：Tab 不产生详情效果、Ctrl+O 直达全文（无历史组可折叠）。
 * user/system 消息是对话骨架，恒显示、不参与折叠。
 */
export function buildTranscriptDecisions(
  messages: ChatItem[],
  view: { expandAll: boolean; latestFull: boolean },
): ItemRenderDecision[] {
  const foldable = (m: ChatItem): boolean => m.role === 'thinking' || m.role === 'tool';
  const n = messages.length;
  // 组切分：▶ 行开启新组；正文收编当前组（连续切块并入），已收正文后的非连续正文/新过程行开启下一组
  const groupOf: number[] = new Array(n).fill(0);
  let g = -1;
  let groupHasBody = false;
  let recentBodyGroup = -1;
  for (let i = 0; i < n; i++) {
    const role = messages[i].role;
    const prevIsAssistant = i > 0 && messages[i - 1].role === 'assistant';
    if (role === 'step') {
      g = g < 0 ? 0 : g + 1;
      groupHasBody = false;
    } else if (role === 'assistant') {
      if (g < 0) g = 0;
      else if (groupHasBody && !prevIsAssistant) {
        g += 1;
        groupHasBody = false;
      }
      groupHasBody = true;
      recentBodyGroup = g;
    } else {
      if (g < 0) g = 0;
      else if (groupHasBody) {
        g += 1;
        groupHasBody = false;
      }
    }
    groupOf[i] = g;
  }
  if (recentBodyGroup < 0) {
    // 无任何正文锚点：全部视作进行中（全行摘要）——Tab 不产生详情，Ctrl+O 直达全文
    return messages.map((m) => ({ visible: true, full: foldable(m) && view.latestFull }));
  }
  const out: ItemRenderDecision[] = messages.map(() => ({ visible: true, full: view.expandAll }));
  let prevGroup = -1;
  let keptThinking = false;
  let keptTool = false;
  let prevCallKept = false;
  for (let i = 0; i < n; i++) {
    const m = messages[i];
    if (groupOf[i] !== prevGroup) {
      keptThinking = false;
      keptTool = false;
      prevCallKept = false;
      prevGroup = groupOf[i];
    }
    if (m.role === 'user' || m.role === 'system' || !foldable(m)) {
      out[i] = { visible: true, full: false }; // 对话骨架/▶ 行/正文恒显示
      prevCallKept = false;
      continue;
    }
    const inRecent = groupOf[i] >= recentBodyGroup;
    if (inRecent || view.expandAll) {
      out[i] = { visible: true, full: inRecent && view.latestFull };
      prevCallKept = m.role === 'tool' && m.kind === 'call';
      continue;
    }
    if (m.role === 'thinking') {
      const keep = !keptThinking;
      keptThinking = true;
      prevCallKept = false;
      out[i] = { visible: keep, full: false };
      continue;
    }
    if (m.kind === 'call') {
      const keep = !keptTool;
      keptTool = true;
      prevCallKept = keep;
      out[i] = { visible: keep, full: false };
      continue;
    }
    // 结果行跟随其调用行成对同隐同显
    out[i] = { visible: prevCallKept, full: false };
    prevCallKept = false;
  }
  return out;
}

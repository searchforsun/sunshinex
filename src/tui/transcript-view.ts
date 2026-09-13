import { ChatItem } from './session';

export interface ItemRenderDecision {
  /** 行折叠维度下该条目是否上屏 */
  visible: boolean;
  /** 内容深度维度：思考/工具结果 true 展开全文、false 单行摘要 */
  full: boolean;
}

/**
 * 锚点分段折叠视图决策（纯函数：消息流 → 逐条渲染决策）：
 * 对标「先说要干什么、再做」的叙述结构——正文回复与 ▶ 阶段行是锚点、各自开段，
 * 工具与思考隶属其前锚点（后面的过程属于前面的正文）；user/system 骨架行开段恒显，
 * 开场尚无锚点的过程随首段呈现。锚点落定即收拢上一段（边跑边收，不等任务结束）：
 * 默认仅最后一段（当前活动）全行可见，更早的每段折叠为「锚点行 + 首个工具调用对 + 首个思考行」。
 * expandAll（Tab，第一层）解除全部行折叠、不改变内容深度；
 * latestFull（Ctrl+O，第二层）把最近两段（当前活动段及其前一阶段）的思考与工具结果展开为全文。
 * 正文连续流式切块并入同段不裂段；user/system 恒显示、不参与折叠。
 */
export function buildTranscriptDecisions(
  messages: ChatItem[],
  view: { expandAll: boolean; latestFull: boolean },
): ItemRenderDecision[] {
  const foldable = (m: ChatItem): boolean => m.role === 'thinking' || m.role === 'tool';
  const n = messages.length;
  // 切段：骨架行（user/system/step）与正文开段，正文连续切块并入同段，过程行隶属当前段
  const segOf: number[] = new Array(n).fill(0);
  let seg = -1;
  for (let i = 0; i < n; i++) {
    const role = messages[i].role;
    if (role === 'assistant') {
      const prevIsAssistant = i > 0 && messages[i - 1].role === 'assistant';
      if (!prevIsAssistant) seg += 1;
    } else if (role !== 'thinking' && role !== 'tool') {
      seg += 1;
    } else if (seg < 0) {
      seg = 0; // 防御：无骨架行开头的过程行随首段呈现
    }
    segOf[i] = seg;
  }
  const lastSeg = seg;
  // 全文作用域：最近两段（当前活动段及其前一阶段）——最新正文与其隶属过程一并可展开
  const fullScopeStart = Math.max(0, lastSeg - 1);
  const out: ItemRenderDecision[] = messages.map(() => ({ visible: true, full: view.expandAll }));
  let prevSeg = -1;
  let keptThinking = false;
  let keptTool = false;
  let prevCallKept = false;
  for (let i = 0; i < n; i++) {
    const m = messages[i];
    if (segOf[i] !== prevSeg) {
      keptThinking = false;
      keptTool = false;
      prevCallKept = false;
      prevSeg = segOf[i];
    }
    if (m.role === 'user' || m.role === 'system' || !foldable(m)) {
      out[i] = { visible: true, full: false }; // 骨架行/▶ 行/正文恒显示
      prevCallKept = false;
      continue;
    }
    const inFullScope = segOf[i] >= fullScopeStart;
    if (segOf[i] === lastSeg || view.expandAll) {
      out[i] = { visible: true, full: inFullScope && view.latestFull };
      prevCallKept = m.role === 'tool' && m.kind === 'call';
      continue;
    }
    if (m.role === 'thinking') {
      const keep = !keptThinking;
      keptThinking = true;
      prevCallKept = false;
      out[i] = { visible: keep, full: inFullScope && view.latestFull };
      continue;
    }
    if (m.kind === 'call') {
      const keep = !keptTool;
      keptTool = true;
      prevCallKept = keep;
      out[i] = { visible: keep, full: inFullScope && view.latestFull };
      continue;
    }
    // 结果行跟随其调用行成对同隐同显
    out[i] = { visible: prevCallKept, full: prevCallKept && inFullScope && view.latestFull };
    prevCallKept = false;
  }
  return out;
}

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
 * **system 说明行（压缩/队列/记忆·技能沉淀/漂移提示）不开段**：它们是行内注解而非会话轮次，
 * 否则收口后尾追的 notice 行会把刚发生的思考挤出「最近两段」全文作用域（规格 §10 notice 尾追纪律）。
 */
export function buildTranscriptDecisions(
  messages: ChatItem[],
  view: { expandAll: boolean; latestFull: boolean },
): ItemRenderDecision[] {
  const foldable = (m: ChatItem): boolean => m.role === 'thinking' || m.role === 'tool';
  const n = messages.length;
  // 切段：会话骨架行（user 指令行 / assistant 正文）开段，正文连续切块并入同段，过程行隶属当前段。
  // system 说明行（压缩/队列/记忆·技能沉淀/漂移提示等）是行内注解而非会话轮次，**不新开段**：
  // 否则收口后尾追的 notice 行会把刚发生的思考挤出「最近两段」全文作用域（Ctrl+O 展开态被莫名收拢，规格 §10 notice 尾追纪律）。
  const segOf: number[] = new Array(n).fill(0);
  let seg = -1;
  for (let i = 0; i < n; i++) {
    const role = messages[i].role;
    if (role === 'assistant') {
      const prevIsAssistant = i > 0 && messages[i - 1].role === 'assistant';
      if (!prevIsAssistant) seg += 1;
    } else if (role === 'user' || role === 'step') {
      // ▶ 阶段行与 user 指令行、正文同为锚点、各自开段（阶段前的过程归上一段）：
      // 漏掉 step 会让整场阶段挤进同一段——非末段的「留一组概要」全部失效（▶ 行之间空着），
      // 且 Ctrl+O 的「最近两段」作用域覆盖全场、一次展开所有阶段（用户本机实测形态）。
      seg += 1;
    } else if (seg < 0) {
      seg = 0; // 防御：无骨架行开头的过程行/说明行随首段呈现
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

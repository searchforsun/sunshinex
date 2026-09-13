import { ChatItem } from './session';

export interface ItemRenderDecision {
  /** 行折叠维度下该条目是否上屏 */
  visible: boolean;
  /** 内容深度维度：思考/工具结果 true 展开全文、false 单行摘要 */
  full: boolean;
}

/**
 * 锚点折叠视图决策（纯函数：消息流 → 逐条渲染决策）：
 * 以正文回复为锚点切分阶段桶——每个桶 = 该正文之前的全部过程行（思考/工具/▶ 阶段行）+ 正文本身，
 * 不依赖模型是否携带 ▶ 阶段行。默认态最近正文锚点桶与其后的进行中桶全行可见，
 * 更早的桶折叠为「正文 + 首个思考行 + 首个工具调用对」；expandAll（Tab，第一层）解除全部行折叠；
 * latestFull（Ctrl+O，第二层）把最近正文锚点桶及其后阶段的思考与工具结果展开为全文。
 * 会话尚无任何正文时全部视作进行中的首个桶（全行摘要）——正文落定即成为锚点、下一正文到达时收拢。
 * user/system 消息是对话骨架，恒显示、不参与折叠。
 */
export function buildTranscriptDecisions(
  messages: ChatItem[],
  view: { expandAll: boolean; latestFull: boolean },
): ItemRenderDecision[] {
  const foldable = (m: ChatItem): boolean => m.role === 'thinking' || m.role === 'tool';
  const n = messages.length;
  const out: ItemRenderDecision[] = messages.map(() => ({ visible: true, full: view.expandAll }));
  // 桶切分：assistant 即桶尾（正文锚点），其后开启新桶；尾桶为进行中（正文未出）
  const buckets: { start: number; end: number; hasBody: boolean }[] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (messages[i].role === 'assistant') {
      buckets.push({ start, end: i, hasBody: true });
      start = i + 1;
    }
  }
  if (start < n || buckets.length === 0) buckets.push({ start, end: n - 1, hasBody: false });
  let recentBodyBucket = -1;
  for (let k = buckets.length - 1; k >= 0; k--) {
    if (buckets[k].hasBody) {
      recentBodyBucket = k;
      break;
    }
  }
  if (recentBodyBucket < 0) return out; // 无任何正文锚点：全部视作进行中首桶（全行摘要）
  buckets.forEach((b, k) => {
    const inRecentScope = k >= recentBodyBucket;
    let keptThinking = false;
    let keptTool = false;
    let prevCallKept = false;
    for (let i = b.start; i <= b.end; i++) {
      const m = messages[i];
      if (m.role === 'user' || m.role === 'system' || !foldable(m)) {
        // 对话骨架与正文锚点恒显示；正文/阶段行无 detail 概念，full 恒 false
        out[i] = { visible: true, full: false };
        prevCallKept = false;
        continue;
      }
      if (inRecentScope || view.expandAll) {
        out[i] = { visible: true, full: inRecentScope && view.latestFull };
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
  });
  return out;
}

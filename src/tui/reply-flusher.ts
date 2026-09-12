/** 单段入档行数上限：无段落边界的超长段（长列表/大段文字）按最近换行兜底切块，防预览积压、滚动缓冲迟迟不增长 */
export const REPLY_SEGMENT_MAX_LINES = 24;

/**
 * 流式正文安全点切块（纯函数）：从 pending = text.slice(committedLen) 中取可入档子串，无安全点返回 null。
 * 规则（对标 Claude Code 打字机式滚动出稿）：
 * 1. 围栏代码块（行首 ```）开→闭之间零切点（含围栏内空行），闭合后恢复段落切分——整块入档保住高亮与结构；
 * 2. 段落边界（空行）优先：切点取最靠后的边界（seg 含边界空行的换行）；
 * 3. 闭态区域连续超过 maxLines 个完整行仍无边界 → 按最近换行兜底切块（此后重新计数）；
 * 4. 返回值恒为 text 的严格中缀且原样保留换行——分块拼接 === 终稿，session 侧前缀去重不重复不丢失。
 */
export function stableReplySegment(
  text: string,
  committedLen: number,
  maxLines: number = REPLY_SEGMENT_MAX_LINES,
): string | null {
  const pending = text.slice(committedLen);
  if (pending.length === 0) return null;
  // committedLen 可能落在任意位置：以最近完整行为界，由前缀围栏行奇偶推导初始开闭态（不依赖切点分布假设）
  const committedPrefix = text.slice(0, committedLen);
  const lastNl = committedPrefix.lastIndexOf('\n');
  const head = lastNl >= 0 ? committedPrefix.slice(0, lastNl + 1) : '';
  let fenceOpen = false;
  for (const line of head.split('\n')) {
    if (/^\s*```/.test(line)) fenceOpen = !fenceOpen;
  }
  const lines = pending.split('\n');
  let cut = -1; // 已确认的最大安全切点（seg = pending.slice(0, cut)，含结尾换行）
  let closedLineStreak = 0; // 围栏闭态区域连续完整行数（超长兜底计数）
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    if (/^\s*```/.test(line)) {
      fenceOpen = !fenceOpen;
      closedLineStreak = 0;
      if (!isLast) offset += line.length + 1;
      continue;
    }
    if (isLast) break; // 生成中的最后一行（无换行结尾）：永不切
    const candidate = offset + line.length + 1; // 行末换行之后（含换行）
    if (fenceOpen) {
      offset = candidate; // 围栏内容（含空行）：不产生切点
      continue;
    }
    if (line === '') {
      cut = candidate; // 段落边界：总是取最靠后的边界
      closedLineStreak = 0;
    } else {
      closedLineStreak += 1;
      if (closedLineStreak >= maxLines) {
        cut = candidate; // 超长段兜底：按最近换行切，重新计数
        closedLineStreak = 0;
      }
    }
    offset = candidate;
  }
  if (cut <= 0) return null;
  return pending.slice(0, cut);
}

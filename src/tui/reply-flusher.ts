/** 单段入档行数上限：无段落边界的超长段（长列表/大段文字）按最近换行兜底切块，防预览积压、滚动缓冲迟迟不增长 */
export const REPLY_SEGMENT_MAX_LINES = 24;

/** GFM 表格分隔行（| --- | --- | 形态）：仅含 |、-、: 与空白 */
function isTableDivider(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith('|')) return false;
  const cells = t
    .slice(1)
    .replace(/\|\s*$/, '')
    .split('|');
  return cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

/**
 * 流式正文安全点切块（纯函数）：从 pending = text.slice(committedLen) 中取可入档子串，无安全点返回 null。
 * 规则（对标 Claude Code 打字机式滚动出稿）：
 * 1. 围栏代码块（行首 ```）开→闭之间零切点（含围栏内空行），闭合后恢复段落切分——整块入档保住高亮与结构；
 * 2. GFM 表格（表头+分隔行成对开启，空行/非表格行闭合）期间零切点——闭合即整表放行（切点回退至表格末行换行处，不等后续段落边界），防表体切碎降级或整表滞留预览区；
 * 3. 段落边界（空行）优先：切点取最靠后的边界（seg 含边界空行的换行）；
 * 4. 闭态区域连续超过 maxLines 个完整行仍无边界 → 按最近换行兜底切块（此后重新计数）；
 * 5. 返回值恒为 text 的严格中缀且原样保留换行——分块拼接 === 终稿，session 侧前缀去重不重复不丢失。
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
  let tableOpen = false;
  for (const line of head.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenceOpen = !fenceOpen;
      tableOpen = false;
      continue;
    }
    if (fenceOpen) continue;
    tableOpen = /^\s*\|/.test(line);
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
      tableOpen = false;
      closedLineStreak = 0;
      if (!isLast) offset += line.length + 1;
      continue;
    }
    const tableLine = /^\s*\|/.test(line);
    let tableClosedHere = false;
    if (tableOpen && !tableLine) {
      tableOpen = false; // 非表格行（含空行/流式尾行）闭合表格：恢复段落切分
      tableClosedHere = true; // 整表已带换行完结：无论闭合行本身是否完整，表格本体均可立即放行
      closedLineStreak = 0;
    }
    if (isLast) {
      // 生成中的最后一行（无换行结尾）永不切；但表格恰在此处闭合时，切点回退至表格末行换行处，整表立即入档
      if (tableClosedHere) cut = offset;
      break;
    }
    if (!tableOpen && tableLine && isTableDivider(lines[i + 1])) {
      tableOpen = true; // 表头 + 分隔行成对出现：表格开启（自表头行起保护，防表头与分隔行被分离）
    }
    const candidate = offset + line.length + 1; // 行末换行之后（含换行）
    if (fenceOpen || tableOpen) {
      offset = candidate; // 围栏/表格内容（含其内空行）：零切点，整块等待闭合后随边界放行
      continue;
    }
    if (tableClosedHere || line === '') {
      cut = candidate; // 表格刚闭合（整表随切点放行）或段落边界：取最靠后的安全切点
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

/** 单段入档行数上限：仅围栏内兜底切块消费（长围栏生成期滚动出稿的节奏）。
 *  10 行（2026-09-30 流畅度裁决）：长围栏按此节奏放行，预览窗在代码块生成期不积超过 ~11 行 */
export const REPLY_SEGMENT_MAX_LINES = 10;

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
 * 规则（2026-09-30 完整流式裁决——逐行打字机）：
 * 1. 短围栏零切点（含围栏内空行），闭合后整块放行——保住结构；超过 maxLines 的长围栏按行数兜底切块
 *    （生成期滚动出稿，与普通超长段同量级），切块自带开栏行、入档块独立成立，openFenceOpener 承接续块与预览；
 * 2. GFM 表格（表头+分隔行成对开启，空行/非表格行闭合）期间零切点——闭合即整表放行（切点回退至表格末行换行处，不等后续边界），防表体切碎降级或整表滞留预览区；
 *    流式窗口期：完结的表格行在下一行未到达前守候不切（可能是表头，先切即表头与分隔行分家、整表降级裸文本）；
 * 3. 闭态区域任一完结行即可切：切点取最靠后的完结行（seg 含结尾换行）——打字机效果 = 入档内容
 *    逐行小步推进 Static 滚动，预览窗只剩生成中的未完行；段内换行经 softbreak→\n 渲染同形、
 *    段间隙经 ChatItem.cont 折叠（session 标记段中续块），逐行块与整段块渲染恒等；
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
  let fenceLineStreak = 0; // 围栏内连续完整行数（长围栏兜底计数）
  let fenceCutDone = false; // 本次扫描内长围栏兜底已切一刀：固定 maxLines 节奏，其余随后续 delta/闭合放行
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    if (/^\s*```/.test(line)) {
      fenceOpen = !fenceOpen;
      tableOpen = false;
      if (!fenceOpen) {
        fenceLineStreak = 0; // 围栏闭合：兜底计数复位，后续行恢复逐行切分
      } else {
        fenceLineStreak = 0; // 新围栏开栏：兜底计数与「已切一刀」标记复位
        fenceCutDone = false;
      }
      if (!isLast) offset += line.length + 1;
      continue;
    }
    const tableLine = /^\s*\|/.test(line);
    let tableClosedHere = false;
    if (tableOpen && !tableLine && !(isLast && line === '')) {
      // 非表格行闭合表格；流式尾部空 remainder（split('\n') 伪行、非真实行）不算闭合——
      // 它只说明「上一行带换行完结」，表格是否还有后续数据行未知，切出会致表头块与表体分离降级
      tableOpen = false;
      tableClosedHere = true;
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
    // 表格候选行守候（逐行切点的流式补丁，2026-09-30「表格没了」实锤）：完结的表格行若下一行
    // 尚未到达（尾空 remainder），不得立即切——它可能是表头，先切即表头与分隔行分家、整表降级为
    // 逐行裸文本。守候到下一行定型：分隔行 → 表格开启整块保护；普通行 → 照常逐行切（杂散管道行）
    if (!tableOpen && tableLine && lines[i + 1] !== undefined && lines[i + 1] === '') {
      offset = candidate;
      continue;
    }
    if (fenceOpen) {
      // 围栏内：短围栏零切点整块等待闭合；超过 maxLines 按行数兜底切一刀——
      // 生成期滚动出稿、闭合时残余一并放行（入档块自带开栏行独立成立，预览由 openFenceOpener 承接）
      fenceLineStreak += 1;
      if (fenceLineStreak >= maxLines && !fenceCutDone) {
        cut = candidate;
        fenceCutDone = true;
      }
      offset = candidate;
      continue;
    }
    if (tableOpen) {
      offset = candidate; // 表格内容（含其内空行）：零切点，整块等待闭合后随边界放行
      continue;
    }
        cut = candidate; // 逐行切点（完整流式裁决）：表格闭合/空行/任一完结行即可入档，见文件头规则 3
        offset = candidate;
  }
  if (cut <= 0) return null;
  return pending.slice(0, cut);
}

/** 最近一次进入围栏的开栏行（未闭合时非空）：入档切块越过开栏行后，预览续块补上该行即可延续代码块呈现 */
export function openFenceOpener(text: string): string {
  let opener = '';
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      opener = opener === '' ? line : '';
    }
  }
  return opener;
}

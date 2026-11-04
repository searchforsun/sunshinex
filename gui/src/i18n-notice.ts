import { getLanguage } from './i18n';

/**
 * 命令回执/系统提示行本地化（渲染层**固定头**翻译；2026-11-04 裁定细化：正文/思考/工具行之外的
 * 固定系统提示与固定告警头随 GUI 语言渲染——**动态内容不经由本表**，按捕获组原样透传，工具行与
 * 思考行头此前已同口径实现）。daemon 面（2026-11-04 收敛）恒规范英文单语产出，本表即语言门：
 * GUI 中文时按模式表映射，GUI 英文时整行透传——落档字节恒不动，纯显示面翻译。未命中的行原样
 * 透出（未知/新增回执兜底，不丢信息）。模式表与 daemon 文案人工同源：新增固定提示须两处同添
 * （文案源=src/serve/session-commands.ts、src/serve/session.ts 的 notice/pump 面与
 * src/harness/tools/builtin.ts 的 exit_plan 裁决回执，恒英文）。
 */

/** 模式表：正则（捕获组透传）→ 中文模板（$1..$n 引用捕获组）。顺序即匹配序（先专后泛、整块先于前缀） */
const PATTERNS: ReadonlyArray<{ re: RegExp; zh: string }> = [
  // —— exit_plan 裁决回执（工具行包裹的固定系统提示；harness/tools/builtin.ts executor，
  //    ToolEntry 展开体经 localizeNotice 渲染）——
  { re: /^plan approved — implement via full access; maintain progress with todo_write as you go$/, zh: '计划已批准——以完全访问实施；用 todo_write 保持进度' },
  { re: /^plan approved — implement via workspace edits; maintain progress with todo_write as you go$/, zh: '计划已批准——以工作区编辑实施；用 todo_write 保持进度' },
  { re: /^re-plan requested — revise the plan per this feedback and call exit_plan again: ([\s\S]+)$/, zh: '请求重新计划——按此反馈修订计划后再次调用 exit_plan：$1' },
  { re: /^plan discarded — continue the current task normally; do not resubmit unless the user asks$/, zh: '计划已弃——继续当前任务；除非用户要求，不要重新提交' },
  // —— /plan 全族（session-commands.ts /plan 分支 + session.ts 弃卡/裁决诊断）——
  { re: /^Plan mode on — submissions will be planned first$/, zh: '已进入计划模式：提交将先规划再确认实施' },
  { re: /^Already in plan mode$/, zh: '已处于计划模式' },
  { re: /^Left plan mode$/, zh: '已退出计划模式' },
  { re: /^Not in plan mode$/, zh: '当前不在计划模式' },
  { re: /^Busy — leave plan mode when the session is idle$/, zh: '会话忙——空闲后再退出计划模式' },
  { re: /^Queued — planning will start when the current task finishes$/, zh: '已入队：当前任务收口后将先规划' },
  { re: /^Planning interrupted$/, zh: '规划已中断' },
  // —— 挂起裁决诊断行（session.ts pump：approval/ask 回执提示）——
  { re: /^approval (\S+) resolved: allow$/, zh: '审批 $1 已裁决：允许' },
  { re: /^approval (\S+) resolved: deny$/, zh: '审批 $1 已裁决：拒绝' },
  { re: /^approval (\S+) resolved: always$/, zh: '审批 $1 已裁决：总是允许' },
  { re: /^ask (\S+) answered$/, zh: '问询 $1 已作答' },
  // —— /compact ——
  { re: /^Compressed: (\d+) summary chunks re-injected \(ctx (\d+) → (\d+) tokens\)$/, zh: '已压缩：$1 个摘要块重注入（水位 $2 → $3 tokens）' },
  { re: /^Context compacted \(ctx (\d+) → (\d+) tokens\)$/, zh: '上下文已压缩（水位 $1 → $2 tokens）' },
  { re: /^Compacting context…?$/, zh: '上下文压缩中' },
  { re: /^Context compaction interrupted$/, zh: '上下文压缩已中断' },
  // —— /context：整块匹配保正文（明细行=语言中性标识符+数字），仅头与尾总量本地化——
  //    旧「裸前缀命中即整替」会吞掉明细正文，先整块后前缀兜底
  { re: /^Context breakdown:([\s\S]*?)\ntotal (\d+) \/ (\d+)$/, zh: '上下文构成：$1\n总量 $2 / $3' },
  { re: /^Context breakdown:([\s\S]*)$/, zh: '上下文构成：$1' },
  // —— /skills-rm ——
  { re: /^Learned skill removed: (.+)$/, zh: '已删除学习技能：$1' },
  { re: /^No learned skill '(.+)' in this workspace$/, zh: '本工作区没有学习技能 "$1"' },
  { re: /^Usage: (\/skills-rm <id>) — remove a learned skill from this workspace$/, zh: '用法：$1——删除本工作区的一个学习技能' },
  // —— /memory-on|off ——
  { re: /^Persistent memory on for this session$/, zh: '本会话持久记忆已开启' },
  { re: /^Persistent memory off for this session$/, zh: '本会话持久记忆已关闭' },
  // —— /archive /unarchive /delete ——
  { re: /^Nothing to archive yet$/, zh: '暂无可归档的会话档' },
  { re: /^Session archived$/, zh: '已归档' },
  { re: /^Nothing to unarchive yet$/, zh: '暂无可撤销归档的会话档' },
  { re: /^Session is not archived$/, zh: '该会话未在归档中' },
  { re: /^Session unarchived$/, zh: '已撤销归档' },
  { re: /^Nothing to delete yet$/, zh: '暂无可删除的会话档' },
  { re: /^Archive first \(\/archive\), then \/delete$/, zh: '先归档（/archive）再删除' },
  { re: /^Session deleted$/, zh: '已删除' },
  // —— /status（状态词闭集拆分映射,未知状态词落泛式透传）与命令中断泛式（尾部兜底）——
  { re: /^session (\S+) · running · model (.+?) · mode (.+)$/, zh: '会话 $1 · 运行中 · 模型 $2 · 权限 $3' },
  { re: /^session (\S+) · idle · model (.+?) · mode (.+)$/, zh: '会话 $1 · 空闲 · 模型 $2 · 权限 $3' },
  { re: /^session (\S+) · (\S+) · model (.+?) · mode (.+)$/, zh: '会话 $1 · $2 · 模型 $3 · 权限 $4' },
  { re: /^(\/[\w-]+) interrupted$/, zh: '$1 已中断' },
];

/** 命令回执本地化单点：GUI 英文整行透传（en 用户看 en——强翻中文即 e2e 'resolved: allow' 断言
 *  撕裂的根因）；中文时逐一试模式，命中按捕获组回填中文模板，未命中原样返回 */
export function localizeNotice(md: string): string {
  if (getLanguage() !== 'zh') return md;
  for (const { re, zh } of PATTERNS) {
    const m = re.exec(md);
    if (m === null) continue;
    return zh.replace(/\$(\d)/g, (_, d) => m[Number(d)] ?? '');
  }
  return md;
}

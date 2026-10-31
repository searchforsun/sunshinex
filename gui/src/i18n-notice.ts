/**
 * 命令回执本地化（2026-10-31 用户裁定「命令执行结果 GUI 支持 i18n」）：daemon 面回执恒英文单语
 * （落档契约=提示词面），GUI 渲染层按已知前缀模式映射中文——档面字节不动，纯显示面翻译。
 * 未命中模式的行原样透出（未知/新命令回执英文兜底，不丢信息）。
 */

/** 模式表：正则（捕获组透传）→ 中文模板（$1..$n 引用捕获组）。顺序即匹配序（先专后泛） */
const PATTERNS: ReadonlyArray<{ re: RegExp; zh: string }> = [
  { re: /^Compressed: (\d+) summary chunks re-injected \(ctx (\d+) → (\d+) tokens\)$/, zh: '已压缩：$1 个摘要块重注入（水位 $2 → $3 tokens）' },
  { re: /^Context compacted \(ctx (\d+) → (\d+) tokens\)$/, zh: '上下文已压缩（水位 $1 → $2 tokens）' },
  { re: /^Compacting context…$/, zh: '上下文压缩中…' },
  { re: /^Learned skill removed: (.+)$/, zh: '已删除学习技能：$1' },
  { re: /^No learned skill '(.+)' in this workspace$/, zh: '本工作区没有学习技能 "$1"' },
  { re: /^Usage: (\/skills-rm <id>) — remove a learned skill from this workspace$/, zh: '用法：$1——删除本工作区的一个学习技能' },
  { re: /^Context breakdown/, zh: '上下文构成' },
  { re: /^session (\S+) · (\S+) · model (.+?) · mode (.+)$/, zh: '会话 $1 · $2 · 模型 $3 · 权限 $4' },
  { re: /^total (\d+) \/ (\d+)$/, zh: '总量 $1 / $2' },
];

/** 命令回执本地化单点：逐一试模式，命中按捕获组回填中文模板；未命中原样返回 */
export function localizeNotice(md: string): string {
  for (const { re, zh } of PATTERNS) {
    const m = re.exec(md);
    if (m === null) continue;
    return zh.replace(/\$(\d)/g, (_, d) => m[Number(d)] ?? '');
  }
  return md;
}

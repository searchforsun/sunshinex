/** 辅助会话 fork 注入说明(2026-11-06 用户裁定「fork 时给模型加说明,但不进用户气泡」):
 *  首条播种把说明前缀拼进首条用户消息(模型上下文可见),渲染侧(sideChat)经 stripSideNote
 *  剥离——上下文与显示分离,说明恒不渲染成气泡正文(重启重放同径,前缀确定性可剥) */
const SIDE_NOTE_HEAD = '[Side chat] The context above is forked from main chat session "';

export function buildSideNote(mainTitle: string): string {
  return `${SIDE_NOTE_HEAD}${mainTitle}". This is a side conversation for auxiliary discussion and small tasks around the main chat's content; it does not affect the main session. The request below follows:\n\n`;
}

/** 显示侧剥离:命中注入说明头部即剥到首个空行(说明以 \n\n 收尾,其后才是用户真实请求) */
export function stripSideNote(md: string): string {
  const at = md.indexOf(SIDE_NOTE_HEAD);
  if (at !== 0) return md;
  const sep = md.indexOf('\n\n');
  return sep >= 0 ? md.slice(sep + 2) : md;
}

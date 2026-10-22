/** 会话 id 安全面（单点）：id 寻址会话注册表与 journal 文件名——形态收紧为
 *  [A-Za-z0-9_-]{1,128}（session-handlers 与 daemon 装配点共用；叶子模块防 serve 域
 *  拆分后的 require 环，消费方经 session-handlers 原路径再导出取用） */
export function validSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

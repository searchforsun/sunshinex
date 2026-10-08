/** 拼出带 token 查询参数的本机 GUI 地址（daemon 静态服务监听 127.0.0.1）。 */
export function appUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

/** 拼出带 token 查询参数的本机 GUI 地址（daemon 静态服务监听 127.0.0.1）。
 *  回环字面量就地维护：壳与主仓零编译期耦合（daemon 以子进程装配），不跨包 import
 *  src/serve 的 LOOPBACK_HOST——两处语义须人工对齐（改绑定面时同步此处）。 */
export function appUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

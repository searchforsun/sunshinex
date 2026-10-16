import * as fs from 'node:fs';
import * as path from 'node:path';
import { isWithin } from '../paths';

/** 静态资源与文件读取原语（D31 分域拆分自 daemon.ts）：mime 表、静态读、realpath 归一、信任根
 *  判界、有界读（预览三态）与 URL 段安全解码——叶子模块，daemon 路由面与 file/diff 树域共用。
 */

/** 文件预览上限（G6 /file 端点，512KB）：≤ 上限全文回执；> 上限读首 512KB + truncated:true
 *  （预览语义而非 413——Ruling 1 修正：截断标记让 GUI 呈现「文件过大已截断」而非直接拒读） */
export const MAX_PREVIEW_BYTES = 512 * 1024;

/** 二进制探测窗（首 8KB）：UTF-8 文本不含 \0，命中即按二进制拒（415）——预览面只服务文本 */
export const BINARY_PROBE_BYTES = 8 * 1024;

/** 静态缺失提示（G1 裁定恒定文案；G3 起 dist-gui 在场则 GET 挂静态，缺场仍回此形态） */
export const GUI_ASSETS_HINT = 'GUI assets not built — run pnpm --filter gui build (G2)';

/** 静态 mime 表（G3）：按扩展名映射，缺省 application/octet-stream（浏览器按 Content-Type 处置，
 *  未知类型不猜测——下载面行为由客户端定） */
const STATIC_MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function mimeOf(file: string): string {
  return STATIC_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** 静态读文件：任何读失败（缺失/目录/权限）归一 null——SPA 兜底与 404 由调用方分径 */
export function readStaticFile(file: string): Promise<Buffer | null> {
  return new Promise((resolve) => fs.readFile(file, (err, data) => resolve(err === null ? data : null)));
}

/** 判界用路径归一（G6 /file 端点；与 SafetyChain.resolveSafe 同口径）：存在段 realpathSync 解析
 * 符号链接（新建段字面拼接——resolve 产物无 .. 残留），防「根内符号链接指向根外」的逃逸；整链无
 * 存在锚（不可达驱动器等）或 realpath 异常回 undefined——调用方回退字面判定（fail-closed 不放行） */
export function realPathOf(abs: string): string | undefined {
  try {
    let anchor = abs;
    while (!fs.existsSync(anchor)) {
      const parent = path.dirname(anchor);
      if (parent === anchor) return undefined; // 盘根都不存在：无锚可归一
      anchor = parent;
    }
    return fs.realpathSync(anchor) + abs.slice(anchor.length);
  } catch {
    return undefined;
  }
}

/** 信任根判定（G6 /file 判界单点；G7 /diff 共用）：主根 rootReal ∪ 活动工作树根（read 工具同口径
 *  信任域；rootReal/activeRoot 是 SafetyChain 仅有公开判定面）。real 已归一（realPathOf ?? 字面兜底） */
export function insideTrustedRoots(safety: { rootReal: string; activeRoot: string | null }, real: string): boolean {
  const roots = [safety.rootReal];
  const active = safety.activeRoot; // worktree 会话的活动根（null=缺省主根态）
  if (active !== null) {
    try {
      roots.push(fs.existsSync(active) ? fs.realpathSync(active) : active);
    } catch {
      roots.push(active);
    }
  }
  return roots.some((r) => real === r || isWithin(r, real));
}

/** 有界读文件（G6 /file 单点；G7 /diff 共用）：≤512KB 全文；>512KB 读首 512KB + truncated:true；
 *  首 8KB 含 \0 按二进制定论（'binary'）；不存在/非文件/读失败归一 'missing'（调用方 404）——
 *  预览语义的读侧三态，判界（insideTrustedRoots）由调用方先行 */
export function readFileBounded(resolved: string): { content: string; truncated: boolean } | 'binary' | 'missing' {
  let st: fs.Stats;
  try {
    st = fs.statSync(resolved);
  } catch {
    return 'missing';
  }
  if (!st.isFile()) return 'missing';
  const truncated = st.size > MAX_PREVIEW_BYTES;
  const len = truncated ? MAX_PREVIEW_BYTES : st.size;
  let buf: Buffer;
  try {
    const fd = fs.openSync(resolved, 'r'); // 只读句柄：预览面零写副作用
    try {
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 'missing';
  }
  // 二进制拒：首 8KB 含 \0 即按二进制定论（UTF-8 文本不含 NUL 字节）
  if (buf.subarray(0, Math.min(buf.length, BINARY_PROBE_BYTES)).includes(0)) return 'binary';
  return { content: buf.toString('utf8'), truncated };
}

/** URL 段解码（G8b T3 pty 升级路径）：坏 % 序列按字面回退（decodeURIComponent throw 面）——
 *  未命中注册表即 error 帧，fail-closed */
export function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

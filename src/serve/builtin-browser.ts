/**
 * 内置浏览器融合·宿主侧单点（D61 外提，session-lifecycle 先例同法）：daemon 的浏览器收割/meta
 * 周期写两面以纯函数承载（工作区 roots / facade ws 经参注入，零类状态触点），daemon 留薄委托。
 * 装配面（startFacadeOnce + 周期计时器）留 daemon——触 daemon 生命周期字段（builtinFacade/
 * builtinMetaTimer）与 close 收口序，属装配不属于本域。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveDataDir } from '../config/data-dir';

/** 融合 meta 落位单点（收割/清扫/meta 周期写/file-handlers 代理面四面共用） */
export function builtinCdpMetaPath(dataDir: string): string {
  return path.join(dataDir, 'plugins', 'browser-use', 'builtin-cdp.json');
}

/** 兜底扫描进程名与命令行特征（J1 取舍声明）：引擎假设=Chrome 系——browser-use 桥经注册表
 *  解析/固定候选拉起的是 chrome.exe（含 Edge 走 chrome 兼容名）；插件若换 chromium/edge 内核或
 *  显式 executablePath 改名，需同步扩名。匹配面=命令行含 browser-use profile 路径特征（正/反
 *  斜杠两种形态）与 isolated 临时档前缀，不按窗口标题等易漂移面 */
const REAP_PS_PROCESS_FILTER = "Name='chrome.exe'";
const REAP_PS_CMDLINE_PATTERNS = [
  '*plugins/browser-use/profile*',
  '*plugins\\browser-use\\profile*',
  '*sunshinex-browser-*',
];
const REAP_PS_TIMEOUT_MS = 15_000;

/** 内置浏览器常驻实例收割（2026-11-01 用户裁定「应用停止时,也要停止内置本地 mcp服务」）：
 *  builtin 档浏览器为 detached 孤儿（跨 run 树杀存活的常驻设计，复用面靠 meta），应用退出时
 *  全量收割——mcpClose 树杀 bridge/server 已含于 dispose，唯孤儿浏览器需此补刀。两刀：
 *  ①按各工作区 meta pid（跨工作区同 pid 去重；缺档/坏档=扑空静默）②按命令行 profile 标记
 *  兜底（meta 被删/坏档时①扑空，而 profile 缺省在数据目录内 → 孤儿浏览器锁死整棵数据目录
 *  树，用户面「应用关了文件夹删不掉」——不依赖 meta 扫 chrome 补刀）。全同步 spawnSync：
 *  调用点即完成，不会被壳侧有界 close 截断在半途 */
export function reapBuiltinBrowsers(roots: Array<string>): void {
  const killedBrowsers = new Set<number>();
  for (const root of roots) {
    try {
      const meta = JSON.parse(fs.readFileSync(builtinCdpMetaPath(resolveDataDir(root)), 'utf8')) as { pid?: unknown; kind?: unknown };
      // M2 融合档(kind:'shell'):meta 指向壳内 facade,pid=壳进程自身——绝不可杀(等于自杀)
      if (meta.kind === 'shell') continue;
      const pid = meta.pid;
      if (typeof pid !== 'number' || pid <= 0 || pid === process.pid || killedBrowsers.has(pid)) continue;
      killedBrowsers.add(pid);
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 尽力 */ } }
      }
    } catch {
      /* 缺档/坏档=无内置浏览器运行 */
    }
  }
  // M2 融合档元数据清扫:kind:'shell' 指针档随 daemon 退场删除(死端口 meta 留盘误导 GUI 代理/判定)
  for (const root of roots) {
    try {
      const metaPath = builtinCdpMetaPath(resolveDataDir(root));
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { kind?: unknown };
      if (meta.kind === 'shell') fs.rmSync(metaPath, { force: true });
    } catch { /* 尽力 */ }
  }
  // 兜底扫描只在确有存活自起浏览器时跑:Windows 下 Chrome 运行期独占持有 <profile>/lockfile,
  // 打不开(EBUSY/EPERM)=该 profile 有浏览器在跑;profile 目录退出后常驻,不能只看存在性。
  // PowerShell 冷启 1~2s 且同步阻塞,无条件跑会把每次 close 都拖慢(满载下越过有界收口上限)
  const profileLive = (profile: string): boolean => {
    try {
      fs.closeSync(fs.openSync(path.join(profile, 'lockfile'), 'r+'));
      return false;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
    }
  };
  const hasLiveBrowser = (): boolean => {
    if (killedBrowsers.size > 0) return true;
    for (const root of roots) {
      if (profileLive(path.join(resolveDataDir(root), 'plugins', 'browser-use', 'profile'))) return true;
    }
    try {
      for (const n of fs.readdirSync(os.tmpdir())) {
        if (!n.startsWith('sunshinex-browser-')) continue;
        const base = path.join(os.tmpdir(), n);
        if (profileLive(base) || profileLive(path.join(base, 'profile'))) return true;
      }
    } catch { /* 尽力 */ }
    return false;
  };
  if (process.platform === 'win32' && hasLiveBrowser()) {
    const where = REAP_PS_CMDLINE_PATTERNS.map((p) => `$_.CommandLine -like '${p}'`).join(' or ');
    const psScript = `Get-CimInstance Win32_Process -Filter "${REAP_PS_PROCESS_FILTER}" | Where-Object { ${where} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    spawnSync('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(psScript, 'utf16le').toString('base64')], { stdio: 'ignore', timeout: REAP_PS_TIMEOUT_MS });
  }
}


/** 删除会话时清理其浏览器状态(2026-11-03 浏览器状态按会话隔离):宿主状态文件 state/<key>.json、
 *  输出目录 output/<key>/,以及桌面侧栏的持久分区 persist:sx-<key>(运行中目录被占用删不掉,
 *  先清空存储——Cookie/本地存储/缓存即刻失效;空目录待下次删除/重装时随用户数据清理) */
export function purgeBrowserState(dataDir: string, key: string): void {
  const base = path.join(dataDir, 'plugins', 'browser-use');
  fs.rmSync(path.join(base, 'state', `${key}.json`), { force: true });
  fs.rmSync(path.join(base, 'output', key), { recursive: true, force: true });
  let electron: unknown;
  try { electron = require('electron'); } catch { return; }
  const ses = (electron as { session?: { fromPartition(p: string): { clearStorageData(): Promise<void>; clearCache(): Promise<void> } } }).session;
  if (ses === undefined) return;
  const s = ses.fromPartition(`persist:sx-${key}`);
  void s.clearStorageData().catch(() => undefined);
  void s.clearCache().catch(() => undefined);
}

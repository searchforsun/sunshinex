import * as fs from 'node:fs';
import * as path from 'node:path';
import { GuiDaemon } from '../../serve/daemon';
import { buildModel } from '../../runtime';
import { resolveDataDir } from '../../config/data-dir';
import { resolveDirArg } from '../index';
import { t } from '../../i18n';
import type { CliArgs } from '../index';

/** 缺省端口（spec §4.3 鉴权/监听裁定的用户面常量）：--port=N 可覆盖；0 仍为临时端口（测试形态） */
export const SERVE_DEFAULT_PORT = 7788;

/**
 * GUI daemon 薄壳入口（spec §3/§4.3）：目录判据同 run/pipeline 统一单点（--workdir 优先、裸词报错），
 * 缺省当前工作区（serve 无 --goal 类必需参数，[dir] 可选语义同顶层 TUI 形态）；模型装配与 CLI run
 * 同源 buildModel（--model/--effort 等旋钮沿用）。启动后打印端口与 token，token 同时落
 * `<dataDir>/serve-token`（§4.3：GUI 首启读取的带外通道）；SIGINT/SIGTERM → await close() → exit 0。
 */
export async function runServe(args: CliArgs): Promise<void> {
  // 目录来源统一单点（规格 §6.2）：与 run/pipeline 同判据——--workdir 优先，裸词报「无法识别命令」不启动
  const d = resolveDirArg(args);
  if (d.unrecognized) {
    console.error(t('Unrecognized command. Run sunshinex help for usage.', '无法识别命令，使用 sunshinex help 查看使用方法'));
    process.exitCode = 1;
    return;
  }
  if (d.ignored) console.warn(t(`--workdir takes precedence; ignoring positional dir ${d.ignored}`, `--workdir 优先，位置参数目录 ${d.ignored} 已忽略`));
  const root = path.resolve(d.dir ?? process.cwd());

  // --port 收紧（G2）：只认纯数字串且 1-65535——parseInt 宽松形态（'12abc'、'0x10'）与裸 --port/
  //  数组形态一律 fail-fast（stderr + exit 1，同「无法识别命令」收口形态）；缺省回落 SERVE_DEFAULT_PORT
  const portRaw = args.flags.port;
  let port = SERVE_DEFAULT_PORT;
  if (portRaw !== undefined && portRaw !== '') {
    if (typeof portRaw !== 'string' || !/^\d+$/.test(portRaw)) {
      console.error(t(`Invalid --port value: ${String(portRaw)} (digits only, 1-65535)`, `非法的 --port 取值：${String(portRaw)}（纯数字，1-65535）`));
      process.exitCode = 1;
      return;
    }
    const n = Number(portRaw);
    if (n < 1 || n > 65535) {
      console.error(t(`Invalid --port value: ${String(portRaw)} (digits only, 1-65535)`, `非法的 --port 取值：${String(portRaw)}（纯数字，1-65535）`));
      process.exitCode = 1;
      return;
    }
    port = n;
  }

  const daemon = new GuiDaemon({ root, model: buildModel(args.flags) });
  const s = await daemon.start({ port });

  // token 带外通道（§4.3）：写 <dataDir>/serve-token（dataDir 首启可能不存在，recursive 建）。
  // G2 JSON 化：{token, port, pid} 三件——GUI/工具可发现性（port=实际监听值、pid=宿主进程；另一实例
  // 起时同端口 EADDRINUSE 天然互斥，不会出现双 daemon 双 token 各自为政的分裂态）；
  // mode 0600：timing-safe 比较裁定依赖「token 对本地读者非秘密」，文件权限是唯一真实边界——多用户机器防护
  // （终审提升裁定）
  const dataDir = resolveDataDir(root);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'serve-token'), JSON.stringify({ token: s.token, port: s.port, pid: process.pid }, null, 2), { mode: 0o600, encoding: 'utf8' });

  console.log(`sunshinex serve listening at http://127.0.0.1:${s.port}`);
  console.log(`token: ${s.token}`);

  // 信号收口：单次化（closing 防双信号重入），await 完整 teardown 序再退（exit 0——用户主动停机非故障）
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void daemon.close().then(
      () => process.exit(0),
      (err) => {
        console.error('[serve] close failed:', err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // 事件循环由 listen socket 持有，无需额外保活定时器
}

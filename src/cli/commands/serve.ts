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

  const portRaw = args.flags.port;
  const port = typeof portRaw === 'string' && portRaw !== '' ? Number.parseInt(portRaw, 10) : SERVE_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(t(`Invalid --port value: ${String(portRaw)}`, `非法的 --port 取值：${String(portRaw)}`));
  }

  const daemon = new GuiDaemon({ root, model: buildModel(args.flags) });
  const s = await daemon.start({ port });

  // token 带外通道（§4.3）：写 <dataDir>/serve-token（dataDir 首启可能不存在，recursive 建）；
  // mode 0600：timing-safe 比较裁定依赖「token 对本地读者非秘密」，文件权限是唯一真实边界——多用户机器防护
  // （终审提升裁定）
  const dataDir = resolveDataDir(root);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'serve-token'), s.token, { mode: 0o600, encoding: 'utf8' });

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

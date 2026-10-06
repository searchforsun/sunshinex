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
 * GUI daemon 薄壳入口（spec §3/§4.3；G3 会话中心修正）：目录判据同 run/pipeline 统一单点
 * （--workdir 优先、裸词报错），**降级为「启动即预选工作区」**（无头/开发场景保旧形态；缺省无预选——
 * daemon 空注册表启动，GUI 从首页 POST /session/new 新建）；模型装配与 CLI run 同源 buildModel
 * （--model/--effort 等旋钮沿用，daemon 级单例供各会话共享）。启动后打印端口与 token；给了预选目录时
 * token 落 `<dataDir>/serve-token`（§4.3：GUI 首启读取的带外通道——工作区级，无预选仅终端打印）；
 * SIGINT/SIGTERM → await close() → exit 0。
 * G4：`--manual` 与 --root 组合时预选会话以 manual 权限模式装配（审批/问询挂起面，计划裁定 2）。
 * G5：`--mode=manual` 与 `--manual` 同义（解析后等价，CLI mode 白名单单点校验在前）。
 */
export async function runServe(args: CliArgs): Promise<void> {
  // 目录来源统一单点（规格 §6.2）：与 run/pipeline 同判据——--workdir 优先，位置参数目录报 unrecognized 不启动。
  // 会话中心降级（spec §3）：预选缺省无——空注册表启动，会话经 GUI 首页/HTTP 创建
  const d = resolveDirArg(args);
  if (d.unrecognized) {
    console.error(t('Unrecognized command. Run sunshinex help for usage.', '无法识别命令，使用 sunshinex help 查看使用方法'));
    process.exitCode = 1;
    return;
  }
  if (d.ignored) console.warn(t(`--workdir takes precedence; ignoring positional dir ${d.ignored}`, `--workdir 优先，位置参数目录 ${d.ignored} 已忽略`));
  const preselect = d.dir !== undefined ? path.resolve(d.dir) : undefined;

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

  // 静态根（G3）：cwd 相对 dist-gui（serve 从仓库根跑即对）；显式传入 daemon 单点化缺省口径——
  // 启动探测一次 index.html，在场挂静态（GET 兜底 index.html/SPA），缺场 API-only（404 hint）
  const staticRoot = path.resolve('dist-gui');
  const daemon = new GuiDaemon({ model: buildModel(args.flags), staticRoot });
  const s = await daemon.start({ port });

  // token 带外通道（§4.3）：写 <dataDir>/serve-token（dataDir 首启可能不存在，recursive 建）——工作区级
  // 落档只在给了预选目录时（无预选无工作区可挂，仅终端打印；GUI 首页建会话后 T2 workspace.json 补发现面）。
  // G2 JSON 化：{token, port, pid} 三件——GUI/工具可发现性（port=实际监听值、pid=宿主进程；另一实例
  // 起时同端口 EADDRINUSE 天然互斥，不会出现双 daemon 双 token 各自为政的分裂态）；
  // mode 0600：timing-safe 比较裁定依赖「token 对本地读者非秘密」，文件权限是唯一真实边界——多用户机器防护
  // （终审提升裁定）
  if (preselect !== undefined) {
    const dataDir = resolveDataDir(preselect);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'serve-token'), JSON.stringify({ token: s.token, port: s.port, pid: process.pid }, null, 2), { mode: 0o600, encoding: 'utf8' });
  }

  console.log(`sunshinex serve listening at http://127.0.0.1:${s.port}`);
  // 浏览器入口提示（T5δ）：静态探测在场（index.html 已构建）时 token 行合并为「浏览器打开+token」
  // 单行入口提示；静态不在场（API-only）保留纯 token 行——无 GUI 可开，指向浏览器只会误导
  const staticMounted = fs.existsSync(path.join(staticRoot, 'index.html'));
  if (staticMounted) {
    console.log(t(`open http://127.0.0.1:${s.port} in a browser (token: ${s.token})`, `在浏览器打开 http://127.0.0.1:${s.port}（token: ${s.token}）`));
  } else {
    console.log(`token: ${s.token}`);
  }
  console.log(
    t(
      `static root: ${staticRoot}${staticMounted ? '' : ' (GUI assets not built — run pnpm --filter gui build)'}`,
      `静态根：${staticRoot}${staticMounted ? '' : '（GUI 产物未构建——运行 pnpm --filter gui build）'}`,
    ),
  );

  // --root 预选降级（spec §3 裁定）：给了目录即 createSession 并激活（无头/开发场景保旧形态），打印
  // active session 行；缺省无预选——空注册表启动，会话经 GUI 首页 / POST /session/new 创建。
  // 预选目录非法（不存在/非目录）fail-fast：用户显式给的路径必须成立，静默空跑更糟
  if (preselect !== undefined) {
    // --manual（G4）：预选会话走 manual 权限模式（审批/问询经 WS 挂起帧 + HTTP 回执闭环）；
    // 缺省 dontAsk 零行为变化。计划裁定 2：flag 只作用于预选会话——GUI 首页新建会话的 mode 面归后续任务。
    // G5：--mode=manual 与 --manual 同义（解析后等价——mode 白名单 manual|plan|dontAsk 已由 CLI 单点
    // 校验，此处只认 manual；plan/dontAsk 对 serve 预选会话无 manual 语义，维持 dontAsk 缺省）
    const manual = args.flags.manual === true || args.flags.mode === 'manual';
    const r = daemon.createSession(preselect, manual ? { mode: 'manual' } : undefined);
    if (!r.ok) {
      console.error(t(`Invalid root: ${preselect} (${r.error.message})`, `非法的根目录：${preselect}（${r.error.message}）`));
      await daemon.close();
      process.exitCode = 1;
      return;
    }
    console.log(t(`active session: ${r.value.sessionId} (root: ${preselect})`, `激活会话：${r.value.sessionId}（根目录：${preselect}）`));
  } else {
    console.log(t('no preselected root — create sessions via the GUI home or POST /session/new', '未预选根目录——会话经 GUI 首页或 POST /session/new 创建'));
  }

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

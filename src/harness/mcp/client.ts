import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolRegistry, CodedToolError, RegisteredTool } from '../tools';
import { ExecResult, JsonSchema, McpServerConfig, ToolCategory, ToolInput } from '../../types';
import { MAX_IMAGES } from '../../images';
import { isHostedServer } from '../plugin-host';

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** 装配期单台 MCP 连接预算:插件/服务启动慢或挂住时不拖住发送(实测浏览器插件故障时每轮卡 10s+);
 *  超时即本轮先不带它的工具,连接在后台继续,连上后工具补注册(注册表实时,后续步骤可见) */
const MCP_CONNECT_BUDGET_MS = 3_000;
const MAX_ARGS_BYTES = 64 * 1024;

interface McpHostOptions {
  /** 单次 tools/call 超时（缺省 30s；测试注入短超时用） */
  callTimeoutMs?: number;
  /** 装配期单台连接预算(ms,缺省 MCP_CONNECT_BUDGET_MS):超时不阻塞本轮,后台续连,连上即补注册 */
  connectBudgetMs?: number;
  /** stdio server stderr 日志目录(缺省不落):<logDir>/<server>.log append——插件崩退/有头启动失败的诊断源 */
  logDir?: string;
}

interface McpConn {
  client: Client;
  /** 原始传输句柄：close 时取 stdio 子进程 pid（SDK close 内部先置空 _process，之后 pid getter 恒 null——须留存引用） */
  transport: Transport;
  config: McpServerConfig;
}

/** MCP 结果内容提取：text 块 join + image 块收 dataURL（MCP 规范原生支持；此前 textOf 丢图） */
export function contentOf(content: unknown): { text: string; images?: string[] } {
  const parts = Array.isArray(content) ? content : [];
  const texts: string[] = [];
  const images: string[] = [];
  for (const c of parts) {
    if (typeof c !== 'object' || c === null) continue;
    const o = (c as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown });
    if (o.type === 'text') texts.push(String(o.text ?? ''));
    else if (o.type === 'image' && typeof o.data === 'string' && typeof o.mimeType === 'string' && images.length < MAX_IMAGES) {
      images.push(`data:${o.mimeType};base64,${o.data}`);
    }
  }
  const text = texts.filter((t) => t.length > 0).join('\n');
  return { text, ...(images.length > 0 ? { images } : {}) };
}

/** CallToolResult → ExecResult 结果映射单点：isError 抛 CodedToolError 保失败语义（BatchRunner 据错误码置 failed/分桶），
 *  images 随错误对象随行不丢（错误亦可带图）；成功态 text/images 收进 ExecResult。抽导出即测：makeTool 私有 executor 的映射逻辑钉点 */
export function execResultFromMcp(fqName: string, res: unknown): ExecResult {
  const r = (res ?? {}) as { content?: unknown; isError?: unknown };
  const { text, images } = contentOf(r.content);
  if (r.isError === true) {
    throw new CodedToolError('MCP_TOOL_ERROR', text || `MCP tool returned an error: ${fqName}`, images);
  }
  return { exitCode: 0, stdout: text, stderr: '', timedOut: false, ...(images !== undefined ? { images } : {}) };
}

/** 超时收束：竞速拒绝转 CodedToolError，计时器必清 */
function withTimeout<T>(p: Promise<T>, ms: number, code: string, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CodedToolError(code, message)), ms);
  });
  return Promise.race([p, gate]).finally(() => clearTimeout(timer));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 断链类错误判定单点（断链重试链的错误分类面）。自家码恒非断链——withTimeout 的 MCP_TIMEOUT 与
 *  execResultFromMcp 的 MCP_TOOL_ERROR、参数闸门码各表其面，重试状态不得改写其语义；SDK 传输层
 *  失败无稳定异常类型面：McpError 带 JSON-RPC 码（-32000=连接类），传输死亡的裸 Error 按报文签名兜底 */
function isBrokenConnectionError(e: unknown): boolean {
  if (e instanceof CodedToolError) return false;
  if ((e as { code?: unknown }).code === -32000) return true;
  return /connection closed|transport (closed|error)|not connected/i.test(errMsg(e));
}

/**
 * MCP 宿主：官方 SDK 传输接缝（stdio / streamable http / sse 三分支收敛于本文件，替换客户端实现不动主链）。
 * 注册链 = 懒 spawn → 握手身份校验（配置名 ≠ serverInfo.name 即拒，防冒名绕过 guard 登记制）
 * → tools/list → 以 mcp__<server>__<tool> 规范名注册（category external，闸门在 guard）。
 */
/** 逐服务器装配结果：注册数与警告单（降级语义——服务器失败只损失该服务器工具，警告上屏后继续装配） */
interface McpAssemblyReport {
  registered: number;
  /** 逐服务器失败警告（连接/握手/拉取/重名），按配置顺序收集 */
  warnings: string[];
}

/**
 * stdio 子进程环境（债 D21）：显式传 env 才能覆盖 SDK 缺省的「安全子集继承」——
 * 宿主环境整份继承再叠加 cfg.env 专属覆盖（对齐主流 MCP 客户端：API key 一类服务器配置零丢失）；
 * process.env 值域含 undefined（可unset），须剔除后才能满足传输参数的 Record<string,string> 形态。
 */
function mergedChildEnv(cfg: McpServerConfig): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) merged[k] = v;
  }
  return { ...merged, ...(cfg.env ?? {}) };
}

/** 宿主面 stdio 附加：stderr 落日志面(见 attachStderrLog;SDK 缺省丢弃 stderr)；cwd 仅插件贡献 server
 *  携带（合成期已解析为绝对路径），SDK 1.30 StdioServerParameters 原生支持，缺省不落键保持既有 spawn 语义 */
const hostStdioExtra = (cfg: McpServerConfig): { stderr: 'pipe'; cwd?: string } => ({
  stderr: 'pipe',
  ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
});

/** 传输装配单点：stdio/http/sse 三分支，宿主连接面与 serve probe 探测面共用（此前照抄双源，装配面改
 *  签名或加传输类型必漂移）。形态字段缺失或 url 非法均装配期 fail-fast，失败抛 plain Error 且 message=
 *  `MCP server connection failed (name): 原因`（宿主面 catch 包 CodedToolError 同码同文案，探测面直接用）。
 *  2026-10-26：cfg.headers 随 http/sse 请求透传（requestInit.headers——Bearer 鉴权面，gitnexus
 *  风格 `{url, headers}` 主流形态）；SDK 对 SSE 的 GET 流同样吃 requestInit 头 */
export function buildMcpTransport(
  cfg: McpServerConfig,
  opts: {
    /** stdio 子进程环境（宿主 mergedChildEnv 整份继承 / probe 探测面隔离最小环境） */
    env: (cfg: McpServerConfig) => Record<string, string>;
    /** 宿主面 stdio 附加（stderr 日志面/cwd）；probe 临时传输不携带 */
    stdioExtra?: (cfg: McpServerConfig) => { stderr?: 'pipe'; cwd?: string };
  },
): Transport {
  const fail = (msg: string): Error => new Error(`MCP server connection failed (${cfg.name}): ${msg}`);
  switch (cfg.transport ?? 'stdio') {
    case 'http':
    case 'sse': {
      if (!cfg.url) throw fail(`${cfg.transport} transport requires a url`);
      try {
        const url = new URL(cfg.url);
        const reqInit = cfg.headers !== undefined ? { requestInit: { headers: cfg.headers } } : undefined;
        return cfg.transport === 'sse'
          ? new SSEClientTransport(url, reqInit)
          : new StreamableHTTPClientTransport(url, reqInit);
      } catch (e) {
        throw fail(`Invalid url: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    case 'stdio':
    default:
      if (!cfg.command) throw fail('stdio transport requires a command');
      return new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: opts.env(cfg),
        ...(opts.stdioExtra?.(cfg) ?? {}),
      });
  }
}

/**
 * 终结 stdio 子进程树（Task 28 bug 修复）。机理：MCP SDK 的 client.close() 在 Windows 上只 kill 直接
 * 子进程（Node kill() = TerminateProcess 单进程语义），而插件 server 常再拉孙进程（computer-use 的
 * 持久 PowerShell worker 等）——孙进程手里的 stdio 管道句柄挂住父进程事件循环，CLI 进程永不退出
 * （实测：.sunshinex/settings.json 启用 browser-use/computer-use 插件后 selfcheck 60s+ 悬挂，
 * 禁用插件 10s 干净退出）。故 SDK close 之后按 pid 树终结兜底：Windows 走 taskkill /T /F（树杀，
 * 覆盖孙进程），POSIX 走 SIGTERM（stdin 关闭语义下服务器通常自行退出，此处兜底防残留）。
 * 失败（进程已亡 ESRCH / taskkill 不在等）静默——树终结是兜底而非主路径，与 close 路径
 * 「单点失败不阻塞其余关闭」口径一致。taskkill 子孙 fire-and-forget + unref：避免杀树工具自己
 * 反过来挂住事件循环（自指悬挂）。
 */
export function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      tk.on('error', () => {}); // 吞 spawn 失败的 error 事件（防 unhandled 'error' 崩进程）
      tk.unref(); // 不持事件循环引用：父进程先于 taskkill 退出也不影响杀树（OS 层完成）
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // 静默：pid 已失效（ESRCH）等，兜底路径不计失败
  }
}

/** 捕获 stdio 传输的子进程 pid：SDK StdioClientTransport 暴露 pid getter（启动后可得）；非 stdio 传输
 *  或未启动时无 pid 形态（null/undefined），静默跳过树终结。须在 client.close() 之前调用——SDK close()
 *  内部先把 _process 置空再 kill，之后 pid getter 恒为 null（再读即漏杀）。 */
function pidOf(transport: Transport): number | null {
  const t = transport as { pid?: unknown };
  return typeof t.pid === 'number' && Number.isFinite(t.pid) ? t.pid : null;
}

/** MCP tools/list 的 inputSchema → 主仓 JsonSchema（松散结构透传，2026-10-26 browser-use 装配联调裁定）：
 *  无 schema 注册会让模型面对无参工具——真机探活实测（Playwright MCP）参数化调用（browser_navigate {url} 等）
 *  全部以「expected string, received undefined」败退、仅零参调用可达；直击 executor 复现已排除传输面
 *  （args 原样到 server），根因即模型侧拿不到参数契约。形状非对象时丢弃（宁少配不可错配——无 schema
 *  工具仍注册可用，只是模型面参数降级为自由文本）。 */
function toToolSpecParameters(input: unknown): JsonSchema | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  return input as JsonSchema;
}

/** 操作说明参数名(2026-11-07 用户裁定「内置插件工具调用加一个说明本次目的的参数,工具行显示它」):
 *  模型按当前对话语言自拟,GUI 工具行以它替换「工具名+参数」;不下发给插件 */
export const PURPOSE_PARAM = 'purpose';

const PURPOSE_SCHEMA: JsonSchema = {
  type: 'string',
  description:
    "One short phrase stating what this call is for, written in the language the user is currently using in this conversation (e.g. 'Open the login page', '截取屏幕确认弹窗是否关闭'). Shown to the user as the title of this step — describe the intent, do not repeat raw parameters.",
};

/** 内置宿主插件工具的参数表注入 purpose:置于属性首位(模型先写意图,流式行最早可显)、并入 required。
 *  原 schema 非对象形(无 properties)时以空对象起步——零参工具同样带说明 */
export function withPurposeParam(params: JsonSchema | undefined): JsonSchema {
  const base = params ?? { type: 'object' };
  const required = (base.required ?? []).filter((k) => k !== PURPOSE_PARAM);
  return {
    ...base,
    type: 'object',
    properties: { [PURPOSE_PARAM]: PURPOSE_SCHEMA, ...(base.properties ?? {}) },
    required: [PURPOSE_PARAM, ...required],
  };
}

/** 转发插件前剥除 purpose(插件 schema 不认识它;computer-use 为 additionalProperties:false 会拒) */
export function stripPurposeArg(args: ToolInput): ToolInput {
  if (!Object.prototype.hasOwnProperty.call(args, PURPOSE_PARAM)) return args;
  const { [PURPOSE_PARAM]: _purpose, ...rest } = args as Record<string, unknown>;
  return rest as ToolInput;
}

export class McpHost {
  private conns = new Map<string, McpConn>();
  /** 本次装配注册进 registry 的工具全名（mcp__<server>__<tool>）：close 收口时逐名撤销——
   *  否则 close 后注册表残留死连接工具（guard 名单仍放行、executor 指向已关 client，调用必败），
   *  重连虽可同覆盖重注册，但「收口后零残留」是 close 的语义底线（harness.mcpClose 收口幂等钉） */
  private registeredNames = new Set<string>();
  /** 连接/装配失败名单(2026-11-01「失败连接被缓存永不重试」根修):失败 server 名集合——
   *  宿主据此在下次 run 重建 host(失败连接留存在 Map 里 = 工具永不挂载且永不重试) */
  private failedNames = new Set<string>();
  /** close 后到达的后台连接须就地关闭(不得复活已收口的 host) */
  private closed = false;

  constructor(
    private servers: McpServerConfig[],
    private registry: ToolRegistry,
    private opts: McpHostOptions = {},
  ) {}

  /** 存在连接/装配失败的 server(宿主重建判据;空=false 全部就绪零重建) */
  hasFailedServers(): boolean {
    return this.failedNames.size > 0;
  }

  /** 每轮 run 入口连通性验证(2026-11-01 用户裁定「每轮发送会话都尝试验证一下连通性」):
   *  stdio:子进程存活探测(process.kill(pid,0),微秒级零协议往返);http/sse:MCP 协议级 ping
   *  (并行发起、单服务器 1s 超时封顶,总耗时=最慢者;本地服务器毫秒级)——server 中途死亡
   *  此前不在重建判据=工具悄悄失效到会话重启;死亡即入 failedNames(宿主既有失败重建面接管,
   *  同轮内即触发重建)。探活只记账不抛错 */
  async livenessCheck(): Promise<void> {
    const checks: Array<Promise<void>> = [];
    for (const [name, conn] of this.conns) {
      if (conn.config.transport === 'http' || conn.config.transport === 'sse') {
        checks.push((async () => {
          try {
            await conn.client.ping({ signal: AbortSignal.timeout(1000) });
          } catch {
            if (!this.failedNames.has(name)) {
              this.failedNames.add(name);
              this.writeAssemblyLog(name, 'liveness check: http/sse ping failed — rebuild scheduled');
            }
          }
        })());
        continue;
      }
      // stdio 也走协议级 ping(Windows pid 复用+SDK 进程对象残留会使 kill(pid,0) 误判存活,
      // 失败 server 被跳过重建=工具静默失效,实测踩坑):协议往返毫秒级,1s 超时封顶
      checks.push((async () => {
        try {
          await conn.client.ping({ signal: AbortSignal.timeout(1000) });
        } catch {
          if (!this.failedNames.has(name)) {
            this.failedNames.add(name);
            this.writeAssemblyLog(name, 'liveness check: stdio ping failed — rebuild scheduled');
          }
        }
      })());
    }
    await Promise.all(checks);
  }

  /** stdio server stderr 落盘(2026-11-01 用户报障「关 headless 插件即消失」定位面):SDK 缺省
   *  丢弃子进程 stderr——有头启动失败/崩溃原因不可见。pipe 后逐行 append 到 <logDir>/<name>.log
   *  (尽力而为,写失败不影响连接);日志即诊断源 */
  private attachStderrLog(cfg: McpServerConfig, transport: Transport): void {
    if (this.opts.logDir === undefined || cfg.transport === 'http' || cfg.transport === 'sse') return;
    const t = transport as unknown as { stderr?: NodeJS.ReadableStream | null };
    const stderr = t.stderr;
    if (stderr === undefined || stderr === null) return;
    try {
      fs.mkdirSync(this.opts.logDir, { recursive: true });
      const stream = fs.createWriteStream(path.join(this.opts.logDir, `${cfg.name}.log`), { flags: 'a' });
      stream.on('error', () => {});
      stderr.on('data', (chunk: Buffer) => stream.write(chunk));
    } catch {
      /* 尽力落盘 */
    }
  }

  /** 装配失败/连接失败落盘(与 stderr 日志同文件 append,带时间戳):诊断源不依赖 GUI 上屏 */
  private writeAssemblyLog(name: string, line: string): void {
    if (this.opts.logDir === undefined) return;
    try {
      fs.mkdirSync(this.opts.logDir, { recursive: true });
      fs.appendFileSync(path.join(this.opts.logDir, `${name}.log`), `[${new Date().toISOString()}] ${line}
`);
    } catch {
      /* 尽力落盘 */
    }
  }

  /** 传输工厂（宿主面）：buildMcpTransport 单点 + 失败收束 CodedToolError（形态字段缺失或 url 非法均装配期
   *  fail-fast，与连接失败同码 MCP_CONNECT_FAILED，失败语义不分传输）。stdio 附加 stderr 落日志面与插件贡献 cwd */
  private makeTransport(cfg: McpServerConfig): Transport {
    try {
      return buildMcpTransport(cfg, { env: mergedChildEnv, stdioExtra: hostStdioExtra });
    } catch (e) {
      throw new CodedToolError('MCP_CONNECT_FAILED', e instanceof Error ? e.message : String(e));
    }
  }

  /** 拨号单点：传输工厂→SDK client→connect→stderr 日志挂靠（装配与断链重连两条路径共用，编排零双写）。
   *  连接失败路径显式关闭半开传输并树杀已 spawn 子进程（SSE 的 EventSource 重连循环会残留 Socket 句柄，
   *  半开 stdio 子进程同样挂事件循环），错误原样上抛——警告收单/失败记账归各调用方 */
  private async dial(cfg: McpServerConfig): Promise<{ client: Client; transport: Transport }> {
    const transport = this.makeTransport(cfg);
    const client = new Client({ name: 'sunshinex-mcp-host', version: '0.1.0' });
    try {
      await client.connect(transport);
    } catch (e) {
      this.attachStderrLog(cfg, transport); // 失败路径同样挂(子进程可能已 spawn,崩退现场必落)
      const halfOpenPid = pidOf(transport);
      await client.close().catch(() => {});
      if (halfOpenPid !== null) killProcessTree(halfOpenPid);
      throw e;
    }
    this.attachStderrLog(cfg, transport); // spawn 完成后 transport.stderr 才存在——挂靠必须在 connect 之后(pre-connect 恒 null=日志恒空的病根)
    return { client, transport };
  }

  /** 清单拉取后逐工具注册（disabledTools 短名过滤），返回注册数（装配面报数与重连面覆盖注册共用） */
  private registerListedTools(server: string, listed: { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }): number {
    let registered = 0;
    const disabled = new Set(this.servers.find((s) => s.name === server)?.disabledTools ?? []);
    for (const t of listed.tools) {
      if (disabled.has(t.name)) continue; // 逐工具停用（短名过滤）：装配期不注册即模型不可见
      const spec = this.makeTool(server, t.name, { description: t.description, inputSchema: t.inputSchema });
      this.registry.register(spec);
      this.registeredNames.add(spec.name); // 收口账：close 撤牌名单（名字取自 spec.name，单源免漂移）
      registered += 1;
    }
    return registered;
  }

  /** 逐服务器连接并注册工具：单台失败只损失该服务器工具（降级语义），失败收进警告单返回、不中断其余服务器装配。
   *  2026-10-26 两处放宽（用户实测主流服务器被拦）：①enabled=false 整机跳过（不连接不注册，软提示）；
   *  ②握手身份不符不再硬拒——serverInfo.name 与配置键不同是主流服务器的常态（lark-project-mcp 等），
   *  主流客户端均不做此校验，改为软提示照常注册（guard 名单按配置键，冒名面本就由登记制承载） */
  async registerTools(): Promise<McpAssemblyReport> {
    const report: McpAssemblyReport = { registered: 0, warnings: [] };
    const todo: McpServerConfig[] = [];
    const seen = new Set<string>();
    for (const cfg of this.servers) {
      if (this.conns.has(cfg.name) || seen.has(cfg.name)) {
        report.warnings.push(`duplicate MCP server name (${cfg.name}) skipped`);
        continue;
      }
      if (cfg.enabled === false) {
        // 防御性双闸（生产单点在 harness/index.ts 装配期 filter）：此处只服务测试直构 McpHost 的路径，
        // 生产行为不依赖本分支——enabled 语义的裁决与「软提示」文案演进以装配期为准
        report.warnings.push(`server disabled (${cfg.name}): enabled=false, skipped`);
        continue;
      }
      seen.add(cfg.name);
      todo.push(cfg);
    }
    // 并行连接,每台限时:超预算的服务本轮跳过(不计失败、不触发重建),后台续连成功即补注册
    const budget = this.opts.connectBudgetMs ?? MCP_CONNECT_BUDGET_MS;
    await Promise.all(todo.map(async (cfg) => {
      const attempt = this.connectAndRegister(cfg);
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        attempt.then((n) => ({ kind: 'ok' as const, n }), (e: unknown) => ({ kind: 'err' as const, msg: e instanceof Error ? e.message : String(e) })),
        new Promise<{ kind: 'slow' }>((r) => { timer = setTimeout(() => r({ kind: 'slow' }), budget); }),
      ]);
      clearTimeout(timer);
      if (outcome.kind === 'ok') report.registered += outcome.n;
      else if (outcome.kind === 'err') report.warnings.push(outcome.msg);
      else {
        this.writeAssemblyLog(cfg.name, `not ready within ${budget}ms — continuing in background, tools join when connected`);
        attempt.catch(() => {}); // 失败已在 connectAndRegister 内记账/落日志
      }
    }));
    return report;
  }

  /** 单台连接+注册;失败记 failedNames/落日志并以警告文案抛出(连接失败/装配失败两类) */
  private async connectAndRegister(cfg: McpServerConfig): Promise<number> {
    let client: Client;
    let transport: Transport;
    try {
      ({ client, transport } = await this.dial(cfg));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.writeAssemblyLog(cfg.name, `connection failed: ${msg}`);
      this.failedNames.add(cfg.name);
      throw new Error(`connection failed (${cfg.name}): ${msg.slice(0, 120)}`);
    }
    if (this.closed) {
      const pid = pidOf(transport);
      await client.close().catch(() => {});
      if (pid !== null) killProcessTree(pid);
      return 0;
    }
    try {
      const actual = client.getServerVersion()?.name;
      if (actual !== cfg.name) {
        // 身份软提示（不再跳过）：照常 listTools+注册。差异只落装配日志文件(诊断价值在日志
        // ——警告单会被 engine.run 每轮尾追进对话链,诊断噪声每轮刷屏,用户裁定 2026-11-01
        // 「警告去掉或优化」;主流服务器常态差异无行动价值)
        this.writeAssemblyLog(cfg.name, `identity note: serverInfo.name=${actual ?? '(unknown)'} (accepted, config name kept)`);
      }
      this.conns.set(cfg.name, { client, transport, config: cfg });
      return this.registerListedTools(cfg.name, await client.listTools());
    } catch (e) {
      // 形态守卫/清单拉取等残余失败同样只损失本服务器（降级语义）
      const msg = e instanceof Error ? e.message : String(e);
      this.writeAssemblyLog(cfg.name, `assembly failed: ${msg}`);
      this.failedNames.add(cfg.name);
      throw new Error(`assembly failed (${cfg.name}): ${msg.slice(0, 120)}`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    // 撤牌先于断链：close 后注册表零 mcp 残留（收口语义底线）——残留工具 executor 指向已关 client，
    // guard 名单却仍放行，模型调用必败且死相难查
    for (const name of this.registeredNames) this.registry.unregister(name);
    this.registeredNames.clear();
    for (const { client, transport } of this.conns.values()) {
      // pid 须在 client.close() 之前捕获：SDK close() 内部先置空 _process 再 kill，之后 pid getter 恒 null
      const pid = pidOf(transport);
      await client.close().catch(() => {}); // 退出路径的连接清理：单点失败不阻塞其余关闭
      // Windows 下 SDK close 不终结 stdio 子进程树（孙进程残留 → 管道句柄挂住事件循环，进程永不退出
      // ——Task 28 bug），按 pid 树终结兜底；pid 不可得（http/sse 或未 spawn）静默跳过
      if (pid !== null) killProcessTree(pid);
    }
    this.conns.clear();
  }

  /** 单工具注册面：执行器做参数体积闸门与超时收束，安全闸门（登记制/模式豁免）统一在 guard。
   *  连接不闭包捕获——执行器每次尝试按 server 名解析当前连接（conns 单源）：重连覆盖注册后，
   *  在途重试（与后续调用）都落在活连接上；闭包持有注册时的 client 会使重试永远打在死连接上 */
  private makeTool(server: string, toolName: string, tool?: { description?: string; inputSchema?: unknown }): RegisteredTool {
    const fqName = `mcp__${server}__${toolName}`;
    const timeoutMs = this.opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const hosted = isHostedServer(server);
    const listed = toToolSpecParameters(tool?.inputSchema);
    const parameters = hosted ? withPurposeParam(listed) : listed;
    return {
      name: fqName,
      description: tool?.description ?? `MCP tool ${toolName} (server ${server})`,
      ...(parameters !== undefined ? { parameters } : {}),
      category: 'external' as ToolCategory,
      executor: async (input: ToolInput): Promise<ExecResult> => {
        const args = hosted ? stripPurposeArg(input ?? {}) : (input ?? {});
        if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGS_BYTES) {
          throw new CodedToolError('MCP_ARGS_TOO_LARGE', `MCP args too large (>${MAX_ARGS_BYTES} bytes): ${fqName}`);
        }
        // 断链重试(2026-11-01 用户裁定「运行中调用异常应触发重试,2 次后如实回报」):连接类错误
        // (server 进程死亡/管道断/transport 关闭)重连该 server 后重试调用,最多 2 次;穷尽抛
        // MCP_CONNECT_FAILED 如实告知模型(server 不可达),不再吞进备用方案歧义。超时/业务错误
        // (MCP_TIMEOUT/isError)不在此列——非断链语义,重连无益,且重试状态不改写其错误分类学
        let attempts = 0;
        for (;;) {
          const conn = this.conns.get(server);
          if (conn === undefined) throw new CodedToolError('MCP_CONNECT_FAILED', `MCP server not connected: ${server}`);
          try {
            const res = await withTimeout(
              conn.client.callTool({ name: toolName, arguments: args }),
              timeoutMs,
              'MCP_TIMEOUT',
              `MCP call timed out (${timeoutMs}ms): ${fqName}`,
            );
            return execResultFromMcp(fqName, res);
          } catch (e) {
            if (!isBrokenConnectionError(e)) throw e; // 非断链如实原抛——超时穷尽后仍报 MCP_TIMEOUT,不误标 server unreachable
            if (attempts >= 2) {
              throw new CodedToolError('MCP_CONNECT_FAILED', `MCP server unreachable after ${attempts} reconnect attempts (${server}): ${errMsg(e).slice(0, 200)}`);
            }
            attempts += 1;
            this.writeAssemblyLog(server, `tool call hit broken connection — reconnect #${attempts}: ${errMsg(e).slice(0, 120)}`);
            await this.reconnectServer(server);
          }
        }
      },
    };
  }

  /** 单 server 重连(断链重试面):撤旧连接(树杀死进程)→ 拨号单点重连 → 清单拉取重注册(同名覆盖;
   *  工具面可能已变,以重连后为准)。失败抛错由调用方计数 */
  private async reconnectServer(server: string): Promise<void> {
    const cfg = this.servers.find((s) => s.name === server);
    if (cfg === undefined) throw new CodedToolError('MCP_CONNECT_FAILED', `server config not found: ${server}`);
    const old = this.conns.get(server);
    if (old !== undefined) {
      this.conns.delete(server);
      const pid = pidOf(old.transport);
      await old.client.close().catch(() => {});
      if (pid !== null) killProcessTree(pid);
    }
    const { client, transport } = await this.dial(cfg);
    this.registerListedTools(server, await client.listTools());
    this.conns.set(server, { client, transport, config: cfg });
  }
}

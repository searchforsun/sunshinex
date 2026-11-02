/**
 * sunshinex providers 子命令族（Task 19，Phase D catalog CLI 族收官——§15 providers 归一化的 CLI 面）：
 *   list [--scope=global|project] [--root <dir>] [--json]
 *   add <name> --base-url=<u> --models=m1,m2,... [--context-window=<n>] [--reasoning-effort=<e>] [--supports-images]
 *   set <name>（同 add 字段，增量更新；models 在场即整组替换）
 *   remove|key|test <name>
 *   model add|remove|move <provider> <model> [--tier=small|medium|large]（add）/ [--direction=up|down]（move）
 * 读写全走 catalog 单点（listProviders / upsertProvider / removeProvider / setProviderApiKey /
 * modelAdd / modelRemove / modelMove），CLI 零自管盘上形态——写面落 <root>/.sunshinex/settings.json
 * 或 ~/.sunshinex/settings.json 的 providers 键（key 写 env 块专用槽）。--models 逗号清单序即优先级
 * （choices 序 = providers 序 × models 序，model move 调序即调默认序）。providers 无 enabled 概念
 * （散键退役后的唯一事实源，不设 enable|disable——agents 族同名子命令不照搬）。
 * key 交互面：process.stdin.setRawMode 最小实现（逐字符读、回显 *，Ctrl+C 中止——仓内无 readline
 * mute 先例，沿 brief 裁定的最小实现；TTY 交互路径手工验收）。test 连通探测：GET <baseUrl>/models
 * 带解析密钥（resolveProviderApiKey 单点，env 块随入口 loadSettingsChain 已落 process.env），10s
 * 超时（AbortSignal.timeout，harness webfetch 先例；全局 fetch 沿 model/adapter 仓内先例），
 * 成功两行（ok 行 + 模型数行）或错误摘要一行——失败是结果不是异常（mcp test 同款裁定）。
 * 通道即语义（mcp.ts 先例）：结果面（表格/JSON/ok 行）stdout、诊断面（error/[warn]）stderr、
 * 非法参数 usage + exit 1（仓内零 exit 2 先例）；CatalogWriteError → error 行 + exit 1
 * （runCatalogWrite 单点，T15 映射）。密钥值任何输出通道零回显（ok 行只落 env 槽名）。
 * --scope 语义沿 catalog-common：global → 全局面（list 过滤全局键装载视图，写面落 ~/.sunshinex/）；
 * 缺省 project → root = --root 目录或 process.cwd()（写面落 <root>/.sunshinex/settings.json）。
 */
import CliTable3 from 'cli-table3';
import { listProviders, modelAdd, modelMove, modelRemove, removeProvider, setProviderApiKey, upsertProvider } from '../../catalog/providers';
import type { ProviderModelInput, ProviderUpsertPatch } from '../../catalog/providers';
import { providerApiKeyEnv, resolveProviderApiKey } from '../../config/providers';
import { t } from '../../i18n';
import { PROVIDERS_FLAG_KEYS, entryArg, resolveTarget, runCatalogWrite } from './catalog-common';
import { settingsPathOf } from '../../catalog/io';

function printUsage(): void {
  console.error(t(
    'Usage: sunshinex providers list [--scope=global|project] [--root <dir>] [--json]'
    + ' | add <name> --base-url=<u> --models=m1,m2,... [--context-window=<n>] [--reasoning-effort=<e>] [--supports-images]'
    + ' | set <name> (same fields as add, incremental)'
    + ' | remove|key|test <name>'
    + ' | model add <provider> <model> [--tier=small|medium|large]'
    + ' | model remove <provider> <model>'
    + ' | model move <provider> <model> --direction=up|down',
    '用法：sunshinex providers list [--scope=global|project] [--root <目录>] [--json]'
    + ' | add <名称> --base-url=<地址> --models=m1,m2,... [--context-window=<n>] [--reasoning-effort=<强度>] [--supports-images]'
    + ' | set <名称>（同 add 字段，增量更新）'
    + ' | remove|key|test <名称>'
    + ' | model add <源> <模型> [--tier=small|medium|large]'
    + ' | model remove <源> <模型>'
    + ' | model move <源> <模型> --direction=up|down',
  ));
}

/** ok 行的落盘文件路径（写落位 = 装载读位）：catalog settingsPathOf 单点 */
function settingsFileOf(scope: 'global' | 'project', root: string | null): string {
  return settingsPathOf(scope, root);
}

/* ---------- list ---------- */

function listCmd(args: string[]): number {
  const target = resolveTarget(args, PROVIDERS_FLAG_KEYS);
  if (target.bad) {
    printUsage();
    return 1;
  }
  const view = listProviders(target.root);
  if (target.json) {
    // --json 输出 {providers, choices} 双面（providers=文件结构镜像含 apiKeyEnv/apiKeyPresent 在场布尔；
    // choices=展平生效值含 tier 标注）——键名即 listProviders 返回面，warnings 走 stderr 不混数据面
    console.log(JSON.stringify({ providers: view.providers, choices: view.choices }, null, 2));
  } else {
    // 表格（cli-table3，style 清空色码沿 plugins 先例，输出保持纯文本可管道）；key 列只标在场布尔，
    // 密钥值无表格通道（set=专用槽或主槽任一有值）
    const table = new CliTable3({
      head: ['name', t('key', '密钥'), 'baseUrl', 'models'],
      style: { head: [], border: [] },
    });
    for (const p of view.providers) {
      table.push([p.name, p.apiKeyPresent ? 'set' : '-', p.baseUrl, p.models.map((m) => m.model).join(',')]);
    }
    console.log(table.toString());
  }
  for (const w of view.warnings) console.warn(`[warn] ${w}`);
  return 0;
}

/* ---------- add / set（upsert 两面） ---------- */

/** add/set 解析产物：条目名 + upsert 载荷 + bad（用法错归 usage；effort/tier 枚举与正数性越界交
 *  catalog 写面拒——isolation/executor 透传纪律同款） */
interface UpsertParsed {
  name?: string;
  baseUrl?: string;
  /** --models 逗号清单拆分后（写面包 {model} 对象；清单序即优先级） */
  models?: string[];
  contextWindow?: number;
  reasoningEffort?: string;
  supportsImages?: boolean;
  bad: boolean;
}

/**
 * add/set 旗标解析（两形态沿 parseRootFlag 惯例）：--base-url/--models/--context-window/--reasoning-effort
 * 单值、--supports-images 布尔旗（bare=true，`=true|false` 显式归一，他值拒识）；公共 target 旗标
 * （scope/root/json）跳过归 resolveTarget；词汇表外旗标 → bad（直调面拒识，spawn 面经 dispatch 回填
 * 不会到达）。条目名必填且唯一（positional 恰一个）。
 */
function parseUpsert(args: string[]): UpsertParsed {
  const p: UpsertParsed = { bad: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const inlineVal = eq === -1 ? undefined : a.slice(eq + 1);
    /** 取单值旗标的值（`--flag v` / `--flag=v` 两形态）；缺值/形如旗标 → undefined（调用方记 bad） */
    const take = (): string | undefined => {
      if (inlineVal !== undefined) return inlineVal;
      const v = args[++i];
      return v !== undefined && !v.startsWith('--') ? v : undefined;
    };
    const badIf = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);
    switch (key) {
      case 'base-url': {
        const v = badIf(take());
        if (v === undefined) p.bad = true;
        else p.baseUrl = v;
        break;
      }
      case 'models': {
        const v = badIf(take());
        // 逗号清单：trim 逐段，空段拒识（`--models=a,,b` 是打字错误不是空模型名）
        const list = v === undefined ? [] : v.split(',').map((s) => s.trim());
        if (list.length === 0 || list.some((s) => s === '')) p.bad = true;
        else p.models = list;
        break;
      }
      case 'context-window': {
        const v = badIf(take());
        // 数值形状归 CLI（非数字串属用法错）；正数性归 catalog 写面（assertWindow 同口径）
        if (v === undefined || !/^\d+(\.\d+)?$/.test(v) || !Number.isFinite(Number(v))) p.bad = true;
        else p.contextWindow = Number(v);
        break;
      }
      case 'reasoning-effort': {
        const v = badIf(take());
        if (v === undefined) p.bad = true;
        else p.reasoningEffort = v;
        break;
      }
      case 'supports-images':
        // 布尔旗：bare=true；显式 =true/=false 归一；他值拒识（防 --supports-images=yes 静默失效）
        if (inlineVal === undefined || inlineVal === 'true') p.supportsImages = true;
        else if (inlineVal === 'false') p.supportsImages = false;
        else p.bad = true;
        break;
      case 'scope':
      case 'root':
        // 公共 target 旗标跳过（两形态；两 token 形态吞值，值合法性归 resolveTarget）
        if (inlineVal === undefined) i++;
        break;
      case 'json':
        // --json 是布尔旗，带值与 resolveTarget 同口径拒识
        if (inlineVal !== undefined) p.bad = true;
        break;
      default:
        p.bad = true; // 词汇表外旗标
    }
  }
  p.name = positional[0];
  if (positional.length !== 1) p.bad = true; // 条目名必填且唯一
  return p;
}

/** 解析产物 → catalog upsert 载荷（models 逐条包 {model} 对象——写面不收字符串速记）；effort/tier
 *  以 string 透传，枚举校验归 catalog 写面（越界值 INVALID → error + exit 1） */
function upsertPatchOf(p: UpsertParsed): ProviderUpsertPatch {
  return {
    ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
    ...(p.models !== undefined ? { models: p.models.map((m): ProviderModelInput => ({ model: m })) } : {}),
    ...(p.contextWindow !== undefined ? { contextWindow: p.contextWindow } : {}),
    ...(p.reasoningEffort !== undefined ? { reasoningEffort: p.reasoningEffort as ProviderUpsertPatch['reasoningEffort'] } : {}),
    ...(p.supportsImages !== undefined ? { supportsImages: p.supportsImages } : {}),
  };
}

function addCmd(args: string[]): number {
  const p = parseUpsert(args);
  // add 必需 --base-url + 非空 --models（catalog add 路径同口径——两者缺任一都是解析面拒载的非法
  // 形态）；缺旗标属用法错归 usage 口径（mcp add 缺 --command/--url 同款）
  if (p.bad || p.name === undefined || p.baseUrl === undefined || p.models === undefined) {
    printUsage();
    return 1;
  }
  const target = resolveTarget(args, PROVIDERS_FLAG_KEYS);
  if (target.bad) {
    printUsage();
    return 1;
  }
  const name = p.name;
  const code = runCatalogWrite(() => upsertProvider(target.root, target.scope, name, upsertPatchOf(p)));
  if (code !== 0) return code;
  console.log(t(
    `ok: provider ${name} (${target.scope} ${settingsFileOf(target.scope, target.root)})`,
    `ok：provider ${name}（${target.scope} ${settingsFileOf(target.scope, target.root)}）`,
  ));
  return 0;
}

function setCmd(args: string[]): number {
  const p = parseUpsert(args);
  // set 至少携带一个字段旗标（零字段 = 无从增量，静默 ok 是伪成功）；条目名由 parseUpsert 守卫。
  // 打在缺省条目上即 upsert 的 add 路径（凭全字段可建，缺字段报缺）——与 catalog 单点语义同源
  const anyField = p.baseUrl !== undefined || p.models !== undefined || p.contextWindow !== undefined
    || p.reasoningEffort !== undefined || p.supportsImages !== undefined;
  if (p.bad || p.name === undefined || !anyField) {
    printUsage();
    return 1;
  }
  const target = resolveTarget(args, PROVIDERS_FLAG_KEYS);
  if (target.bad) {
    printUsage();
    return 1;
  }
  const name = p.name;
  const code = runCatalogWrite(() => upsertProvider(target.root, target.scope, name, upsertPatchOf(p)));
  if (code !== 0) return code;
  console.log(t(
    `ok: provider ${name} updated (${target.scope} ${settingsFileOf(target.scope, target.root)})`,
    `ok：provider ${name} 已更新（${target.scope} ${settingsFileOf(target.scope, target.root)}）`,
  ));
  return 0;
}

/* ---------- remove / key / test ---------- */

function removeCmd(args: string[]): number {
  const name = entryArg(args);
  if (name === undefined) {
    printUsage();
    return 1;
  }
  const target = resolveTarget(args, PROVIDERS_FLAG_KEYS);
  if (target.bad) {
    printUsage();
    return 1;
  }
  const code = runCatalogWrite(() => removeProvider(target.root, target.scope, name));
  if (code !== 0) return code;
  console.log(t(`ok: removed provider ${name} (${target.scope})`, `ok：已移除 provider ${name}（${target.scope}）`));
  return 0;
}

/** 单块扫描产物：done=false → buf 已累计、echo 为本块回显串；done=true → value=提交值（undefined=中止） */
export type ScanOutcome = { done: false; buf: string; echo: string } | { done: true; value: string | undefined };

/**
 * 单块逐字符扫描（纯函数，测试可注入）：raw 模式下 stdin 按块送达——粘贴块会把密钥文本与终止符
 * 合并在一块（剪贴板尾随换行 → 'abc\r'），逐块等值检查会漏判终止符致其嵌入存入的密钥（静默凭据
 * 损坏）。逐字符扫描：\r/\n 即终止（提交已收集值）、\x03 中止（raw 模式不生成 SIGINT，须手动
 * 识别）、\x7f/\b 退格删一位、\x1b 跳过整条控制序列（CSI/SS3：ESC + 引入字节 + 参数/中间字节 +
 * 最终字节）、其余 C0 控制字符忽略、可打印字符入缓冲并计一次回显位。
 */
export function scanChunk(s: string, buf: string): ScanOutcome {
  let out = buf;
  let echo = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\r' || ch === '\n') return { done: true, value: out };
    if (ch === '\x03') return { done: true, value: undefined };
    if (ch === '\x7f' || ch === '\b') {
      if (out.length > 0) {
        out = out.slice(0, -1);
        echo += '\b \b'; // 退格回显位擦除
      }
      continue;
    }
    if (ch === '\x1b') {
      if (s[i + 1] === '[' || s[i + 1] === 'O') {
        i += 2; // 跳过 ESC 与引入字节
        while (i < s.length && s.charCodeAt(i) <= 0x3f) i++; // 参数/中间字节（0x20–0x3F）
        // i 停在最终字节（0x40–0x7E）上——留给 for 的 i++ 消费，此处不得再跳（防吞后续可打印字符）
      } // 裸 ESC：仅忽略该字符
      continue;
    }
    if (ch.charCodeAt(0) < 0x20) continue; // 其余 C0 控制字符忽略（不入缓冲不回显）
    out += ch;
    echo += '*';
  }
  return { done: false, buf: out, echo };
}

/**
 * 隐藏输入最小实现（brief 裁定：setRawMode 逐字符读，仓内无 readline mute 先例）：回显 * 逐位
 * 累计，回车结束；块解析与终端态维护分立——块内容裁定全在 scanChunk 纯函数（可注入钉测）；
 * 回显/终止通路异常时恢复 cooked 模式再上抛（终端态守卫，防异常路径挂死 raw 终端）。
 * 密钥值只经返回值交付写面，无任何回显路径。
 */
function readHiddenLine(prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    try {
      stdin.setRawMode(true);
    } catch {
      // 非 TTY 直调兜底（keyCmd 的 TTY 门先行，此处只防进程内直跑挂死）
    }
    let buf = '';
    const finish = (value: string | undefined): void => {
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // 终端态恢复失败不掩盖原异常
      }
      stdin.pause();
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      try {
        const outcome = scanChunk(chunk.toString('utf8'), buf);
        if (outcome.done) return finish(outcome.value);
        buf = outcome.buf;
        if (outcome.echo !== '') process.stdout.write(outcome.echo);
      } catch (e) {
        // 异常路径终端态守卫：回显/终止通路抛（如管道对面 EPIPE）先恢复 cooked 模式再上抛
        // （finish 已恢复过则本次为幂等兜底；恢复失败不掩盖原异常）
        try {
          stdin.setRawMode(false);
        } catch { /* 流已毁/已 cooked */ }
        throw e;
      }
    };
    stdin.on('data', onData);
  });
}

async function keyCmd(args: string[]): Promise<number> {
  const name = entryArg(args);
  const target = resolveTarget(args, PROVIDERS_FLAG_KEYS);
  if (name === undefined || target.bad) {
    printUsage();
    return 1;
  }
  // TTY 门先于条目定位：无终端时的失败原因恒是通道错（引流 GUI 设置页/raw 编辑面），不是条目错
  if (!process.stdin.isTTY) {
    console.error(t(
      'error: providers key requires an interactive terminal (TTY);'
      + ' set the key via the GUI settings page or edit the settings env block (raw) directly',
      'error：providers key 需要交互终端（TTY）；请经 GUI 设置页配置密钥，或直接编辑 settings env 块（raw）',
    ));
    return 1;
  }
  // 在场预检（setProviderApiKey 同判据：该 scope 装载视图可见）——别让用户白打一遍密钥才报 not found
  const viewRoot = target.scope === 'project' ? target.root : null;
  if (!listProviders(viewRoot).providers.some((p) => p.name === name)) {
    console.error(t(`error: provider not found: ${name}`, `error：找不到 provider：${name}`));
    return 1;
  }
  const slot = providerApiKeyEnv(name);
  const key = await readHiddenLine(t(`API key for ${name} (${slot}): `, `${name} 的 API key（${slot}）：`));
  if (key === undefined) {
    console.error(t('aborted; nothing written', '已中止；未写入任何内容'));
    return 1;
  }
  if (key === '') {
    // 空输入不落盘：交互面误触回车不等于删行（清空语义归 GUI/raw 编辑面，catalog 空串删行纪律不变）
    console.error(t('error: empty input; nothing written', 'error：空输入；未写入任何内容'));
    return 1;
  }
  const code = runCatalogWrite(() => setProviderApiKey(target.root, target.scope, name, key));
  if (code !== 0) return code;
  // ok 行只落 env 槽名（非密）；密钥值无任何输出通道
  console.log(t(`ok: api key stored for ${name} (env ${slot})`, `ok：已存 ${name} 的 API key（env ${slot}）`));
  return 0;
}

/** fetch 错误摘要（undici 包裹形态拆包）：fetch failed → 追加 cause 链首错（拒连/超时可判） */
function fetchErrText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof AggregateError && cause.errors.length > 0) return `${e.message}: ${cause.errors[0]!.message}`;
  if (cause instanceof Error) return `${e.message}: ${cause.message}`;
  return e.message;
}

/**
 * 连通探测（probeMcpServer 思路的 OpenAI 端点面）：GET <baseUrl>/models 带解析密钥（专用槽 > 主槽，
 * resolveProviderApiKey 单点）；10s 超时（AbortSignal.timeout）。成功两行：ok 行 + 模型数行
 * （OpenAI 兼容 {data:[...]} 取 data 长度；他形态如实报 unknown——2xx 即连通，计数不是连通判据）；
 * 失败是结果不是异常——error 行上屏 + exit 1（CLI 面 CI 可判定）。密钥只进请求头，零回显。
 */
async function testCmd(args: string[]): Promise<number> {
  const name = entryArg(args);
  const target = resolveTarget(args, PROVIDERS_FLAG_KEYS);
  if (name === undefined || target.bad) {
    printUsage();
    return 1;
  }
  const entry = listProviders(target.root).providers.find((p) => p.name === name);
  if (entry === undefined) {
    console.error(t(`error: provider not found: ${name}`, `error：找不到 provider：${name}`));
    return 1;
  }
  const url = `${entry.baseUrl.replace(/\/+$/, '')}/models`;
  const key = resolveProviderApiKey(name);
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, {
      headers: key !== undefined ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error(`error: ${fetchErrText(e)}`);
    return 1;
  }
  if (!res.ok) {
    console.error(t(
      `error: HTTP ${res.status} ${res.statusText} (${url})`,
      `error：HTTP ${res.status} ${res.statusText}（${url}）`,
    ));
    return 1;
  }
  let count = 'unknown';
  try {
    const body = (await res.json()) as { data?: unknown };
    if (Array.isArray(body.data)) count = String(body.data.length);
  } catch {
    // 非 JSON 响应体：计数 unknown，连通结论不变
  }
  console.log(t(`ok: ${name}`, `ok：${name}`));
  console.log(t(`models: ${count}`, `模型数：${count}`));
  return 0;
}

/* ---------- model add|remove|move（模型行三操作） ---------- */

function modelCmd(args: string[]): number {
  const op = args[0];
  const rest = args.slice(1);
  if (op !== 'add' && op !== 'remove' && op !== 'move') {
    printUsage();
    return 1;
  }
  const positional: string[] = [];
  let tier: string | undefined;
  let direction: string | undefined;
  let bad = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const inlineVal = eq === -1 ? undefined : a.slice(eq + 1);
    const take = (): string | undefined => {
      if (inlineVal !== undefined) return inlineVal;
      const v = rest[++i];
      return v !== undefined && !v.startsWith('--') ? v : undefined;
    };
    switch (key) {
      case 'tier': {
        // 仅 model add 有 tier 位；枚举校验归 catalog 写面（assertTier，isolation/executor 透传同款）
        if (op !== 'add') { bad = true; break; }
        const v = take();
        if (v === undefined || v === '') bad = true;
        else tier = v;
        break;
      }
      case 'direction': {
        // 仅 model move 有 direction 位（相邻调序 up|down，枚举校验归 catalog 写面）
        if (op !== 'move') { bad = true; break; }
        const v = take();
        if (v === undefined || v === '') bad = true;
        else direction = v;
        break;
      }
      case 'scope':
      case 'root':
        // 公共 target 旗标跳过（两形态；两 token 形态吞值，值合法性归 resolveTarget）
        if (inlineVal === undefined) i++;
        break;
      case 'json':
        if (inlineVal !== undefined) bad = true;
        break;
      default:
        bad = true; // 词汇表外旗标
    }
  }
  // 位置参数恰两个（<provider> <model>）；move 另需 --direction
  if (bad || positional.length !== 2 || (op === 'move' && direction === undefined)) {
    printUsage();
    return 1;
  }
  const target = resolveTarget(rest, PROVIDERS_FLAG_KEYS);
  if (target.bad) {
    printUsage();
    return 1;
  }
  const provider = positional[0]!;
  const model = positional[1]!;
  let code: number;
  if (op === 'add') {
    const entry: ProviderModelInput = { model, ...(tier !== undefined ? { tier: tier as ProviderModelInput['tier'] } : {}) };
    code = runCatalogWrite(() => modelAdd(target.root, target.scope, provider, entry));
  } else if (op === 'remove') {
    code = runCatalogWrite(() => modelRemove(target.root, target.scope, provider, model));
  } else {
    code = runCatalogWrite(() => modelMove(target.root, target.scope, provider, model, direction as 'up' | 'down'));
  }
  if (code !== 0) return code;
  const okLine = op === 'add'
    ? t(`ok: model ${model} added to ${provider} (${target.scope})`, `ok：已向 ${provider} 追加模型 ${model}（${target.scope}）`)
    : op === 'remove'
      ? t(`ok: model ${model} removed from ${provider} (${target.scope})`, `ok：已从 ${provider} 摘除模型 ${model}（${target.scope}）`)
      : t(`ok: model ${model} moved ${direction} on ${provider} (${target.scope})`, `ok：${provider} 的模型 ${model} 已${direction === 'up' ? '上' : '下'}移（${target.scope}）`);
  console.log(okLine);
  return 0;
}

/** 命令入口：providers 子命令族；返回 exit code（0 成功 / 1 用法错或写失败），调用方落 process.exitCode */
export async function runProviders(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === 'list') return listCmd(args.slice(1));
  if (sub === 'add') return addCmd(args.slice(1));
  if (sub === 'set') return setCmd(args.slice(1));
  if (sub === 'remove') return removeCmd(args.slice(1));
  if (sub === 'key') return keyCmd(args.slice(1));
  if (sub === 'test') return testCmd(args.slice(1));
  if (sub === 'model') return modelCmd(args.slice(1));
  printUsage();
  return 1;
}

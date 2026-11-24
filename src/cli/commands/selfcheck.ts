import { Harness } from '../../harness';
import { assembleKnowledgeBase, KnowledgeBase } from '../../harness/knowledge';
import { softwarePipelineTemplate } from '../../graph/templates';
import { codeReviewTemplate } from '../../loop/templates';
import { StubAdapter } from '../../model/adapter';
import { resolveKbEnv } from '../../config/env';
import { loadMcpServers } from '../../config';
import { resolveShell } from '../../harness/security/sandbox';
import { resolveIsolation, sandboxEnabled } from '../../harness/security/landlock';
import { selfcheckTuiSmoke } from '../../tui/selfcheck-smoke';
import type { CliArgs } from '../index';
import { t } from '../../i18n';

/** 骨架自检：实例化 Harness 门面，聚合五大能力并打印骨架摘要 */
export async function runSelfcheck(_args: CliArgs): Promise<void> {
  // KB 装配真实化（D18/S1）：先按真实环境装配（构造 + load 挂接既有索引），就绪行反映装配实况；
  // 显式误配（未注册后端名等）如实报错并 exit 1；无 KB env 的机器（CI/门禁）=「未配置」合法确定态，仍 exit 0
  const kbEnv = resolveKbEnv(process.env as Record<string, string | undefined>);
  let kb: KnowledgeBase | undefined;
  let kbError: string | undefined;
  try {
    kb = assembleKnowledgeBase(kbEnv, process.cwd());
  } catch (e) {
    kbError = e instanceof Error ? e.message : String(e);
    process.exitCode = 1;
  }
  const h = new Harness({ root: process.cwd(), kb });
  const perceived = h.perception.scan();
  console.log('SunshineX skeleton selfcheck OK');
  console.log('project :', perceived.project?.name ?? '(no SUNSHINE.md)');
  console.log('rules   :', perceived.project?.rules.length ?? 0);
  console.log('files   :', perceived.files.length, 'deps:', perceived.dependencies.length);
  console.log('tools   :', h.tools.list().map((t) => t.name).join(', '));
  const mcpServers = loadMcpServers(process.cwd());
  try {
    await h.mcpReady();
  } catch (e) {
    console.error('mcp     :', `assembly failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
  for (const w of h.mcpWarnings()) {
    console.warn('mcp warn:', w);
  }
  const mcpToolCount = h.tools.list().filter((t) => t.name.startsWith('mcp__')).length;
  console.log('mcp     :', t(
    `${mcpServers.length} servers configured, ${mcpToolCount} tools registered (registry gate; empty = all denied)`,
    `${mcpServers.length} servers configured, ${mcpToolCount} tools registered（登记制闸门，空 = 全禁）`,
  ));
  console.log('harness :', [h.perception, h.tools, h.security, h.sandbox, h.context, h.reactor].length, 'modules ready');
  // exec 决议观测：Windows 上「Git Bash 探测未命中」此前无任何可循线索（静默改变引号与命令集），此行把实际命中的 shell 与来源显式上屏
  const shell = resolveShell();
  console.log('shell   :', `${shell.file} ${shell.args.join(' ')} (${shell.source})`);
  // permissions 装配告警上屏：装载期形状非法「宁可少配不错配」只留告警，自检面把被忽略的配置亮出来（不静默）
  for (const w of h.permissionWarnings()) {
    console.log(`permissions warn: ${w}`);
  }
  // imageHistoryLimit 装载告警上屏（spec §3.2 settings 键形状非法回缺省——同上不静默）
  for (const w of h.imageHistoryWarnings()) {
    console.log(`imageHistoryLimit warn: ${w}`);
  }
  // 隔离口径上屏（spec 5.5）：auto 语义 = 缺省探测（显式声明优先，此处只消费探测结果），真实内核探针不入库
  const isolation = await resolveIsolation();
  console.log(`isolation : ${isolation}${sandboxEnabled() ? '' : ' (sandbox off)'}`);
  // kb 就绪行只反映真实装配（S1 修复前仅凭 env 解析即打印 ready——观测面与装配实况相反）。
  // 冒烟止于装配冒烟（构造 + load + 索引量上屏）：一次真实查询要走计费 embedding，代价不可控，不做查询冒烟
  if (kbError !== undefined) {
    console.error('knowledge:', `assembly failed: ${kbError}`);
  } else if (kb) {
    const kbStats = kb.stats();
    console.log('knowledge:', t(
      `kb_search ready (backend=${kbEnv.backend}, embedding=${kbEnv.embeddingModel}, index=${kbStats.chunks} chunks)`,
      `kb_search 就绪（backend=${kbEnv.backend}，embedding=${kbEnv.embeddingModel}，索引 ${kbStats.chunks} 块）`,
    ));
  } else {
    // D28 起索引入口在册：未配置行顺带给「配 env + kb-index 建索引」的最短启用路径（省一次翻手册）
    console.log('knowledge:', t(
      'not configured → kb_search degrades at call time (enable: embedding env + sunshinex kb-index, MANUAL section 2)',
      '未配置→kb_search 调用时降级（启用：配置 embedding 环境变量 + sunshinex kb-index 建索引，见 MANUAL 第二节）',
    ));
  }
  const skillHello = h.skills.resolve('hello-sunshine', { name: 'selfcheck' });
  console.log('skills  :', `${h.skills.list().length} loaded, resolve=${skillHello.ok ? 'ok' : 'fail'}`);
  console.log('learned :', h.skills.learnedCount());
  const usage = h.ledger.summary();
  console.log('usage  :', `${usage.runs} runs / ${usage.tokens} tokens`);
  // TUI 流式管线冒烟（D80③ 抽 src/tui/selfcheck-smoke 单点）：cli→tui 单向分发（与 index→runTui
  // 同形），合成流式适配器与剥码等值口径随段内迁，本文件只余装配冒烟行
  await selfcheckTuiSmoke();
  const loopReady = codeReviewTemplate({ safety: h.safety, registry: h.tools, context: h.context, model: new StubAdapter() });
  console.log('loop    :', `${loopReady.name} template ready (${loopReady.nodes.length} nodes)`);
  const graphReady = softwarePipelineTemplate({ safety: h.safety, registry: h.tools, context: h.context, model: new StubAdapter() });
  console.log('graph   :', `${graphReady.name} template ready (${graphReady.nodes.length} nodes)`);
  // MCP 收口（D20，机理同 teardownCliRun 在册注释——run-loop/run/pipeline 共用单点）：mcpReady 装配的
  // stdio 子进程不关闭会悬挂事件循环，配 stdio MCP 服务器的机器上 selfcheck 可能永不退出；空配置/未连接时幂等 no-op
  await h.mcpClose();
  // 双保险（Task 28 bug：Windows 下 MCP stdio 子进程树不随 SDK close 终结，selfcheck 实测 60s+ 悬挂；
  // 主修在 harness mcp client close 路径按 pid 树终结）。leaf 命令强制收敛兜底：残余句柄（第三方传输/
  // 未知泄漏面）不再阻退出；process.exit 透传既有 exitCode（装配失败等已置 1 的失败语义不丢）
  process.exit(process.exitCode ?? 0);
}

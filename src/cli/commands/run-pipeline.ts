import * as path from 'path';
import * as readline from 'node:readline/promises';
import { DEFAULT_TERMINATION, GraphTemplate, softwarePipelineTemplate, TemplateTaskSpec, templateToTaskSpecs } from '../../graph/templates';
import { LoopDeps } from '../../loop/engine';
import { buildDeps } from '../../runtime';
import { resolveDirArg, flagList } from '../index';
import { t } from '../../i18n';
import { fail, ok, Result } from '../../result';
import type { TaskBoard } from '../../taskboard/board';
import type { BoardTask } from '../../taskboard/model';
import type { CliArgs } from '../index';

/** 交互审批：gate 名单 → {gate: bool}；readline 注入便于测试 */
export async function confirmApprovals(
  gates: string[],
  rl: { question(q: string): Promise<string> },
): Promise<Record<string, boolean>> {
  const approvals: Record<string, boolean> = {};
  for (const g of gates) {
    const ans = (await rl.question(`[审批] ${g} 批准交付？(y/N) `)).trim().toLowerCase();
    approvals[g] = ans === 'y' || ans === 'yes';
  }
  return approvals;
}

/** 两段装配（P2/T6，独立导出供宏测直测装配序列）：先逐个 create 收集模板节点 id → 板 taskId 映射，
 *  再回补依赖边——依赖边指向板内 taskId 而非模板节点名，须任务建齐后才知道映射（一段式会在 create 的
 *  unknown dependency 校验处失败）。失败即中止（部分落板任务由调用方收尾报告，不回滚——事件流可追溯）。 */
export function assembleBoardTasks(
  board: Pick<TaskBoard, 'create' | 'setDependency'>,
  specs: TemplateTaskSpec[],
): Result<Map<string, string>> {
  const idMap = new Map<string, string>();
  for (const s of specs) {
    const r = board.create({ title: s.title, spec: s.spec, ...(s.gated === true ? { gated: true } : {}), executor: 'internal' });
    if (!r.ok) return fail(r.error.code, `create ${s.id}: ${r.error.message}`);
    idMap.set(s.id, r.value.taskId);
  }
  for (const s of specs) {
    for (const d of s.dependsOn) {
      const r = board.setDependency(idMap.get(s.id)!, idMap.get(d)!);
      if (!r.ok) return fail(r.error.code, `setDependency ${s.id} <- ${d}: ${r.error.message}`);
    }
  }
  return ok(idMap);
}

/** CLI 运行收尾单点（批A R2）：run/pipeline 三份逐字重复的收尾收敛于此——drain 后台沉淀 → 停后台任务
 *  → MCP 降级警告上屏 → 关闭 MCP 连接 → 按 status 判定退出码；参数只收五步实际用到的成员（两命令 deps
 *  同构最小面，stopAllTasks 为 D24 接线的可选扩展成员），警告相对顺序与用户可观测文案不变（停任务零上屏） */
export async function teardownCliRun(
  deps: Pick<LoopDeps, 'pipeline' | 'mcpWarnings' | 'mcpClose'> & { stopAllTasks?: () => void },
  status: string,
): Promise<void> {
  // 收尾消化后台沉淀队列（规格 §3.5）：此时用户本就在等命令结束，不构成新增阻塞
  if (deps.pipeline) await deps.pipeline.drain();
  // 后台任务收口（D24，规格 D9 任务属进程）先停任务再关 MCP：任务（exec 子进程/subagent 中断线）是工具
  // 调用链的执行体，可能仍持有经 MCP 通道派发的在途工作——执行体先停、通道后关，MCP 关闭时刻起不再有
  // 任务侧新工作，时序确定；且两者失败模式不对称：stopAll 同步纯本地记账（stop 句柄 + 终态行
  // appendFileSync）不因远端故障抛错，mcpClose 异步且可抛——无失败模式的步骤放前，MCP 收尾任一异常路径
  // 都不再吞掉 [stopped] 终态行（任务日志半截正是 D24 病根本体）
  deps.stopAllTasks?.();
  // MCP 降级警告上屏：服务器失败只损失该服务器工具，警告不吞
  for (const w of (deps.mcpWarnings?.() ?? [])) console.warn('mcp warn:', w);
  // MCP 连接收口：关闭 stdio 子进程，防悬挂事件循环
  if (deps.mcpClose) await deps.mcpClose();
  if (status !== 'done') process.exitCode = 1;
}

/** 引擎路径装配（独立导出供离线测试 run-pipeline.test.ts 消费）：goal 须含「验收标准：id=描述」段。
 *  P2/T6 起 CLI 主路径已切 TaskBoard 板路径（runPipeline），引擎模板仅作离线测试面与 softwarePipelineTemplate
 *  消费面（selfcheck）保留。 */
export function runPipelineAssembly(
  deps: LoopDeps,
  opts: { goal: string; ruleCheckers?: Record<string, (io: { ctx: unknown; goal: string }) => Promise<boolean> | boolean> },
): GraphTemplate {
  return softwarePipelineTemplate(deps, {
    goal: opts.goal,
    ruleCheckers: opts.ruleCheckers as never,
  });
}

/** 板路径 settle 预算（P2/T6）：复用 termination.timeoutMs（缺省 24h）但 min 上限 10min 防挂——板收敛靠
 *  轮询推进，单任务墙钟另由 board 的 taskTimeoutMs（缺省 30min）兜底，总帽只防 CLI 无限等；
 *  驱动循环内 settle 以短片轮询（中间 in-review 关单推进链条，见 runPipeline 注释）。 */
const SETTLE_TOTAL_MS = Math.min(DEFAULT_TERMINATION.timeoutMs, 10 * 60 * 1000);
const SETTLE_SLICE_MS = 200;

/** 板路驱动循环（P2/T6，独立导出供宏测直测真循环含 gate 分支）：settle 短片轮询 + lead 自动关单 +
 *  gated 人工审批。**收敛域 = 管线任务集（ids，装配返回的 idMap.values()）**——板经 teams/main 持久化，
 *  同工作区二次跑 pipeline 会遇上轮残留任务，非本管线任务一律不可见不动：残留 failed 不秒杀本轮、
 *  残留交互 in-review 不被越权关单、上轮被拒 gated 不混入本轮审批，亦不进返回回执。
 *  settle 收敛判据是「无 pending 且无 claimed」而依赖链的中间 in-review 会顶住收敛（dispatchable 要求
 *  依赖全 done）——引擎路径「节点 pass 即放行下游」的板语义同义映射 = lead 对 in-review 自动
 *  review(approved) 关单；gated 任务保持 pending 顶住派发，人工审批后解锁。review 失败守卫：记 warn 不走
 *  死路（状态被外部改判时下轮快照自然接管）；关单/审批后落入 deadline+settle 再循环（不 continue 直跳：
 *  下游派发需真实时间，防快照自旋）。rl 可注入（测试桩）；yes 直批免交互。 */
export async function driveBoardPipeline(
  board: Pick<TaskBoard, 'snapshot' | 'settle' | 'review'>,
  ids: Iterable<string>,
  opts: { yes?: boolean; rl?: { question(q: string): Promise<string> }; settleTotalMs?: number; settleSliceMs?: number; warn?: (line: string) => void } = {},
): Promise<{ status: 'done' | 'failed' | 'rejected' | 'timeout'; tasks: BoardTask[] }> {
  const mine = new Set(ids);
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  const deadline = Date.now() + (opts.settleTotalMs ?? SETTLE_TOTAL_MS);
  const sliceMs = opts.settleSliceMs ?? SETTLE_SLICE_MS;
  let status: 'done' | 'failed' | 'rejected' | 'timeout' = 'done';
  const pipelineTasks = (): BoardTask[] => Object.values(board.snapshot().tasks).filter((t2) => mine.has(t2.id));
  for (;;) {
    const tasks = pipelineTasks();
    const failed = tasks.filter((t2) => t2.status === 'failed');
    const inReview = tasks.filter((t2) => t2.status === 'in-review');
    const busy = tasks.filter((t2) => t2.status === 'pending' || t2.status === 'claimed');
    if (failed.length > 0) { status = 'failed'; break; }
    if (busy.length === 0 && inReview.length === 0) break; // 管线任务全 done：收敛完成
    const gates = tasks.filter((t2) => t2.gated === true);
    if (inReview.length > 0) {
      // lead 自动关单推进链条（只关本管线任务）
      for (const t2 of inReview) {
        const r = board.review(t2.id, { approved: true });
        if (!r.ok) warn(`[pipeline] review ${t2.id}: ${r.error.code}: ${r.error.message}`);
      }
    } else if (gates.length > 0 && busy.every((t2) => t2.gated === true)) {
      // 仅剩 gated 待审（其余 busy 是超时未清的执行残留则走下方超时分支）：人工审批（非管线任务不混入）
      const display = gates.map((t2) => `${t2.id} ${t2.title}`);
      const approvals = opts.yes === true
        ? Object.fromEntries(display.map((g) => [g, true]))
        : await confirmApprovals(display, opts.rl ?? readline.createInterface({ input: process.stdin, output: process.stdout }));
      let rejected = false;
      for (let i = 0; i < gates.length; i++) {
        const approved = approvals[display[i]!] === true;
        const r = board.review(gates[i]!.id, { approved }); // 拒绝维持 gated（板语义），此处不重派
        if (!r.ok) warn(`[pipeline] review ${gates[i]!.id}: ${r.error.code}: ${r.error.message}`);
        if (!approved) rejected = true;
      }
      if (rejected) { status = 'rejected'; break; }
      // 门已解：落入 settle 等待 gate 任务执行
    }
    if (Date.now() >= deadline) { status = 'timeout'; break; }
    await board.settle(Math.min(sliceMs, Math.max(1, deadline - Date.now())));
  }
  return { status, tasks: pipelineTasks().sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })) };
}

export async function runPipeline(args: CliArgs): Promise<void> {
  // 目录来源统一单点（规格 §6.2）：与顶层及 run 同判据——--workdir 优先，裸词报「无法识别命令」不启动
  const d = resolveDirArg(args);
  if (d.unrecognized) {
    console.error(t('Unrecognized command. Run sunshinex help for usage.', '无法识别命令，使用 sunshinex help 查看使用方法'));
    process.exitCode = 1;
    return;
  }
  if (d.ignored) console.warn(t(`--workdir takes precedence; ignoring positional dir ${d.ignored}`, `--workdir 优先，位置参数目录 ${d.ignored} 已忽略`));
  const dir = d.dir;
  if (!dir) throw new Error('用法：sunshinex pipeline <dir> --goal="目标（验收标准：id=描述）" [--yes]');
  const root = path.resolve(dir);
  const goal = String(args.flags.goal ?? '');
  if (!goal) throw new Error('缺少 --goal="目标（验收标准：id=描述）"——check 依赖结构化验收清单');
  // --add-dir（spec 5.3，可重复 flag）：由 flagList 归一收集后随装配透传（三面同源单点 buildDeps）
  const deps = buildDeps(root, args.flags, flagList(args.flags, 'add-dir'));

  // 板路径（P2/T6）：模板宏化 → 任务集 → 两段落板，engine 直跑路径由此替换
  const specs = templateToTaskSpecs(goal);
  console.log(`[pipeline] root=${root} nodes=${specs.map((s) => s.id).join('→')}`);
  // fork 模型（CLAUDE.md §11）：goal 槽取消，任务指令以链行承载（单发 pipeline 空链起，行为对外不变）
  deps.context.appendInstructionLine(goal);
  const asm = assembleBoardTasks(deps.taskboard, specs);
  if (!asm.ok) {
    console.error(`[pipeline] board assembly failed: ${asm.error.code}: ${asm.error.message}`);
    await teardownCliRun(deps, 'failed');
    return;
  }

  // 驱动循环（P2/T6）：收敛域 = 本管线任务集（idMap.values()）——上轮残留任务（failed/交互 in-review/
  // 被拒 gated）不可见不动；细节见 driveBoardPipeline 注释
  const result = await driveBoardPipeline(deps.taskboard, asm.value.values(), { yes: Boolean(args.flags.yes) });

  // 汇总回执：每任务一行（只含本管线任务；in-review 视为完成待审，标注）；失败任务附 artifact 摘要（失败
  // note 在事件流，板状态投影不含——排障走 teams/<board>/events.jsonl）
  for (const t2 of result.tasks) {
    const mark = t2.status === 'in-review' ? 'in-review(完成待审)' : t2.status;
    console.log(`${t2.id} [${mark}] ${t2.title}`);
    if (t2.status === 'failed') console.error(`[failed-task] ${t2.id} ${t2.title}: tokens=${t2.artifact?.tokens ?? 0}（详情见事件流）`);
  }
  // done 判定 = 无 failed/blocked（blocked 为 pending 派生态，pending 即不 clean）且全部 done/in-review
  const clean = result.tasks.length > 0 && result.tasks.every((t2) => t2.status === 'done' || t2.status === 'in-review');
  const fin = clean ? 'done' : result.status;
  console.log(`run   : ${fin}`);
  await teardownCliRun(deps, fin);
}

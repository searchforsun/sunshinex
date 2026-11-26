// sunx 工具面（2026-11-15 sunx P1 Task 3；P2 Task 2 增板监视面）：dispatch_task / task_status 注册 +
// SUNX_FACE_TOOLS 白名单装配 + get_agent_team_board 随团队工具进面（2026-11-21 起 dispatch_task 只走子智能体通道）。
// 四面覆盖（brief Step 1）：①sunx 装配注册分派/窥视/板监视三件、白名单 derive 精确集合=常量（单点产出）；
// ②standard 装配基线不含两件（主链 face 零变化；板监视面 standard 原有注册不属白名单收窄面）；③内核
// 运行时（createKernelRuntime）sunx face=白名单（模型 wire 工具恰八件 + 呈现表随 effective face）；
// ④fork 子代 kind 继承（spec §17.2：sunx 派发的 fork 子智能体稳定段与父逐字节同面——身份行随 Reactor kind 透传）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness, SUNX_FACE_TOOLS } from './index';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { createKernelRuntime } from '../session/runtime';
import { toolCallLine } from '../tui/tool-verbs';
import type { ChatRequest } from '../types';

// 文件级数据目录钉定（沿 runtime.test.ts 先例）：单文件直跑时统一落本文件临时沙箱
const filePrevData = process.env.SUNSHINEX_DATA_DIR;
const fileDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sunxface-data-'));
process.env.SUNSHINEX_DATA_DIR = fileDataDir;
test.after(() => {
  if (filePrevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
  else process.env.SUNSHINEX_DATA_DIR = filePrevData;
  fs.rmSync(fileDataDir, { recursive: true, force: true });
});

const mktmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** 包装探针适配器：记录每轮 chat 的 wire 工具名（面观测）+ 消息全文（稳定段观测），应答交基线脚本 */
function probeAdapter(base: ScriptedAdapter, seen: { prompts: string[]; toolNames: string[] }): ModelAdapter {
  return {
    provider: 'probe',
    chat: async (req: ChatRequest) => {
      seen.prompts.push(req.messages.map((m) => m.content).join('\n'));
      seen.toolNames.push(...(req.tools ?? []).map((t) => t.function.name));
      return base.chat(req);
    },
  };
}

test('sunx kind 装配：注册表含 dispatch/task_status；普通 kind 不含（主链基线不变）', () => {
  const tmp = mktmp('sunshinex-sunxface-asm-');
  let sunx: Harness | undefined;
  try {
    sunx = new Harness({ root: tmp, mode: 'full-access', kind: 'sunx', model: new ScriptedAdapter([]), learnSkills: false });
    assert.ok(sunx.tools.has('dispatch_task'), 'sunx 装配应注册 dispatch_task');
    assert.ok(sunx.tools.has('task_status'), 'sunx 装配应注册 task_status');
    assert.ok(sunx.tools.has('get_agent_team_board'), 'sunx 装配应持板监视面（P2 Task 2 随板通道进面）');
    assert.ok(sunx.tools.has('schedule_wakeup'), 'sunx 装配应注册定时唤醒（P2 Task 3 随 sunx 分叉进面）');
    assert.ok(sunx.tools.has('schedule_task'), 'sunx 装配应注册定时任务（P2 Task 3 随 sunx 分叉进面）');
    assert.equal(sunx.tools.get('dispatch_task')?.display?.verb, 'DISPATCH', '分派动词呈现元数据');
    assert.equal(sunx.tools.get('task_status')?.display?.verb, 'TASK_STATUS', '窥视动词呈现元数据');
    assert.equal(sunx.tools.get('schedule_wakeup')?.display?.verb, 'SCHEDULE', '定时唤醒动词呈现元数据');
    assert.equal(sunx.tools.get('schedule_task')?.display?.verb, 'SCHEDULE_TASK', '定时任务动词呈现元数据');
    const std = new Harness({ root: tmp, mode: 'full-access', model: new ScriptedAdapter([]), learnSkills: false });
    assert.equal(std.tools.has('dispatch_task'), false, 'standard 装配不得含 dispatch_task（普通 face 基线守护）');
    assert.equal(std.tools.has('task_status'), false, 'standard 装配不得含 task_status（普通 face 基线守护）');
    assert.equal(std.tools.has('schedule_wakeup'), false, 'standard 装配不得含 schedule_wakeup（普通 face 基线守护）');
    assert.equal(std.tools.has('schedule_task'), false, 'standard 装配不得含 schedule_task（普通 face 基线守护）');
    std.team.stopAll();
    std.tasks.stopAll();
  } finally {
    sunx?.team.stopAll();
    sunx?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('跨 Sunx 对等消息两件（2026-11-26 用户裁定）：sunx 装配注册 + 标准面零注册 + 接缝缺席 NOT_SUPPORTED 降级', async () => {
  const tmp = mktmp('sunshinex-sunxface-peers-');
  let sunx: Harness | undefined;
  let std: Harness | undefined;
  try {
    // 接缝注入档：枚举/投递走宿主口（本测只验注册与动词面，行为归 serve/sunx-peers.test）
    const sent: Array<{ to: string; text: string }> = [];
    sunx = new Harness({
      root: tmp,
      mode: 'full-access',
      kind: 'sunx',
      model: new ScriptedAdapter([]),
      learnSkills: false,
      sunxPeers: {
        list: async () => [{ id: 'peer-1', name: 'Planner', running: false, live: true, awaiting: false, root: 'D:/w', updatedAt: 1, charter: '规划者' }],
        send: async (to, text) => {
          sent.push({ to, text });
          return { ok: true, name: 'Planner', queued: false };
        },
      },
    });
    assert.ok(sunx.tools.has('list_sunx_peers'), 'sunx 装配应注册 list_sunx_peers');
    assert.ok(sunx.tools.has('send_sunx_messages'), 'sunx 装配应注册 send_sunx_messages');
    assert.equal(sunx.tools.get('list_sunx_peers')?.display?.verb, 'SUNX_PEERS', '发现动词呈现元数据');
    assert.equal(sunx.tools.get('send_sunx_messages')?.display?.verb, 'SUNX_SEND', '投递动词呈现元数据');
    // 回读:发现清单内容原样（名称/品行中文不翻译——用户裁定「内容是什么就是什么」）
    const listed = await sunx.tools.get('list_sunx_peers')!.executor({});
    assert.match(String(listed.stdout), /Planner \[idle\] id=peer-1/, '清单行携带名称/状态/寻址 id');
    assert.match(String(listed.stdout), /charter:\n {4}规划者/, '品行原文随行');
    const receipt = await sunx.tools.get('send_sunx_messages')!.executor({ to: 'peer-1', text: 'hi' });
    assert.match(String(receipt.stdout), /message delivered to Planner \(peer-1\) - run started/, '回执=送达回执');
    assert.deepEqual(sent, [{ to: 'peer-1', text: 'hi' }], '投递走宿主接缝');

    // 标准面零注册（主链 face 基线守护）
    std = new Harness({ root: tmp, mode: 'full-access', model: new ScriptedAdapter([]), learnSkills: false });
    assert.equal(std.tools.has('list_sunx_peers'), false, 'standard 装配不得含 list_sunx_peers');
    assert.equal(std.tools.has('send_sunx_messages'), false, 'standard 装配不得含 send_sunx_messages');

    // 接缝缺席（TUI/CLI 直构）：注册但在执行期确定降级（schedule_* 先例）
    const bare = new Harness({ root: tmp, mode: 'full-access', kind: 'sunx', model: new ScriptedAdapter([]), learnSkills: false });
    try {
      await assert.rejects(
        async () => { await bare.tools.get('list_sunx_peers')!.executor({}); },
        (err: unknown) => (err as { code?: string }).code === 'NOT_SUPPORTED',
        '接缝缺席=NOT_SUPPORTED（面集合不变量不破）',
      );
    } finally {
      bare.team.stopAll();
      bare.tasks.stopAll();
    }
  } finally {
    sunx?.team.stopAll();
    sunx?.tasks.stopAll();
    std?.team.stopAll();
    std?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createKernelRuntime 透传 sunxPeers/channelSend 接缝（2026-11-26 根修：调用实参对象字面量含展开时 excess-property 检查失效，接缝键曾静默丢弃——新建 sunx 报 NOT_SUPPORTED）', async () => {
  const tmp = mktmp('sunshinex-sunxface-seam-');
  let rt: ReturnType<typeof createKernelRuntime> | undefined;
  try {
    rt = createKernelRuntime({
      root: tmp,
      kind: 'sunx',
      model: new ScriptedAdapter([]),
      sunxPeers: {
        list: async () => [],
        send: async () => ({ ok: true, name: 'X', queued: false }),
      },
      channelSend: { send: async () => true },
    });
    // sunx 两件:面在 + 接缝在场(空列=合法空态,非 NOT_SUPPORTED)
    assert.ok(rt.harness.tools.has('list_sunx_peers'), 'sunx 面应含 list_sunx_peers');
    const r = await rt.harness.tools.get('list_sunx_peers')!.executor({});
    assert.match(String(r.stdout), /no other live Sunx instances/, '接缝已透传到 harness（执行不降级）');
    // channelSend 同根修:通道会话此前也拿不到 send_channel_message
    assert.ok(rt.harness.tools.has('send_channel_message'), 'channelSend 接缝应透传并注册 send_channel_message');
  } finally {
    rt?.harness.team.stopAll();
    rt?.harness.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sunx face 白名单精确集合：恰为 SUNX_FACE_TOOLS，derive({only}) 单点产出', () => {
  const tmp = mktmp('sunshinex-sunxface-set-');
  let h: Harness | undefined;
  try {
    h = new Harness({ root: tmp, mode: 'full-access', kind: 'sunx', model: new ScriptedAdapter([]), learnSkills: false });
    const face = h.tools.derive({ only: [...SUNX_FACE_TOOLS] });
    assert.deepEqual(
      face.list().map((t) => t.name).sort(),
      [...SUNX_FACE_TOOLS].sort(),
      `白名单派生面必须恰为 SUNX_FACE_TOOLS 八件（缺件=装配漏注册，多件=常量漂移）：实际 ${face.list().map((t) => t.name).join(', ')}`,
    );
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createKernelRuntime：sunx 主链 face=白名单派生——模型 wire 工具恰八件；呈现表随 effective face', async () => {
  const tmp = mktmp('sunshinex-sunxface-rt-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, '.data');
  try {
    const seen = { prompts: [] as string[], toolNames: [] as string[] };
    const rt = createKernelRuntime({
      root: tmp,
      kind: 'sunx',
      model: probeAdapter(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), seen),
    });
    const r = await rt.runTask('编排验收', { maxSteps: 2 });
    assert.equal(r.done, true);
    assert.deepEqual(
      [...new Set(seen.toolNames.flat())].sort(),
      [...SUNX_FACE_TOOLS].sort(),
      `loop 主链模型面必须恰见白名单七件：实际 ${seen.toolNames.flat().join(', ')}`,
    );
    // 呈现表随 effective face（rt.toolDisplay 装配快照，D80② 后经返回值消费——单例兜底接线归 TUI 装配侧）：
    // 分派动词在册、执行面动词不在册
    assert.equal(toolCallLine('dispatch_task', {}, rt.toolDisplay), 'DISPATCH', '呈现层经注入表取分派动词');
    assert.equal(toolCallLine('task_status', {}, rt.toolDisplay), 'TASK_STATUS', '呈现层经注入表取窥视动词');
    assert.equal(rt.toolDisplay['dispatch_task'] !== undefined, true, 'sunx face 呈现表含分派工具');
    assert.equal(rt.toolDisplay['exec'], undefined, 'sunx face 不含执行面工具（exec 不在白名单）');
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createKernelRuntime：standard 主链 face 原样——wire 含 exec、零 dispatch_task/task_status', async () => {
  const tmp = mktmp('sunshinex-sunxface-rtstd-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, '.data');
  try {
    const seen = { prompts: [] as string[], toolNames: [] as string[] };
    const rt = createKernelRuntime({
      root: tmp,
      model: probeAdapter(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), seen),
    });
    const r = await rt.runTask('普通验收', { maxSteps: 2 });
    assert.equal(r.done, true);
    const names = [...new Set(seen.toolNames.flat())];
    assert.ok(names.includes('exec'), 'standard 主链保持执行面（face 基线）');
    assert.equal(names.includes('dispatch_task'), false, 'standard 主链零 dispatch_task');
    assert.equal(names.includes('task_status'), false, 'standard 主链零 task_status');
    assert.equal(rt.toolDisplay['exec'] !== undefined, true, 'standard 呈现表回主链全量');
    assert.equal(rt.toolDisplay['dispatch_task'], undefined, 'standard 呈现表零分派动词');
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fork 子代 kind 继承：sunx 装配 fork child 稳定段带 Sunx 身份行；standard 装配不含（spec §17.2）', async () => {
  // sunx：父经 spawn 出牌 → fork 子 Reactor kind 随 deps 透传 → 子 prompt（稳定段）带 Sunx 身份行
  const tmp1 = mktmp('sunshinex-sunxface-forkkind-');
  try {
    const seen = { prompts: [] as string[], toolNames: [] as string[] };
    const h = new Harness({
      root: tmp1,
      mode: 'full-access',
      kind: 'sunx',
      learnSkills: false,
      model: probeAdapter(
        new ScriptedAdapter([
          JSON.stringify({ tool: 'spawn', input: { prompt: 'fork 任务', label: 'w' } }),
          JSON.stringify({ done: true, reply: 'child done' }),
          JSON.stringify({ done: true, reply: 'main done' }),
        ]),
        seen,
      ),
    });
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.equal(r.done, true, '主链正常收口');
    assert.ok(seen.prompts.length >= 3, `探针应捕获父/子两代 prompt：${seen.prompts.length}`);
    const childPrompt = seen.prompts[1] ?? '';
    assert.ok(childPrompt.includes('fork 任务'), '第 2 轮 prompt 应为 fork 子代（携带任务行）');
    assert.ok(childPrompt.includes('You are the Sunx orchestrator'), 'fork 子代稳定段与父同面（kind 透传，§17.2 前缀缓存裁定）');
    assert.ok(childPrompt.includes('Override: you are a WORKER dispatched by the Sunx orchestrator'), '子代段尾带 worker 覆写行（2026-11-15 严重 bug 修复：子面无 dispatch_task，编排者指令是假命题）');
    assert.ok(childPrompt.indexOf('Override: you are a WORKER') > childPrompt.indexOf('You are the Sunx orchestrator'), '覆写行后出（废黜先行的编排者指令）');
    h.tasks.stopAll();
  } finally {
    fs.rmSync(tmp1, { recursive: true, force: true });
  }
  // standard 反向锚：fork 子代稳定段原样（零 Sunx 泄漏）
  const tmp2 = mktmp('sunshinex-sunxface-forkkind-std-');
  try {
    const seen = { prompts: [] as string[], toolNames: [] as string[] };
    const h = new Harness({
      root: tmp2,
      mode: 'full-access',
      learnSkills: false,
      model: probeAdapter(
        new ScriptedAdapter([
          JSON.stringify({ tool: 'spawn', input: { prompt: 'fork 任务', label: 'w' } }),
          JSON.stringify({ done: true, reply: 'child done' }),
          JSON.stringify({ done: true, reply: 'main done' }),
        ]),
        seen,
      ),
    });
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.equal(r.done, true);
    const childPrompt = seen.prompts[1] ?? '';
    assert.ok(childPrompt.includes('fork 任务'), '第 2 轮 prompt 应为 fork 子代');
    assert.ok(childPrompt.includes('You are the SunshineX agent'), 'standard fork 子代身份行原样');
    assert.ok(!childPrompt.includes('Sunx orchestrator'), 'standard fork 子代零 Sunx 章程泄漏');
    h.tasks.stopAll();
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

test('clean 派发通道（2026-11-16 用户裁定「执行者上下文纯净」+二轮「根部不加工具和分派工具,不需要反向约束,更加纯净」）：dispatch_task 缺省 clean——子代=standard 身份面+纯简报,零主链/零章程/零编排者指令/零 dispatch 字样', async () => {
  const tmp3 = mktmp('sunshinex-sunxface-dispatch-clean-');
  try {
    const seen = { prompts: [] as string[], toolNames: [] as string[] };
    const h = new Harness({
      root: tmp3,
      mode: 'full-access',
      kind: 'sunx',
      charter: 'CHARTER-ASSEMBLED-SECRET',
      model: probeAdapter(
        new ScriptedAdapter([
          JSON.stringify({ tool: 'dispatch_task', input: { spec: 'CLEAN-BRIEF-ONLY 任务简报', label: 'cw' } }),
          JSON.stringify({ done: true, reply: 'child done' }),
          JSON.stringify({ done: true, reply: 'main done' }),
        ]),
        seen,
      ),
    });
    const r = await h.reactor.run({ goal: '主任务不应进入子代' }, { maxSteps: 5 });
    assert.equal(r.done, true, '主链正常收口');
    const childPrompt = seen.prompts[1] ?? '';
    assert.ok(childPrompt.includes('CLEAN-BRIEF-ONLY'), '第 2 轮 prompt=clean 子代（携带简报任务行）');
    assert.ok(childPrompt.includes('You are the SunshineX agent'), '子代身份=standard 面（二轮裁定：零专属 worker 身份行，与全体 standard 会话字节同面）');
    assert.ok(!childPrompt.includes('You are the Sunx orchestrator'), '零编排者身份行（矛盾从根上不产生）');
    assert.ok(!childPrompt.includes('never do the work yourself'), '零编排章程行组');
    assert.ok(!childPrompt.includes('Override:'), '零覆写尾行（覆写是 chain 同面通道补丁，clean 面不需要）');
    assert.ok(!childPrompt.includes('dispatch_task tool'), '零反向约束（工具清单自会说话，提示词不重复干工具描述的活）');
    assert.ok(!childPrompt.includes('CHARTER-ASSEMBLED-SECRET'), '零品性层（fresh ContextManager，快照只剩工作区约定族）');
    assert.ok(!childPrompt.includes('主任务不应进入子代'), 'bare 种子：主链内容零进入（执行体只见自包含简报）');
    h.tasks.stopAll();
  } finally {
    fs.rmSync(tmp3, { recursive: true, force: true });
  }
  // chain 反向锚：context:'chain' 显式回旧形——同面稳定段+覆写尾行（二轮修剪后仅结构性废黜）+主链快照在场
  const tmp4 = mktmp('sunshinex-sunxface-dispatch-chain-');
  try {
    const seen = { prompts: [] as string[], toolNames: [] as string[] };
    const h = new Harness({
      root: tmp4,
      mode: 'full-access',
      kind: 'sunx',
      model: probeAdapter(
        new ScriptedAdapter([
          JSON.stringify({ tool: 'dispatch_task', input: { spec: 'CHAIN-BRIEF 任务简报', label: 'cw', context: 'chain' } }),
          JSON.stringify({ done: true, reply: 'child done' }),
          JSON.stringify({ done: true, reply: 'main done' }),
        ]),
        seen,
      ),
    });
    const r = await h.reactor.run({ goal: '主链目标' }, { maxSteps: 5 });
    assert.equal(r.done, true);
    const childPrompt = seen.prompts[1] ?? '';
    assert.ok(childPrompt.includes('You are the Sunx orchestrator'), 'chain 通道=父同面稳定段（§17.2）');
    assert.ok(childPrompt.includes('Override: you are a WORKER'), 'chain 通道=覆写尾行（2026-11-15 补丁保留）');
    assert.ok(!childPrompt.includes('You are the SunshineX agent:'), 'chain 通道不走 standard 面（与 clean 通道互斥）');
    h.tasks.stopAll();
  } finally {
    fs.rmSync(tmp4, { recursive: true, force: true });
  }
});

test('呈现表去单例（P2 Task 1）：混合 kind 两次 assemble 各自返回各自 toolDisplay——互不覆盖', () => {
  const tmp = mktmp('sunshinex-sunxface-tooldisp-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, '.data');
  try {
    const model = new ScriptedAdapter(['{"done":true,"reply":"ok"}']);
    const rtSunx = createKernelRuntime({ root: tmp, kind: 'sunx', model });
    assert.equal(rtSunx.toolDisplay['dispatch_task']?.verb, 'DISPATCH', 'sunx 表=白名单面装配快照');
    assert.equal(rtSunx.toolDisplay['exec'], undefined, 'sunx 表零执行面');
    // standard 后装配：返回值各自持表（旧病灶=进程级单表末装配者胜——sunx 会话呈现回退大写原名）
    const rtStd = createKernelRuntime({ root: tmp, model });
    assert.equal(rtStd.toolDisplay['dispatch_task'], undefined, 'standard 表零分派件');
    assert.notEqual(rtStd.toolDisplay['exec'], undefined, 'standard 表含执行面');
    assert.equal(rtSunx.toolDisplay['dispatch_task']?.verb, 'DISPATCH', '去单例核心钉：两次 assemble 后 sunx 表仍持自身面');
    // 显式注入消费：toolCallLine 第三参按各自表出动词；进程级兜底已为末装配 standard 面（daemon 路径不再依赖全局）
    assert.equal(toolCallLine('dispatch_task', {}, rtSunx.toolDisplay), 'DISPATCH', '显式注入按 sunx 表取分派动词');
    assert.equal(toolCallLine('exec', { command: 'ls' }, rtStd.toolDisplay), 'EXEC ls', '显式注入按 standard 表取执行动词');
    assert.equal(toolCallLine('dispatch_task', {}), 'DISPATCH_TASK', '全局兜底=末装配 standard 面（大写原名 fallback），混合 kind 下不再作正确性依赖');
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

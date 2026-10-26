import type { ChatMessage, ContextItem, HistoryStep, ToolCallSpec } from '../../types';

/**
 * buildMessages 派生视图单点（原生 function calling 迁移 T3，规格 §4.1）：
 * 链为唯一事实源，消息是本函数的派生视图——任何进模型上下文的动态都经链行尾追承载，
 * 本函数只做「链序列 → 消息序列」的确定性映射，禁时变字段、禁对同一输入产生不同输出。
 *
 * 链行动作词汇（T4 接线约定）：
 * - task      → user（指令行：任务/plan 步/goal）
 * - plan      → user（计划书全文行：planFlow 批准后注入,一次；与 task 同形态）
 * - reply     → assistant（收束正文）
 * - phase     → 待挂旁白：并入下一个工具批的 assistant content（无批则在链尾降级为纯 content assistant 消息）
 * - tool-call → 工具调用行（formatToolCallLine 单行格式）；连续行聚合为一个批 → assistant+tool_calls（id 按序合成 call_N）
 * - tool-result → 观察行 → role:'tool' 按序配对（toolCallId 对应批内调用）；无批可挂时降级 user
 * - notice/note/deficit/node 及其他未登记动作 → user 元信息消息
 *
 * id 合成口径：端点只要求 role:'tool' 消息内 tool_call_id 与前序 assistant.tool_calls[].id 自洽，
 * 不要求复现端点原 id；按全链序 running 计数（call_1, call_2, …）保证「链尾追一行 → 既有 id 零位移」（前缀稳定）。
 *
 * 图片渲染期剪枝（spec §3.2）：带图链行按链序仅最近 imageHistoryLimit（缺省 3）行保图，更早行剥图并在文本加
 * `\n[image elided]` 标记——journal 全量留档不受影响（本函数是纯派生视图，剪枝只发生在消息投影上）。
 * tool-result 行图片以**批收口后**的合成 user 帧（content '(tool image)'）透出，不插在批内 role:tool 之间
 * （OpenAI 严格端点 assistant(tool_calls)↔role:tool pairing 风险）。
 */

/** 链行动作词汇（T4 写入方按此登记；本单点为唯一权威） */
export const PHASE_ACTION = 'phase';
export const TOOL_CALL_ACTION = 'tool-call';
export const TOOL_RESULT_ACTION = 'tool-result';

/** 工具调用行的单行格式：`[tool] <name> <args-json>`（args 须为紧凑 JSON——JSON.stringify 无字面换行） */
export function formatToolCallLine(name: string, argsJson: string): string {
  return `[tool] ${name} ${argsJson}`;
}

/** 解析调用行为 {name, argsJson}；不合规行回 null（调用方降级 user 元信息） */
function parseToolCallLine(observation: string): { name: string; argsJson: string } | null {
  const prefix = '[tool] ';
  if (!observation.startsWith(prefix)) return null;
  const rest = observation.slice(prefix.length);
  const sp = rest.indexOf(' ');
  if (sp <= 0) return null;
  return { name: rest.slice(0, sp), argsJson: rest.slice(sp + 1) };
}

interface BuildMessagesInput {
  /** 稳定段全文（身份/输出约定/工具选择政策/工作目录；system#1，逐字节冻结） */
  stableSegment: string;
  /** 会话冻结快照条目（SUNSHINE/技能清单/记忆索引；合并为 system#2 单条，刷新点语义在调用方） */
  snapshot: ContextItem[];
  /** 压缩块（唯一合法重写产物；每条一条 user 消息） */
  compacted: ContextItem[];
  /** 会话链（唯一事实源） */
  chain: HistoryStep[];
  /** 待置尾技能块（skillRef 消费即清语义由调用方持有） */
  pendingSkill?: string | null;
}

/** 链序列 → 消息序列（确定性纯函数；相邻调用仅尾部增长——前缀稳定回归钉子见 messages.test.ts）。
 *  imageHistoryLimit：渲染期图片历史半径——链序上仅最近 N 个带图行保图，更早行剥图加 `[image elided]`
 *  文本标记（journal 全量留档不受影响）；settings 接线在调用方面任务，本函数只做参数。 */
export function buildMessages(input: BuildMessagesInput, imageHistoryLimit = 3): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: input.stableSegment }];
  if (input.snapshot.length > 0) {
    msgs.push({ role: 'system', content: input.snapshot.map((s) => s.content).join('\n') });
  }
  for (const c of input.compacted) {
    msgs.push({ role: 'user', content: c.content });
  }

  // 渲染期图片历史剪枝（spec §3.2）——journal 全量留档不受影响：带图行按链序仅最近 N 行保图，被剪行
  // 剥图（imgsOf → undefined）并在文本加 `\n[image elided]` 标记（elided）。keepImages 按链行对象引用
  // 判定（链行对象唯一，引用即身份）；剪枝输入仅本链内容，同一输入恒同输出（确定性不引入时变）。
  const imgRows = input.chain.filter((r) => r.images !== undefined && r.images.length > 0);
  const keepImages = new Set(imgRows.slice(Math.max(0, imgRows.length - imageHistoryLimit)));
  const imgsOf = (row: HistoryStep): string[] | undefined => {
    if (row.images === undefined || row.images.length === 0) return undefined;
    return keepImages.has(row) ? row.images : undefined;
  };
  const elided = (row: HistoryStep): string =>
    row.images !== undefined && row.images.length > 0 && !keepImages.has(row) ? `${row.observation}\n[image elided]` : row.observation;
  // 带图 user 行统一透出（task/plan/元信息行与无批可挂的降级观察行同形态）：images 取剪枝后形态，
  // 文本用带标记版；空文兜底占位 `(image)` 的判定用在剥图**前**的原 observation 上
  const pushUserRow = (row: HistoryStep): void => {
    const imgs = imgsOf(row);
    if (imgs === undefined && (row.images === undefined || row.images.length === 0)) {
      msgs.push({ role: 'user', content: row.observation });
      return;
    }
    const text = row.observation.trim() !== '' ? elided(row) : '(image)';
    msgs.push(imgs !== undefined ? { role: 'user', content: text, images: imgs } : { role: 'user', content: text });
  };

  // reasoning_content 回传半径 = 当前任务轮（末 task 指令行之后的行）：交错思考端点（DeepSeek/Qwen 系）
  // 的工具续轮硬约束是**字段在场**（实测 2026-10-03：空串 200、缺字段 400 "must be passed back"——
  // 思考模式默认开但模型偶尔整轮零思考，如实省略字段即炸）；故当轮批 assistant 消息恒带 reasoning
  // （轮思考原文，零思考轮兜底空串）。旧任务轮的思考是已完成回合的中间产物——字段省略（实测端点
  // 接受历史省略），链行恒存储（append-only 事实源）。无 task 行（fork 种子等）视为全当轮
  let lastTaskIdx = -1;
  for (let i = 0; i < input.chain.length; i++) {
    if (input.chain[i].action === 'task') lastTaskIdx = i;
  }
  const inCurrentTurn = (idx: number): boolean => idx > lastTaskIdx;

  let callSeq = 0;
  let pendingPhase: string | null = null;
  let pendingReasoning: string | undefined = undefined;
  let batch: { calls: ToolCallSpec[]; consumed: number; emitted: number; current: boolean; reasoning?: string } | null = null;
  // tool-result 行图片的伴随帧缓冲：批内所有结果收齐前只缓冲不透出——user 帧不得插在批内 role:tool 之间
  let pendingFrames: Array<{ images: string[] }> = [];

  // wire 序不变量：assistant(tool_calls) 必须先于其配对的 role:tool 消息上链——
  // 批的 assistant 消息在首个结果回填前发出（挂 pendingPhase），不得延迟到批闭合
  const emitAssistant = (calls: ToolCallSpec[], reasoning: string | undefined, forceField: boolean): void => {
    msgs.push({
      role: 'assistant',
      content: pendingPhase ?? '',
      toolCalls: calls,
      ...((reasoning !== undefined && reasoning.length > 0) || forceField ? { reasoning: reasoning ?? '' } : {}),
    });
    pendingPhase = null;
    pendingReasoning = undefined;
  };

  const flushBatch = (): void => {
    if (batch === null) return;
    const rest = batch.calls.slice(batch.emitted);
    if (rest.length > 0) emitAssistant(rest, batch.reasoning ?? pendingReasoning, batch.current);
    batch = null;
    // 悬挂伴随帧兜底 flush（批未收齐即闭合/链尾收口两条路径都覆盖）：合成 user 帧恒排在全部 role:tool 之后
    for (const f of pendingFrames) msgs.push({ role: 'user', content: '(tool image)', images: f.images });
    pendingFrames = [];
  };

  for (let idx = 0; idx < input.chain.length; idx++) {
    const row = input.chain[idx];
    const action = row.action;
    if (action === TOOL_CALL_ACTION) {
      // 同批并行：上一批已有结果回填即闭合，另起新批
      if (batch !== null && batch.consumed > 0) flushBatch();
      const parsed = parseToolCallLine(row.observation);
      if (parsed === null) {
        flushBatch();
        msgs.push({ role: 'user', content: row.observation });
        continue;
      }
      callSeq += 1;
      if (batch === null) batch = { calls: [], consumed: 0, emitted: 0, current: inCurrentTurn(idx) };
      // 批首调用行承载的轮思考（reactor 无 phase 行时挂首调用行）：当轮才透出
      if (batch.calls.length === 0 && row.reasoning !== undefined && inCurrentTurn(idx)) batch.reasoning = row.reasoning;
      batch.calls.push({ id: `call_${callSeq}`, name: parsed.name, argsJson: parsed.argsJson });
      continue;
    }
    if (action === TOOL_RESULT_ACTION) {
      if (batch !== null && batch.consumed < batch.calls.length) {
        if (batch.consumed >= batch.emitted) {
          emitAssistant(batch.calls.slice(batch.emitted), batch.reasoning ?? pendingReasoning, batch.current);
          batch.emitted = batch.calls.length;
        }
        const id = batch.calls[batch.consumed].id;
        batch.consumed += 1;
        // 观察行文本恒在（剥图行加 [image elided] 标记）；图片缓冲为伴随帧，批收口后统一 flush——
        // user 帧不得插在批内 role:tool 之间（OpenAI 严格端点 pairing）
        msgs.push({ role: 'tool', content: elided(row), toolCallId: id });
        const imgs = imgsOf(row);
        if (imgs !== undefined) pendingFrames.push({ images: imgs });
        // 批内所有结果收齐：flushBatch 统一透出伴随帧（此时 rest 恒空——assistant 已在首个结果前整批发出）
        if (batch.consumed >= batch.calls.length) flushBatch();
        continue;
      }
      flushBatch();
      // 无批可挂降级 user：与元信息行同形态（images 取剪枝后形态，文本用带标记版）
      pushUserRow(row);
      continue;
    }
    if (action === PHASE_ACTION) {
      flushBatch();
      pendingPhase = row.observation;
      if (row.reasoning !== undefined && inCurrentTurn(idx)) pendingReasoning = row.reasoning;
      continue;
    }
    // task/plan/reply/notice/note/deficit/node/memory/role/skill（ChainAction 闭集内全部剩余词汇）：批先闭合，reply→assistant，其余（含指令/计划书行与元信息行）→user
    flushBatch();
    if (action === 'reply') {
      msgs.push({ role: 'assistant', content: row.observation });
    } else {
      // 'plan' 与 'task' 并列本分支（spec §4.4）：计划书全文行按指令行同形态（user）透出；
      // 行载 images（用户随行附件）即带 image_url 内容块的多模态 user 消息（文本恒在——空文行兜底占位；
      // 剪枝后形态与 [image elided] 标记统一在 pushUserRow 收口）
      pushUserRow(row);
    }
  }
  flushBatch();
  // 链尾仍挂着的旁白（phase 后无任何批）：纯 content assistant 消息承载（无 tool_calls 即无 reasoning 回传义务）
  if (pendingPhase !== null) {
    msgs.push({ role: 'assistant', content: pendingPhase });
    pendingPhase = null;
    pendingReasoning = undefined;
  }
  if (input.pendingSkill != null && input.pendingSkill !== '') {
    msgs.push({ role: 'user', content: `[skill] ${input.pendingSkill}` });
  }
  return msgs;
}

import type { SessionEvent } from '../../src/types';
import { applySeed, applySubagentEvent, initialKernelState, isQuietNotice, type KernelEntry, type KernelState } from '../../src/session/entry';

/**
 * G3 chat 投影 → P4 内核视图层(session-kernel spec §6 P4):事件→转录的投影逻辑全数退役,
 * 本模块改为「同一内核 reducer(applyEvent 全仓唯一实现)+ 纯视图映射」——GUI 本地内嵌内核态,
 * 喂 WS 原始帧(零 wire 改动);快照装载=内核 seed(snapshot.messages 已是内核条目,P2)。
 *
 * 内核承载:token 流式段聚合、reasoning 思考段计秒、tool call/result 双向配对(乱序 FIFO)、
 * done 终稿合并、run 条与 runmeta 对位、子智能体零条目——formerly chat-reducer 自建三件套。
 * 视图层保留:status-bar 计数器(tokens/steps/cache 轮水位,会话统计非转录)、run 起点基线
 * (G14.63「本轮」口径减数)、notice 显示过滤(G14.90/G14.106——内核忠实归档,渲染面裁定)、
 * partial-seed 流式派生(G14.51 快照竞态收口)。
 *
 * 裁定记录:
 * - delegation-started/ended 不再产条目(G14.213 状态提示不显示,内核语义;委派可见性归委派徽标/Agents 页)。
 * - entry key 统一 `k<seq>`;callId 直挂条目(`tool:${callId}` key 编码解码退役)。
 * - 物化映射以 WeakMap 保持未变条目的引用身份(token 逐 delta 重映射不触发全列重渲)。
 */

/** 对话流条目（md 原文；kind 样式钩子在渲染面，streaming=true 流式光标态；ts 日期分隔投影源）。
 *  P4 起=内核条目的视图形（映射自 KernelEntry,字段语义不变） */
export interface ChatEntry {
  key: string;
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error' | 'thinking' | 'run';
  md: string;
  /** 随行图片附件(dataURL):user=气泡附件条;tool=工具结果图片(2026-10-26 插件体系图片通道,
   *  tool-result 事件 payload.images 原位落条——ToolEntry 缩略行数据源) */
  images?: string[];
  streaming?: boolean;
  /** thinking 专用：段耗时秒（内核封段计首尾 ts 差） */
  seconds?: number;
  /** 条目时间（epoch ms;内核条目 ts 直映） */
  ts?: number;
  /** P4:tool 条 callId 直挂（fetchDiff 寻址;旧 key 编码退役） */
  callId?: string;
  /** P11 三态直映（内核条目同语义）:pending/running 在场;undefined=done 终态（内核收段删字段） */
  status?: 'pending' | 'running' | 'done';
  /** tool 条内核字段直映(P4.1 渲染对齐):name/input/result 随快照全量在场——折叠行目标/展开体
   *  全文直读条目字段(P11 T7 旁路暂存退役后为唯一通道),不退 md 首行 */
  name?: string;
  input?: Record<string, unknown>;
  result?: { text: string; ok: boolean; full?: string };
  /** G14.63 run 专用:轮起点基线(会话累计 steps/tokens)——运行状态行「本轮」口径的减数 */
  stepsBase?: number;
  tokensBase?: number;
  /** run 专用（G11 状态行）：封段统计——meta 映射(steps=runSteps 优先,「本轮」口径) */
  steps?: number;
  tokens?: number;
  /** run 专用：收段时刻 */
  endedTs?: number;
  /** G14.209 run 专用:停止态(中断/失败收口——运行条显「已停止」不显时长) */
  stopped?: boolean;
  /** G14.100 run 专用:本轮 git 变动增量(轮尾汇总条;撤销面按 path 寻址) */
  changes?: Array<{ path: string; status: string; added: number | null; deleted: number | null; newLines?: number }>;
}

/** chat 投影状态：内核态 + 物化视图条目 + 状态栏三指标 */
export interface ChatState {
  /** 内核态(P4):事件→转录投影唯一实现(src/session/entry) */
  k: KernelState;
  entries: ChatEntry[];
  status: 'idle' | 'running';
  /** 会话累计 tokens（usage 事件续推；seed 自 run meta 求和） */
  tokens: number;
  steps: number;
  /** 会话累计 prompt 缓存命中 tokens（usage.cacheHitTotal 续推） */
  cacheTokens: number;
/** 内部记账（勿消费）：run-open 基线（seq → 当时累计 steps/tokens）——open run 条「本轮」减数。
 *  P9:usage 水位记账已上收内核统计面(ChatState 不再持) */
  runBases: Record<number, { steps: number; tokens: number }>;
  /** 成员变更计数(派生冻结 memo key,见 P1 spec §3.3):成员集变化(增/删/重播)或尾条目 result
   *  配对(tool-result 原位写入,长度/首键不变但 result 引用 undefined→对象跃迁)时 +1;
   *  纯内容帧(token/thinking delta、状态翻转)恒定;0=未播种(initialChatState),1=新种子 */
  structureVersion: number;
  /** 种子代次(reseed 恒换新值):与 structureVersion 并用作派生 memo 依赖,防 sv 等值碰撞
   *  漏检重置——seed 恒置 1,旧态 sv=1 时 reseed 后原始类型依赖按不等比较不触发重算 */
  seedGen: number;
  /** 2026-10-26 三期历史链:尾窗播种元数据——hasMore=true 时后台加载链逐页 prepend 补老;
   *  complete=头部已到;failed=连续重试败(指示器可点重试)。undefined=旧 daemon(无分页) */
  history?: { total: number; oldestSeq: number; hasMore: boolean; complete: boolean; failed?: boolean };
}

export function initialChatState(): ChatState {
  return { k: initialKernelState(), entries: [], status: 'idle', tokens: 0, steps: 0, cacheTokens: 0, runBases: {}, structureVersion: 0, seedGen: 0 };
}

/** snapshot.messages 载荷形态（gui 侧契约声明;P2 起即内核条目形,meta 对位 RunMeta） */
export interface SnapshotTranscriptEntry {
  seq: number;
  ts?: number;
  kind: ChatEntry['kind'];
  md: string;
  callId?: string;
  /** P11 三态直映（快照=内核条目直序列化,字段同源） */
  status?: 'pending' | 'running' | 'done';
  name?: string;
  input?: Record<string, unknown>;
  /** tool 条配对结果(内核条目直序列化;文本全量——展开体与折叠 stat 数据源) */
  result?: { text: string; ok: boolean; full?: string };
  seconds?: number;
  meta?: {
    seconds?: number;
    steps?: number;
    runSteps?: number;
    tokens?: number;
    cacheTokens?: number;
    endedTs?: number;
    stopped?: boolean;
    changes?: Array<{ path: string; status: string; added: number | null; deleted: number | null; newLines?: number }>;
  };
}

/** 视图映射缓存:内核条目不可变,派生标(流式/基线)不变即复用视图对象——token 逐 delta 重映射
 *  只换变动的末段条目,未变行引用身份保持(渲染面 memo 不破) */
const viewCache = new WeakMap<KernelEntry, { sig: string; view: ChatEntry }>();

/** 映射级缓存(2026-10-26 性能轮,长会话流式主热收口):并行数组逐位复用——此前每帧对全量
 *  内核条目跑 sig 串构造+WeakMap 探测+密集数组分配(2k 条会话 ≈ 每帧 80KB 垃圾,33 批/秒
 *  即 2.6MB/s GC 压力=卡顿源)。三级:①同内核态(纯统计帧)零重算直返;②引用逐位对比
 *  (指针比较,零分配)未变位直取上次产物,仅变更位走单条映射;③结构变化(增删/播种)全量。
 *  notice 过滤以 null 占位保持 kernel↔mapped 对位。键=KernelState(每会话独立态) */
const mapCache = new WeakMap<KernelState, {
  runBases: Record<number, { steps: number; tokens: number }>;
  kernel: readonly KernelEntry[];
  parallel: Array<ChatEntry | null>;
  mapped: ChatEntry[];
}>();

/** 种子代次计数:每次 seedChatFromSnapshot 递增,随 ChatState.seedGen 下发——派生 memo 与
 *  structureVersion 并用作依赖,防 reseed 时 sv 等值(旧 1→新 1)漏检整列条目替换 */
let seedGenCounter = 0;

/** G14.90/G14.106 显示过滤:P10 起裁定单点在内核(isQuietNotice),TUI/GUI 同源——本模块只消费 */
/** 内核态 → 视图条目(纯映射):key=`k<seq>`;streaming=openSeg/openRun 派生(§3.1b 派生态);
 *  run meta→view 字段(steps=runSteps 优先「本轮」口径)+open run 注入基线;delegation 已被内核滤除 */
function mapOne(e: KernelEntry, open: boolean, base: { steps: number; tokens: number } | undefined): ChatEntry {
  {
    const sig = `${open ? 'o' : '-'}|${e.kind === 'run' && base !== undefined ? 'b' : '-'}`;
    const hit = viewCache.get(e);
    if (hit !== undefined && hit.sig === sig) {
      return hit.view;
    }
    // P11 渲染中立条目:user md 内核写面恒裸文(v3),直透零归一(剥 `> ` 前缀分支退役——
    // 与 TUI restore 同向);error 补 `Error: ` 前缀(前缀归渲染面——与 TUI live/restore 同形)
    const md = e.kind === 'error' ? `Error: ${e.md}` : e.md;
    const view: ChatEntry = {
      key: `k${e.seq}`,
      kind: e.kind,
      md,
      ...(e.ts !== undefined && e.ts > 0 ? { ts: e.ts } : {}),
      streaming: open ? true : undefined, // 键恒在场(消费面 toMatchObject/条件渲染两相宜)
      ...(e.seconds !== undefined ? { seconds: e.seconds } : {}),
      ...(e.images !== undefined && e.images.length > 0 ? { images: e.images } : {}),
      ...(e.callId !== undefined ? { callId: e.callId } : {}),
      ...(e.name !== undefined ? { name: e.name } : {}),
      ...(e.input !== undefined ? { input: e.input } : {}),
      ...(e.result !== undefined ? { result: e.result } : {}),
      ...(e.status !== undefined ? { status: e.status } : {}),
    };
    if (e.kind === 'run') {
      const m = e.meta;
      if (m !== undefined) {
        view.steps = m.runSteps ?? m.steps; // G14.56:「本轮」口径优先,旧档回退累计
        if (m.tokens !== undefined) view.tokens = m.tokens;
        if (m.seconds !== undefined) view.seconds = m.seconds;
        if (m.stopped === true) view.stopped = true;
        if (m.endedTs !== undefined && m.endedTs > 0) view.endedTs = m.endedTs;
        if (m.changes !== undefined && m.changes.length > 0) view.changes = m.changes;
      }
      if (base !== undefined) {
        view.stepsBase = base.steps;
        view.tokensBase = base.tokens;
      }
    }
    viewCache.set(e, { sig, view });
    return view;
  }
}

function mapEntries(k: KernelState, runBases: Record<number, { steps: number; tokens: number }>): ChatEntry[] {
  const hit = mapCache.get(k);
  if (hit !== undefined && hit.runBases === runBases) return hit.mapped; // ①纯统计帧:零重算
  const prev = hit;
  const out: ChatEntry[] = [];
  const parallel: Array<ChatEntry | null> = new Array(k.entries.length).fill(null);
  for (let i = 0; i < k.entries.length; i += 1) {
    const e = k.entries[i]!;
    if (e.kind === 'notice' && isQuietNotice(e.md)) continue;
    // ②部分变更帧:未变位(内核条目引用相等⇒派生标相等——不可变条目)直取上次产物
    if (prev !== undefined && prev.kernel[i] === e) {
      const reuse = prev.parallel[i];
      if (reuse !== null) {
        parallel[i] = reuse;
        out.push(reuse);
        continue;
      }
    }
    // ③变更位/全量(增删/播种):单条映射
    const open = e.kind === 'run' ? k.openRun === e.seq : k.openSeg === e.seq;
    const base = runBases[e.seq];
    const view = mapOne(e, open, base);
    parallel[i] = view;
    out.push(view);
  }
  mapCache.set(k, { runBases, kernel: k.entries, parallel, mapped: out });
  return out;
}

/** 用户提交的本地回显条（合成 user 事件入核——HTTP 提交路径 daemon 不产 user 帧,G14.89 同口径;
 *  resync 后由快照条取代） */
export function appendUserMessage(s: ChatState, text: string, ts?: number, images?: string[]): ChatState {
  const imgs = images !== undefined && images.length > 0 ? { images } : {};
  return applyChatEvent(s, { type: 'user', text, ts: ts ?? Date.now(), ...imgs });
}

/** onResync 基线：snapshot.messages（内核条目）直 seed——转录投影零推导;计数器自 run meta 求和
 *  （G14.18:回放会话累计不从零起）。流式游标(P4 归位):快照携带内核 openRun/openSeg 直用——
 *  客户端从条目反推的派生块退役(推断只能近似「末 run+尾随部分段」,内核游标是精确权威);
 *  流式态由内核派生(非事后贴标),后续 token 并入部分段、done 合入同条不裂 */
export function seedChatFromSnapshot(
  messages: readonly SnapshotTranscriptEntry[],
  cursors: { openRun: number; openSeg: number },
): ChatState {
  // P10:status 读内核游标(openRun>=0 即 running)——快照 status 参数退役
  const status: ChatState['status'] = cursors.openRun >= 0 ? 'running' : 'idle';
  // cast 依据:快照转录档即内核条目的盘面直录(v3 seg 行=kernelEventRows 单点映射),形状契约由装载侧背书
  const s: ChatState = { k: applySeed(initialKernelState(), messages as unknown as ReadonlyArray<KernelEntry & { seq?: number }>), entries: [], status, tokens: 0, steps: 0, cacheTokens: 0, runBases: {}, structureVersion: 1, seedGen: ++seedGenCounter };
  s.k = { ...s.k, openRun: cursors.openRun, openSeg: cursors.openSeg };
  // P9:计数器自 run meta 在 applySeed 内重建(零推导)——G14.18 回放会话累计不从零起
  const seeded: ChatState = { ...s, tokens: s.k.stats.sessionTotalTokens, steps: s.k.stats.sessionSteps, cacheTokens: s.k.stats.sessionCacheTokens };
  return { ...seeded, entries: mapEntries(seeded.k, seeded.runBases) };
}

/** 2026-10-26 三期历史链:头部插入更早条目(后台补全页)——seq 游标闭合(页内 seq 均小于现存
 *  最旧),流式尾部(openRun/openSeg 引用尾部 seq)无扰;空页仅更新 history 元数据(引用相等,
 *  加载链以 history 变更驱动)。头部插入走 mapCache 全量重映射路径(页级频率可接受) */
export function prependSeed(
  s: ChatState,
  entries: ReadonlyArray<SnapshotTranscriptEntry>,
  meta: { oldestSeq: number; hasMore: boolean },
): ChatState {
  const history = { total: Math.max(s.history?.total ?? 0, meta.oldestSeq + s.entries.length), oldestSeq: meta.oldestSeq, hasMore: meta.hasMore, complete: !meta.hasMore, failed: false };
  if (entries.length === 0) {
    // 空页:元数据同值即原样返回(引用相等——加载链完成态重复收口不再触发渲染)
    const cur = s.history;
    if (cur !== undefined && cur.oldestSeq === history.oldestSeq && cur.hasMore === history.hasMore && cur.complete === history.complete && cur.failed === history.failed) return s;
    return { ...s, history };
  }
  // 直构头部插入(不用 applySeed——它尾部追加且会重算统计,prepend 两者都不该):
  // 页内 seq 由加载链 before 游标闭合(恒小于现存最旧);old run 条不带基线,mapOne 按 undefined 走缺省
  const seeded: KernelEntry[] = entries.map((e) => ({ ...(e as unknown as KernelEntry) })).sort((a, b) => a.seq - b.seq);
  const merged = [...seeded, ...s.k.entries].slice(-2000); // 对齐内核 CAP 2000 环形口径
  const k: KernelState = { ...s.k, entries: merged };
  const mapped = mapEntries(k, s.runBases);
  return { ...s, k, entries: mapped, history, structureVersion: s.structureVersion + 1 }; // 头部插入=结构变更
}

/** 事件面单点：内核归约(转录投影)+ 计数器归约会话统计 → 物化视图重映射。
 *  status: model-start 置 running(水位重置仅在 run 边界——model-start 每模型轮一次,run 内续轮
 *  不重置,否则多轮 run tokens 虚增)、done 回 idle;error 不动(G14.51:done 必发,收口让位) */
export function applyChatEvent(s: ChatState, e: SessionEvent): ChatState {
  if (typeof e.payload?.subagent === 'string') return s; // 子智能体事件另轨(Agents 标签,G8d):主流零条目零计数
  if (e.type === 'queue') return s; // P5 队列面事件(UseSessionEvents 截收 setQueued):不入转录投影(防御——default 分支会把当边界误闭合开启段)
  return applySubagentChatEvent(s, e);
}

/** 工具结果图片附带(2026-10-26 插件体系图片通道 GUI 面):daemon tool-result 事件 payload.images
 *  (dataURL 数组,仅非空携带)内核不承载——内核投影全仓同源(TUI/journal/快照回放不随动,工具图
 *  回放属后续范围),落条属 GUI 显示面语义,故在内核归约后认领其本次落位的 tool 条目原位补图。
 *  认领=引用差分:tool-result 一帧恰换/增一个 tool kind 条目(封段只动 thinking/assistant/run;
 *  配对/迟到回填/FIFO/占位追加全在内核单点,此处零重复配对)——替换位唯一/追加位在尾。
 *  pending 槽幂等回填语义下 images 只随最终 result 帧来,原位补图即终态,无二次到达面 */
function withToolResultImages(k: KernelState, prev: KernelState, e: SessionEvent): KernelState {
  if (e.type !== 'tool-result') return k;
  const raw = e.payload?.images;
  if (!Array.isArray(raw) || raw.length === 0) return k;
  const images = raw.filter((x): x is string => typeof x === 'string');
  if (images.length === 0) return k;
  const n = Math.min(prev.entries.length, k.entries.length);
  for (let i = 0; i < n; i += 1) {
    if (prev.entries[i] !== k.entries[i] && k.entries[i]!.kind === 'tool') {
      const entries = k.entries.slice();
      entries[i] = { ...entries[i]!, images };
      return { ...k, entries };
    }
  }
  // result 先行/孤儿:内核尾追加占位/独立条——补图落在尾条
  const last = k.entries[k.entries.length - 1];
  if (k.entries.length > prev.entries.length && last !== undefined && last.kind === 'tool') {
    return { ...k, entries: [...k.entries.slice(0, -1), { ...last, images }] };
  }
  return k;
}

/** G14.2xx 子智能体流同源归约(无 subagent 排除门/无 queue 截收):与主流 applyChatEvent 走
 *  同一内核投影 applyEvent——子智能体转录(agents 页签)由此获得与主对话逐字段同构的条目
 *  (tool 行 name/input/result 全量),替代旧有损文本滑窗反解析(空名帧退化「…」行病根) */
export function applySubagentChatEvent(s: ChatState, e: SessionEvent): ChatState {
  const k = withToolResultImages(applySubagentEvent(s.k, e), s.k, e); // 剥 subagent 标签走同一内核归约(子智能体转录与主对话同构)+工具结果图片原位落条
  // P9 统计面:计数器唯一权威在内核 stats,此处直投影零记账;P10 status 亦读内核
  // (openRun>=0 即 running——视图层 model-start/done 推导退役)
  let next: ChatState = { ...s, k, status: k.openRun >= 0 ? 'running' : 'idle', tokens: k.stats.sessionTotalTokens, steps: k.stats.sessionSteps, cacheTokens: k.stats.sessionCacheTokens };
  if (e.type === 'model-start' && s.status === 'idle' && k.openRun >= 0) {
    // run-open 基线记账(G14.63「本轮」减数;openRun 即本轮新开 run 条)——基线取事件前累计
    next = { ...next, runBases: { ...s.runBases, [k.openRun]: { steps: s.steps, tokens: s.tokens } } };
  }
  // 零变化透传(内核态与计数器均未动——route/ctx 等空边界事件免重渲染)
  if (
    next.k === s.k &&
    next.status === s.status &&
    next.steps === s.steps &&
    next.tokens === s.tokens &&
    next.cacheTokens === s.cacheTokens &&
    next.runBases === s.runBases
  ) {
    return s;
  }
  // P1 structureVersion:成员变更 O(1) 差分——内核 append-only,长度/首键不变即成员集不变;
  // 第三条件:尾条目 result 引用跃迁(tool-result 原位配对——内核换条目对象、视图重映射后
  // result undefined→对象,长度与首键均不变,create_task 等标题自 result.text 读出,漏检即
  // taskNameOf 冻结陈旧到下一成员帧)。token replaceAt 只换 md,result 恒 undefined===undefined,
  // 冻结面不受影响(seed 整替不经此路,自身置 1);空→空不算变更。纯内容帧计数恒定,派生冻结 memo key(spec §3.3)
  const entries = mapEntries(next.k, next.runBases);
  const nextLast = entries[entries.length - 1];
  const prevLast = next.entries[next.entries.length - 1];
  const structureVersion = next.structureVersion
    + (entries.length !== next.entries.length
      || entries[0]?.key !== next.entries[0]?.key
      || nextLast?.result !== prevLast?.result
      ? 1
      : 0);
  return { ...next, entries, structureVersion };
}

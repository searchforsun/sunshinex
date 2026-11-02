import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ok, fail } from '../result';
import type { Result } from '../result';
import { SessionRuntime } from './session';
import type { DaemonFrame } from './daemon-wire';
import { ModelAdapter } from '../model/adapter';
import { ModelSwitcher } from '../model/catalog';
import { SessionJournal, parseJournalFile, purgeSession, readSessionMeta, reduceJournal, sessionsDir } from '../tui/session-journal';
import { reduceSteerRows, reduceSegRows, crashWindowEntries, entriesToChainSteps } from '../session/seglog';
import { projectsRoot, projectSlug, resolveDataDir } from '../config/data-dir';

/**
 * 会话生命周期域(2026-10-27 技术债轮 自 daemon.ts 外提,D31 骨架域续批,行为零变化):
 * 会话新建(create)/attach 恢复双入口 + 会话 id 铸造与 default 工作区锚定两助手。
 * daemon 类状态触点收敛为 io 六面(sessions 注册表/model/seq 泵/挂起票据铸造/广播面/激活位),
 * 装配注释与裁定随码平移。
 */

/** daemon 类状态触点面:注册表直引用(Map 本体——createSessionIn 写入/attachIn 遍历收编),
 *  其余八面为回调注入(与 SessionRuntime 装配面同形透传)。watchProject/unwatchProject 两面
 *  (任务14):daemon 持 ConfigWatcher——会话打开挂项目监听、会话关闭(与收编弃壳)拆监听 */
export interface SessionLifecycleIo {
  readonly sessions: Map<string, SessionRuntime>;
  readonly model: ModelAdapter;
  readonly nextSeq: () => number;
  readonly mintPid: () => string;
  readonly broadcast: (frame: DaemonFrame) => void;
  readonly setActive: (id: string) => void;
  /** 会话打开挂项目配置监听（daemon 侧守护：.sunshinex 缺失降级跳过，不产告警） */
  readonly watchProject: (root: string) => void;
  /** 拆项目配置监听（daemon 侧守护：同 root 仍被其他会话持有时不拆） */
  readonly unwatchProject: (root: string) => void;
}

/** G14.10 B 方案:default 工作区锚定专用临时目录——root 字面 'default'(GUI 欢迎页非项目
 *  会话的缺省锚点)解析为 <tmp>/sunshinex-default(缺场 mkdir recursive):临时任务的文件
 *  落在系统临时目录,不再污染仓库/项目目录。非字面 root(显式项目路径)不经过此处。 */
export function defaultScratchRoot(): string {
  const dir = path.join(os.tmpdir(), 'sunshinex-default');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 会话 id(2026-10-23 用户裁定):sun-{项目摘要12}-{随机8hex}——项目段确定性(会话 id 即可见
 *  项目归属),随机段 4 字节 hex 单进程防撞,撞库重掷(注册表查重)。形态为 validSessionId
 *  ([A-Za-z0-9_-])子集;退役 s<n> 单调草档(重启即重号、跨项目不可归因) */
export function mintSessionId(sessions: Map<string, SessionRuntime>, root: string): string {
  const project = projectSlug(root).slice(-12);
  for (;;) {
    const id = `sun-${project}-${crypto.randomBytes(4).toString('hex')}`;
    if (!sessions.has(id)) return id;
  }
}

/**
 * 创建会话(spec §7):root 存在性/目录校验(INVALID_ARG)→ 按 root 装配 SessionRuntime(同 root
 * 多会话允许——各自独立主链,Ruling 2)→ 入注册表 → 置激活。同时向
 * `resolveDataDir(root)/workspace.json` 落档 `{root}`(T2 工作区注册表:slug 单向哈希反解不了
 * root——落档供 GET /workspaces 读回真 root;历史工作区无此档降级 slug-only)。落档尽力而为:
 * 数据面不可写(只读 projects 根)不挡会话创建,/workspaces 对该工作区降级 slug-only 行。Result
 * 面:daemon 级 API(serve --root 预选/后续工作区注册表消费),HTTP 面映射 400/200。
 * G4:opts.mode='acceptEdits' 时向会话注入审批/问询两闭包——resolve 挂在 daemon 挂起表条目上 + 广播
 *  挂起帧(WS 消费面回执 POST /approval/:pid / /ask/:pid/reply);缺省 full-access 零行为变化(沿原 dontAsk 地位正名,spec §3.2)。
 * T2:出生即挂新 SessionJournal(`new SessionJournal(dataDir)` 惰性建档——首 run 首条 chain append
 *  才落盘建新档,档 id 同源 newSessionId();空会话零文件,TUI 惰性先例同构)——首 run 起链持久,
 *  后续 /sessions 列档与 attach 重开(chain 派生转录)可消费。
 */
export function createSessionIn(io: SessionLifecycleIo, root: string, opts?: { mode?: 'full-access' | 'acceptEdits' }): Result<{ sessionId: string }> {
  const abs = root === 'default' ? defaultScratchRoot() : path.resolve(root);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return fail('INVALID_ARG', `root does not exist: ${abs}`);
  }
  if (!st.isDirectory()) return fail('INVALID_ARG', `root is not a directory: ${abs}`);
  const dataDir = resolveDataDir(abs);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify({ root: abs }) + '\n', 'utf8');
  } catch {
    // 落档尽力:写失败只让 /workspaces 降级 slug-only,不影响会话装配
  }
  // 会话 id(2026-10-23 用户裁定):sun-{项目摘要12}-{随机8}——退役 s<n> 单调草档(重启即重号、
  // 跨项目不可归因);项目段=工作区 slug 摘要尾(确定性,会话 id 即可见归属),随机段单进程防撞
  const id = mintSessionId(io.sessions, abs);
  // P6 §4 挂起表下沉会话:daemon 只注入网络寻址两接缝(mintPid/broadcast)——注册/守卫(ghost 硬化
  // isAborted/manual 档位判定)/组帧/回执全部在 SessionRuntime 挂起面(suspendApproval/suspendAsk)
  const session = new SessionRuntime({
    id,
    root: abs,
    model: io.model,
    ...(io.model instanceof ModelSwitcher ? { modelSwitcher: io.model } : {}),
    nextSeq: io.nextSeq,
    broadcast: io.broadcast,
    ...(opts?.mode !== undefined ? { mode: opts.mode } : {}),
    mintPid: io.mintPid,
  });
  io.sessions.set(id, session);
  io.setActive(id);
  // T2 出生 journal:挂载即接 onContextChange 续写链
  session.attachJournal(new SessionJournal(dataDir));
  // 出生写收口(2026-10-31 用户实测「幽灵会话」根因修):出生档改在**首次实质事件落档时**铸造
  // (hookJournalSink append 分支 start 后即补 ctx-snap 出生行)——占座壳(目录视图锚定等从未
  // 跑过事件的 newSession)不再产生可见档,侧栏无幽灵;真会话首条事件即 header→ctx-snap→chain,
  // 快照冻结起点不变量保持(重开精确)
  // 任务14 双向同步:会话打开即挂项目配置监听(.sunshinex 缺失由 daemon 侧守护降级跳过——
  // 缺失目录不产告警;目录补建后下次会话打开重试即真实生效,watchXxx 幂等)
  io.watchProject(abs);
  return ok({ sessionId: id });
}

/**
 * attach 恢复(spec §4b 装载序 + 渲染中立 spec v3):会话 root 的 dataDir 下定位 `<journalId>.jsonl`(未知 id
 * INVALID_ARG)→ parseJournalFile → 版本守卫(v3 段级词汇;v1/v2 旧档拒载,dev 用 purge 脚本清理)→
 * 装载双读面:reduceJournal(chain/compact → restoreSession 上下文;model/todos/view 参数面不动) +
 * reduceSegRows(seg/seg-update/run-open/runmeta/truncate → kernel.seed 转录投影,seq 原样沿用)→
 * SessionJournal attach 续挂 + SessionRuntime.attachJournal 挂订阅(后续 run 的 chain 行与段级行
 * 续落同档,teardown seal)→ 置激活。双挂/运行中挂 INVALID_STATE(播种会击穿在飞 run 的链)。
 */
export function attachSessionIn(io: SessionLifecycleIo, id: string, journalId: string): Result<{ sessionId: string }> {
  // G14.2xx 运行中刷新恢复:同 journal 已在座且**运行中**(内核循环与在飞 run 都在旧对象身上)→
  // **收编复用**并丢弃 newSession 造的空壳——空壳挂同档=会话 id 换号,直播帧按会话过滤全丢,
  // GUI 种子态冻结成假「已停止」而侧栏仍在跑(实测病根)。idle 在座不收编:走经典重播种
  // (确定性等价,排队经 steer 行回放;双挂 409 面由下方既有守卫承继)
  for (const [sid, s] of io.sessions) {
    if (s.attachedJournalId === journalId && s.status() === 'running') {
      // 任务14:被收编丢弃的空壳会话出生时挂的项目监听随壳拆除(unwatchProject 守护——同 root
      // 仍被在座会话持有则不拆);壳 root 与被收编会话 root 可不同,不拆则监听句柄泄漏到 daemon 收口
      const shell = io.sessions.get(id);
      if (sid !== id) {
        io.sessions.delete(id);
        if (shell !== undefined) {
          io.unwatchProject(shell.root);
          // 空壳出生档随壳清扫(2026-10-31 用户报障「每次点击运行中会话都产生一个新对话」):
          // 内存收编了,盘面 birth-only 档还在——/sessions 列表每次点击多一行「新会话」孤儿。
          // 仅零实质行档可删(birthOnlyFile 守卫从严,真档绝不触碰)
          const shellJid = shell.attachedJournalId;
          if (shellJid !== undefined && birthOnlyFile(sessionsDir(resolveDataDir(shell.root)), `${shellJid}.jsonl`)) {
            try {
              fs.rmSync(path.join(sessionsDir(resolveDataDir(shell.root)), `${shellJid}.jsonl`), { force: true });
            } catch {
              /* 单文件收口失败不阻塞收编(下次启动清扫兜底) */
            }
          }
        }
      }
      io.setActive(sid);
      return ok({ sessionId: sid });
    }
  }
  const session = io.sessions.get(id);
  if (session === undefined) return fail('INVALID_ARG', `unknown session: ${id}`);
  // 双挂守卫（出生写语义适配,2026-10-31 spec §2）：出生写后每个新会话出生即铸 birth-only 档
  // （仅 header+ctx-snap 行,零实质内容）——此类档不构成「已挂载」,放行换挂真档（否则 GUI 重开
  // 的 newSession+attach 流程被出生写全数 409）;已落实质行的档守卫照旧（防档双写）
  const prevJournalId = session.attachedJournalId;
  if (prevJournalId !== undefined && !birthOnlyJournal(session.root, prevJournalId)) {
    return fail('INVALID_STATE', 'session already has an attached journal');
  }
  if (session.status() === 'running') return fail('INVALID_STATE', 'cannot attach while a run is in progress');
  const dataDir = resolveDataDir(session.root);
  const file = path.join(sessionsDir(dataDir), `${journalId}.jsonl`);
  if (!fs.existsSync(file)) return fail('INVALID_ARG', `unknown journalId: ${journalId}`);
  const replayEvents = parseJournalFile(file).events;
  const replay = reduceJournal(replayEvents);
  if (replay.version !== 3) return fail('INVALID_ARG', `unsupported journal version: ${String(replay.version)} (v3 required — legacy sessions: node scripts/purge-legacy-sessions.mjs --delete)`);
  session.runtime.harness.context.restoreSession({ chain: replay.chain, chainFrom: replay.chainFrom, compacted: replay.compacted });
  // 转录装载:seg 面重放入核(no-compat——v1 的 msg 行/链派生播种已随 collector 退役)
  session.kernelSeed(reduceSegRows(replayEvents));
  session.seedTodoBatches(replayEvents); // todo 批次权威投影(2026-10-31 用户裁定):journal 全量行派生,内核环窗之外的老批次由此可见
  // 等待队列装载(P5 spec §12):末条 steer 行整列回种(无行=空队列)
  session.steerSeed(reduceSteerRows(replayEvents));
  // 影子投影装载(G14.2xx 断线重连):board/delegation 事件行回种——重启后快照/补发不再空板空委派
  session.seedShadow(replayEvents);
  // 会话选择面回放(G14.2xx 公共持久化归位):model/effort/mode 运行中切换即落 meta 旁车,
  // attach 按档归位——重启/重开不再回落装配缺省(CLAUDE.md §13 持久化分层口径)
  const selMeta = readSessionMeta(dataDir, journalId);
  if (selMeta.effort !== undefined) session.setEffort(selMeta.effort);
  if (selMeta.model !== undefined) session.setModel(selMeta.model);
  if (selMeta.mode !== undefined) {
    // 权限档回放只认现值三档(2026-10-24 用户裁定「不要有兼容逻辑,旧会话记录可以删」:旧值
    // manual/dontAsk 一律回落缺省档+warn,沿 MANUAL-GUI「不保旧档」开发期先例);'plan' 是流程
    // 标记非档,照写不照回——arm 不跨重启(spec §5.2),静默落缺省档。
    // setMode 异步化后(终审修复:disarm 收口)此处 fire-and-forget 仍同步生效——attach 只落在从未
    // 附档的新会话(idle+plan 流程必不在途,复附有上 guard 拦),setMode 无 await 点直落换新,随后的
    // attachJournal 挂的就是换新后的运行时;带流程在途的 setMode 只经 mode 端点(async)行走
    const mode = selMeta.mode;
    if (mode === 'read-only' || mode === 'acceptEdits' || mode === 'full-access') void session.setMode(mode);
    else if (mode !== 'plan') console.warn(`[serve] session mode in meta not restorable: ${String(mode)} — falling back to default`);
  }
  // 快照回种（2026-10-31 spec §4）：落档快照直注入替代磁盘重读——前缀字节跨换铸逐位稳定;基线同拍
  // 回种,磁盘 diff 留给首条提交追尾。落点在 meta 回放（mode → setMode 换铸）**之后**:setMode 换新
  // 运行时=新 ContextManager 磁盘重读,先回种会被换铸静默冲掉;attach 只落 idle 新会话,setMode 无
  // await 点直落换铸（同步生效）,此处 `session.runtime` 已是最终在座运行时。旧档无行/坏包
  // （restoreSnapshot 拒收）→ snapOk=false,attach 收尾回退出生写（坏档永不阻断恢复）
  const snapOk = replay.snapshot !== undefined && session.runtime.harness.context.restoreSnapshot(replay.snapshot);
  const journal = new SessionJournal(dataDir);
  journal.attach(journalId);
  session.attachJournal(journal);
  // 物理板已收养 TeamStore:影子板改跟盘面快照(createdAt/durationMs 权威),再 reconcile 收孤儿
  session.pullBoardFromHarness();
  // 物理板 init 自愈 cancelled 后,journal 回放会把旧 running/pending 盖回影子——对齐权威板并落档
  // (须在 attachJournal 之后,reconcile 的 pump 才能把 cancelled 写入 journal 防下次再孤儿)
  session.reconcileBoardWithHarness();
  // 崩溃档兜底回灌（2026-10-30 spec §2）：与 TUI restoreFromSession 同构——seg 面有而链没有的在飞
  // 窗口归约成链行 appendChain（journal attach 之后执行,回灌行经订阅落 chain 行,恢复即持久化）。
  // 正常档窗口恒空、零开销;回灌失败不阻塞 attach——恢复永远可用,只是兜底少一条
  try {
    const crash = entriesToChainSteps(crashWindowEntries(replayEvents));
    if (crash.length > 0) session.runtime.harness.context.appendChain(crash);
  } catch {
    /* 兜底尽力而为:残缺档不阻塞恢复 */
  }
  // 出生写回退（2026-10-31 spec §4）：旧档无 ctx-snap 行或坏包被拒——磁盘现读即出生写,档尾补新行
  // （末行为准）;回种成功则零事务（快照已随档走）
  if (!snapOk) session.persistSnapshotRow();
  // 孤儿出生档回收（2026-10-31 spec §2 伴生面）：出生写后每个新会话出生即铸 birth-only 档,换挂
  // 真档后成孤儿（/sessions 列表的幻影空会话）——守卫已验其仅含 header/ctx-snap,尽力 purge;
  // 自挂形态（attach 自己的出生档 id）不回收
  if (prevJournalId !== undefined && prevJournalId !== journalId) {
    try {
      purgeSession(dataDir, prevJournalId);
    } catch {
      /* 回收尽力而为:不阻断 attach */
    }
  }
  io.setActive(id);
  return ok({ sessionId: id });
}

/** birth-only 档判定（出生写语义的守卫面,2026-10-31 spec §2）：档仅含 header/ctx-snap 行（零实质
 *  内容）即出生档——逐行 JSON 校验,任一实质行/坏行/读失败即非 birth-only（守卫从严,不误放双挂） */
function birthOnlyJournal(root: string, jid: string): boolean {
  return birthOnlyFile(sessionsDir(resolveDataDir(root)), `${jid}.jsonl`);
}

/** birth-only 文件判定（目录+文件名形态;启动清扫/收编清扫共用——单一判定面） */
function birthOnlyFile(dir: string, fileName: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, fileName), 'utf8');
  } catch {
    return false;
  }
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      const t = (JSON.parse(line) as { t?: unknown }).t;
      if (t !== 'header' && t !== 'ctx-snap') return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** 出生档启动清扫（2026-10-31 用户报障「每次点击运行中会话都产生一个新对话」存量收口）：
 *  收编路径曾只丢内存空壳,盘面 birth-only 档遗留——/sessions 列表每次点击多一行「新会话」
 *  孤儿。boot 序扫全部注册工作区删零实质行档:boot 时零在座会话,无引用可破;birthOnlyFile
 *  守卫从严(任一实质行/坏行/读失败即保留),历史实质档零风险。返回清除数(启动日志面) */
export function sweepBirthOnlyJournals(): number {
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot(), { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = sessionsDir(path.join(projectsRoot(), ent.name, 'data'));
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      if (!birthOnlyFile(dir, f)) continue;
      try {
        fs.rmSync(path.join(dir, f), { force: true });
        removed++;
      } catch {
        /* 单文件失败不阻塞清扫 */
      }
    }
  }
  return removed;
}

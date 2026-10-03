import { isFenceLine, normalizeCjkLine, renderMd, stripAnsi } from './md-ansi';
import type { ChatItem, ChatRole, LiveBlock } from './chat-model';

// D17 拆分件步2（docs/TECH-DEBT-SURVEY.md H1）：流式 md 通道状态机——以持有者 trait 形态从 session.ts 迁出。
// 依赖只限 md-ansi 与 chat-model（不得回引 session.ts），对控制器的全部依赖经下方窄接口回呼。

/** 通道宿主接缝（控制器实现）：水位镜像、产物入档、渲染宽度三个回呼点 */
export interface MdStreamHost {
  /** tailStart 水位镜像写点：宿主自判 live 块是否 reply 后同步 state.live.tailStart（MdBufferPreview 切原文基准） */
  mirrorTailStart(tailStart: number | undefined): void;
  /** 冲刷产物入档回执：宿主走消息区唯一追加写点（pushMsg('assistant', …, { ansi: true })） */
  archiveAnsiFragment(norm: string): void;
  /** 流式渲染宽度（终端列宽，块渲染与终稿兜底渲染共用基准） */
  mdWidth(): number;
}

export class MdStream {
  /** 行喂入缓冲（preprocess 需行级上下文：围栏内不归一） */
  private lineBuf = '';
  private inFence = false;
  /** 本轮流式已喂入通道的全量源（done 终稿前缀对齐基准）：跨 reply/thinking 交错块连续累积，
   *  closeLive 不清（通道生命周期独立于 live 块），seal/clear 随通道一并归零 */
  private source = '';
  /** 未消费块起点（源内偏移，tailStart 水位）：块缓冲期指向当前块首行，块边界（空行）放行后 undefined——LiveBlock.tailStart 镜像 */
  private tailStart: number | undefined;
  /** 块缓冲（2026-09-30 架构裁定「行距唯一权威 = markdown 结构」）：全部完成行紧排入缓冲，
   *  仅在块边界（空行）整块渲染入档（renderMd）——片段粒度 = markdown 块，行距成为源结构的纯函数，
   *  不随流式时序/喂入批次浮动（逐行发射、松散化插行等时变源全部退役的终版形态） */
  private holdBuf = '';
  /** /plan 规划轮：计划正文只以确认卡上屏一次，流式切块与 done 终稿均不再重复入档（重复显示根因） */
  planReplyNoArchive = false;

  constructor(private readonly host: MdStreamHost) {}

  /** done 终稿前缀对齐基准：已推源在冲刷前取样（seal 随通道归零） */
  get pushedSource(): string {
    return this.source;
  }

  /** 行级喂入 + 块边界放行（2026-09-30 架构终版）：全部完成行紧排入块缓冲，仅在 markdown 块边界
   *  （空行）整块渲染入档——片段粒度 = markdown 块（段落/列表/表格/围栏），行距成为源结构
   *  的纯函数：块内紧排（0 空行）、块间单空行（margin），不随流式时序/喂入批次浮动。
   *  tailStart 水位指向当前未放行块首行（镜像 LiveBlock.tailStart 供 MdBufferPreview 实时渲染
   *  未成型块——表格/围栏/段落随生成 WYSIWYG 长出）；空行放行后水位复位。
   *  围栏行翻转 inFence 供归一（围栏内代码不归一），围栏内的空行不拆块（代码空行属于围栏块）。 */
  consume(delta: string): void {
    this.lineBuf += delta;
    this.source += delta;
    let nl = this.lineBuf.indexOf('\n');
    while (nl >= 0) {
      const lineStart = this.source.length - this.lineBuf.length;
      const line = this.lineBuf.slice(0, nl + 1);
      this.lineBuf = this.lineBuf.slice(nl + 1);
      const normalized = normalizeCjkLine(line, this.inFence);
      const fence = isFenceLine(line);
      if (fence) this.inFence = !this.inFence;
      if (!this.inFence && normalized.trim().length === 0) {
        // 空行 = markdown 块边界：当前块整体渲染入档，空行本身不产出条目
        // （块间视觉间隔由入档条目 margin 承载）；水位复位——下一块从后续行重新起算
        this.flushHold();
        this.tailStart = undefined;
      } else {
        // 非空行（散文/列表/表格行/围栏行/围栏内空行）：紧排入当前块缓冲
        if (this.tailStart === undefined) this.tailStart = lineStart;
        this.holdBuf += normalized;
      }
      nl = this.lineBuf.indexOf('\n');
    }
    this.host.mirrorTailStart(this.tailStart);
  }

  /** 块缓冲放行：整块 renderMd 渲染，产物经 pushFragment 入档，水位复位 */
  private flushHold(): void {
    if (this.holdBuf.length === 0) return;
    const buf = this.holdBuf;
    this.holdBuf = '';
    this.tailStart = undefined;
    // 水位镜像必须先于入档通知（2026-10-02「纯正文流式输入框反复跳中」真凶）：入档→notify 同步
    // 触发提交渲染，若此刻 live.tailStart 仍是旧值（指向刚提交的块首），MdBufferPreview 会在
    // 提交帧里把已入档的整块再演一遍——「静态 + 预览」双份超高帧滚动，80ms 后水位落定（consume
    // 末尾镜像）帧再塌回去：输入框每段落一跳（跳到中部、随下一段预览重新往下长，循环往复）。
    // 镜像先写，提交帧即恒为「静态 p+1 行 + 空预览」零位移交换，帧底不动
    this.host.mirrorTailStart(undefined);
    this.pushFragment(renderMd(buf, this.host.mdWidth()));
  }

  /** 片段入档单点：末尾换行恒归一为单 \n（2026-10-01 行距裁决：无尾 \n 的 markdansi 块——heading——
   *  也补齐，尾部空行成为每个 ansi 条目的自体 margin，MessageList 层块间 marginBottom 折 0 的前提）；
   *  剥 ANSI 后纯空白则跳过（视觉间隔由条目 margin 承载）；规划轮正文不入档（确认卡唯一上屏）；
   *  否则经宿主回执即时入档为 ansi 条目（滚动缓冲随生成滚入，对标 CC 打字机） */
  pushFragment(frag: string): void {
    if (frag.length === 0) return;
    const norm = frag.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
    if (stripAnsi(norm).trim().length === 0) return;
    if (this.planReplyNoArchive) return;
    this.host.archiveAnsiFragment(norm);
  }

  /** 冲刷收口（工具边界 sealLiveReply / done 共用）：行尾残段先成行喂入（围栏判定照走），
   *  未闭合表格/围栏经 renderMd 整块渲染自动收口（盒线补全），尾段同样入档，随后通道整体置空 */
  seal(): void {
    this.tailStart = undefined;
    // 行尾残段先并入块缓冲（同段续行不拆块），再整体放行渲染（未闭合结构整块收口）
    if (this.lineBuf.length > 0) {
      const line = this.lineBuf;
      this.lineBuf = '';
      this.holdBuf += normalizeCjkLine(line, this.inFence);
      if (isFenceLine(line)) this.inFence = !this.inFence;
    }
    this.flushHold();
    this.clear();
  }

  /** 通道整体清空（不冲刷不入档）：error 中断 / 规划轮终稿 / 新回合兜底 */
  clear(): void {
    this.tailStart = undefined;
    this.holdBuf = '';
    this.lineBuf = '';
    this.inFence = false;
    this.source = '';
  }
}

/** live 区协调宿主面（结构化窄接口，SessionController 天然实现）：live 块协调函数对控制器状态面的全部依赖。
 *  通道回呼（镜像/入档/宽度）不经此面——协调函数只驱 host.md，由 MdStream 自持的 host 回呼控制器 */
export interface LiveCoordHost {
  readonly md: MdStream;
  /** live 块读点（state.live 单点） */
  get liveBlock(): LiveBlock | undefined;
  /** live 块整置写点（state.live 单点；undefined 即收束） */
  set liveBlock(live: LiveBlock | undefined);
  notify(): void;
  notifyThrottled(): void;
  pushMsg(role: ChatRole, text: string, extra?: Partial<Pick<ChatItem, 'kind' | 'ok' | 'pending' | 'callId' | 'detail' | 'level' | 'ansi'>>): void;
}

/** 追加实时区内容：同类续接；异类先收束旧块（thinking 折叠为摘要行；reply→thinking 交错经 sealLiveReply
 *  尾段成块入档+通道复位，其余 reply 收束走 closeLiveBlock、终稿收口由 done/seal 接管） */
export function appendLiveText(host: LiveCoordHost, kind: LiveBlock['kind'], delta: string): void {
  if (!delta) return;
  const live = host.liveBlock;
  if (live && live.kind !== kind) {
    // 正文→思考交错（2026-10-02「流式输入框跳到中间」）：reply 尾段必须经 sealLiveReply 成块入档。
    // 旧路径 closeLive 只丢 live 块——MdBufferPreview 整段塌掉零静态补偿，动态帧瞬矮 p+1 行，
    // ink 帧顶锚定重写即把帧底输入框抬到屏幕中部；且 md 通道不清（source/tailStart 跨块存续），
    // 新正文 live.text 重起算与 source 坐标错位，tailStart 越界即预览恒空（正文隐形流式直到块边界）。
    // sealLiveReply 与工具边界旁白封口同款零位移交换：预览 p 行 → 静态 p+1 行 + 思考窗 6 行（净增滚动、无跳变）
    if (live.kind === 'reply' && kind === 'thinking') sealLiveReply(host);
    else closeLiveBlock(host);
  }
  const cur = host.liveBlock;
  if (cur && cur.kind === kind) {
    host.liveBlock = { ...cur, text: cur.text + delta };
    if (kind === 'reply') host.md.consume(delta);
    host.notifyThrottled();
    return;
  }
  host.liveBlock = { kind, text: delta, startedAt: Date.now() };
  if (kind === 'reply') host.md.consume(delta);
  host.notify(); // 块首帧即时上屏：保证流式可观测与首字延迟，后续增量并入合帧窗口
}

/** 收束实时区：thinking 折叠为一行摘要；reply 不落消息（终稿由 done 接管） */
export function closeLiveBlock(host: LiveCoordHost): void {
  const live = host.liveBlock;
  if (!live) return;
  host.liveBlock = undefined;
  if (live.kind === 'thinking') {
    const secs = Math.max(1, Math.round((Date.now() - live.startedAt) / 1000));
    host.pushMsg('thinking', `Thought for ${secs}s`, { detail: live.text });
    return;
  }
  host.notify();
}

/** 工具边界旁白封口（2026-09-30，phase 通道退役的配套收口）：live reply 经 md.seal() 冲刷——行尾残段成行
 *  喂入、未闭合表格/围栏整块渲染收口（盒线补全），尾段落为 assistant ansi 消息（规划轮照旧不入档）。
 *  旁白先于其后的工具行定格入档（CC 交错形态：叙述段 → 工具行），不再依赖段落空行边界、也不再被
 *  closeLiveBlock 丢弃（旧形态下旁白 token 副本在工具边界被扔、上屏的只有 phase 副本，▶ 行退役后该丢弃即
 *  旁白整体蒸发）。终稿轮不经此点（done 自带冲刷收口），随后通道整体置空（下一旁白段全新通道） */
export function sealLiveReply(host: LiveCoordHost): void {
  const live = host.liveBlock;
  if (!live) return;
  if (live.kind !== 'reply') {
    closeLiveBlock(host);
    return;
  }
  host.liveBlock = undefined;
  host.md.seal();
  host.notify();
}

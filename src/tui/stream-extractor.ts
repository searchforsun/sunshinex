/** 协议增量提取模式：seek 找键 → after-key 等冒号引号 → in-reply 透出 → settled 吞尾；ignore 工具回合与顶层数组信封；plain 协议违规原文透传 */
import { t } from '../i18n';

export type ExtractorMode = 'seek' | 'after-key' | 'in-reply' | 'settled' | 'ignore' | 'plain';

const TOOL_KEY = '"tool"';
const REPLY_KEY = '"reply"';
/** seek 态滚动窗口长度：保证跨 chunk 分裂的键（如 `"rep` + `ly"`）仍可识别 */
const TAIL = 8;
/** plain 回退上限（字符）：协议违规输出仅透出前 N 个，超出即截断——防异常输出/提示词回显灌屏 */
export const PLAIN_LIMIT = 2000;
/** 协议信封键模式：plain 态自 `{` 起挂起的候选中若出现这些键，则该对象是协议信封、不是正文 */
const ENVELOPE_KEY = /"(?:tool|tools|done|reply|phase)"\s*:/;
/** plain 态挂起候选上限：未闭合又无协议键的花括号文本（残破片段）达此长度即按原文透出，不无限挂起 */
const PLAIN_JSON_HOLD = 4000;

/**
 * 增量协议提取器：模型输出的 JSON 协议骨架不上屏，只透出 reply 字段文本；协议违规（非 JSON）输出有限透传。
 * 纯状态机（零 IO、零依赖）：供渲染层逐段刷新，终稿仍以 done 载荷为准。
 */
export class ReplyStreamExtractor {
  private mode: ExtractorMode = 'seek';
  private tail = '';
  private lead = '';          // seek 态跳过的前导空白（plain 回退时补发）
  private sawLead = false;    // 是否已见首个非空白字符
  private colonSeen = false;  // after-key 态是否已消费冒号
  private escaped = false;    // in-reply 态：上一字符是否为未消费的反斜杠
  private unicode = '';       // \uXXXX 累积缓冲
  private out = '';
  private plainEmitted = 0;   // plain 回退已透出字符数（达 PLAIN_LIMIT 即截断收口）
  private truncated = false;  // 截断提示是否已补发（只补一次）
  private hold = '';          // plain 态自 `{` 起的挂起候选：待判定是协议信封（吞）还是花括号正文（透出）
  private holdDepth = 0;      // 挂起候选的花括号深度（字符串感知：字符串里的 `}` 不算闭合）
  private holdInString = false;
  private holdEscaped = false;

  constructor(private readonly onReplyDelta: (text: string) => void) {}

  /** 当前状态（测试断言用） */
  get currentMode(): ExtractorMode {
    return this.mode;
  }

  /** 回合复位：tool-call / done / error 后调用，隔离下一回合的协议骨架 */
  reset(): void {
    this.mode = 'seek';
    this.tail = '';
    this.lead = '';
    this.sawLead = false;
    this.colonSeen = false;
    this.escaped = false;
    this.unicode = '';
    this.out = '';
    this.plainEmitted = 0;
    this.truncated = false;
    this.hold = '';
    this.holdDepth = 0;
    this.holdInString = false;
    this.holdEscaped = false;
  }

  /** 消费一段原始增量（可任意切分）；提取出的 reply 文本按段回调 */
  feed(delta: string): void {
    this.out = '';
    for (const ch of delta) this.step(ch);
    if (this.out.length > 0) this.onReplyDelta(this.out);
  }

  private emit(text: string): void {
    this.out += text;
  }

  /** plain 回退专用发射：带总长上限，超限即截断并补一次提示——异常输出（含提示词回显）不得整段灌屏 */
  private emitPlain(text: string): void {
    const remain = PLAIN_LIMIT - this.plainEmitted;
    if (remain <= 0) {
      this.emitTruncateHint();
      return;
    }
    if (text.length <= remain) {
      this.plainEmitted += text.length;
      this.emit(text);
      return;
    }
    this.emit(text.slice(0, remain));
    this.plainEmitted = PLAIN_LIMIT;
    this.emitTruncateHint();
  }

  /** 截断提示只补一次（逐字符流式下 remain 先归零，不能只靠溢出分支判定） */
  private emitTruncateHint(): void {
    if (this.truncated) return;
    this.truncated = true;
    this.emit(t('\n…(output too long, truncated)', '\n…（输出超长，已截断）'));
  }

  private step(ch: string): void {
    switch (this.mode) {
      case 'seek':
        this.stepSeek(ch);
        return;
      case 'after-key':
        this.stepAfterKey(ch);
        return;
      case 'in-reply':
        this.stepInReply(ch);
        return;
      case 'plain':
        this.stepPlain(ch);
        return;
      default: // ignore / settled：协议剩余骨架一律吞掉
        return;
    }
  }

  /**
   * plain 态（首个非空白字符既不是 `{` 也不是 `[`，判定为协议违规）透传原文——但**协议信封仍必须吞掉**。
   * 历史缺陷：一路透传会把信封连 content 整段灌进正文（模型先写散文再补信封、或首字符是不可见字符使
   * seek 误判裸文本时都会发生）。故自 `{` 起先挂起候选：出现协议键即整段丢弃并回到 seek 续接
   * （是 reply 信封则照常提取正文），确认是普通花括号文本才按原文透出。
   */
  private stepPlain(ch: string): void {
    if (this.hold.length === 0) {
      if (ch === '{') {
        this.hold = ch;
        this.holdDepth = 1;
        this.holdInString = false;
        this.holdEscaped = false;
        return;
      }
      this.emitPlain(ch);
      return;
    }
    this.hold += ch;
    if (this.holdInString) {
      if (this.holdEscaped) this.holdEscaped = false;
      else if (ch === '\\') this.holdEscaped = true;
      else if (ch === '"') this.holdInString = false;
    } else if (ch === '"') {
      this.holdInString = true;
    } else if (ch === '{') {
      this.holdDepth += 1;
    } else if (ch === '}') {
      this.holdDepth -= 1;
    }
    // 键后必是冒号：只在此处判定，避免逐字符扫全量候选
    if (ch === ':' && ENVELOPE_KEY.test(this.hold)) {
      const held = this.hold;
      this.hold = '';
      this.mode = 'seek';
      this.sawLead = true; // 前导已由散文承载：seek 不再判首字符，直接按协议态续接
      this.tail = '';
      for (const c of held) this.step(c);
      return;
    }
    if (this.holdDepth <= 0 || this.hold.length >= PLAIN_JSON_HOLD) {
      this.emitPlain(this.hold);
      this.hold = '';
      this.holdDepth = 0;
    }
  }

  private stepSeek(ch: string): void {
    if (!this.sawLead) {
      if (/\s/.test(ch)) {
        this.lead += ch;
        return;
      }
      this.sawLead = true;
      if (ch !== '{') {
        // 顶层数组：并行信封的畸形包装（[{...tools...}]），协议原文不得上屏——
        // 与 parse 层数组归一同语义，此处整回合静默，终稿/工具流照常
        if (ch === '[') {
          this.mode = 'ignore';
          return;
        }
        // 协议违规：非 JSON 输出有限透传（补发已跳过的前导空白，受 PLAIN_LIMIT 约束）
        this.mode = 'plain';
        this.emitPlain(this.lead + ch);
        return;
      }
    }
    this.tail = (this.tail + ch).slice(-TAIL);
    if (this.tail.endsWith(TOOL_KEY)) {
      this.mode = 'ignore';
      return;
    }
    if (this.tail.endsWith(REPLY_KEY)) {
      this.mode = 'after-key';
    }
  }

  private stepAfterKey(ch: string): void {
    if (/\s/.test(ch)) return;
    if (ch === ':' && !this.colonSeen) {
      this.colonSeen = true;
      return;
    }
    if (ch === '"' && this.colonSeen) {
      this.mode = 'in-reply';
      return;
    }
    this.mode = 'ignore'; // 结构不符协议：放弃实时提取，done 收尾兜底
  }

  private stepInReply(ch: string): void {
    if (this.unicode.length > 0) {
      this.unicode += ch;
      if (this.unicode.length === 5) {
        const code = parseInt(this.unicode.slice(1), 16);
        this.emit(Number.isNaN(code) ? '' : String.fromCharCode(code));
        this.unicode = '';
      }
      return;
    }
    if (this.escaped) {
      this.escaped = false;
      if (ch === 'n') this.emit('\n');
      else if (ch === 't') this.emit('\t');
      else if (ch === 'r') this.emit('\r');
      else if (ch === 'u') this.unicode = 'u';
      else this.emit(ch); // \" \\ \/ 及其它：转义后取原字符
      return;
    }
    if (ch === '\\') {
      this.escaped = true;
      return;
    }
    if (ch === '"') {
      this.mode = 'settled';
      return;
    }
    this.emit(ch);
  }
}

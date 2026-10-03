import * as path from 'path';
import { loadSkills } from '../skills';
import { SUNSHINE_EXCERPT_MAX_CHARS } from '../memory/extractor';
import { INDEX_NAME, memoryDir } from '../memory/store';

/** 漂移探测注入面（D25/H3 拆分自 ContextManager 职责②）：磁盘读全部经门面回调注入，探测器对 ContextManager 零反向依赖——
 *  SUNSHINE 两层走 loader 无副作用形态（缺失为 null，检测永不因文件缺失而抛）；记忆索引走快照装载同源单点
 *  （防快照/比对两处读盘口径漂移）；技能清单读盘是漂移域私有逻辑（只比 id 集，正文永不进上下文）。 */
export interface DriftDetectorDeps {
  /** 项目根（说明行 read 指针路径与技能清单读盘基准） */
  root: string;
  /** 全局层 ~/.sunshinex/SUNSHINE.md 原文读盘（不存在或不可读为 null） */
  readGlobalSunshine(): string | null;
  /** 项目层 SUNSHINE.md 原文读盘（语义同上） */
  readSunshinex(): string | null;
  /** 全局层绝对路径（漂移说明 read 指针文案用） */
  globalPath: string;
  /** 记忆索引 MEMORY.md 全文读盘（无文件为空串；与快照装载共用单点口径） */
  readMemoryIndex(): string;
}

/** 会话常量漂移探测器（规范 N1 / 规格 §9.2）：刷新点捕获四类基线（全局/项目 SUNSHINE.md、技能 id 集、记忆索引全文），
 *  轮询比对读盘现值，产出应尾追链尾的英文说明行。确定性、零模型调用；基线随比对前进（同一变更只告知一次），
 *  刷新点由门面在 rebuildSnapshot 后调 captureBaselines 重置。 */
export class DriftDetector {
  /** 动态改动尾追基线（规范 N1 / 规格 §9.2）：刷新点捕获，会话中途与磁盘比对不一致即尾追变更说明；
   *  null 表示「磁盘无 SUNSHINE.md」这一确定态，与「未捕获」不混 */
  private sunshinexBaseline: string | null = null;
  /** 全局约定基线（~/.sunshinex/SUNSHINE.md 全文；语义同 sunshinexBaseline，独立基线独立告知） */
  private globalSunshineBaseline: string | null = null;
  /** 技能清单基线（id 集排序 join；新增才告知，正文永不进上下文） */
  private skillsBaseline = '';
  /** 记忆索引基线（MEMORY.md 全文；跨轮整理/写入时增量告知，快照仍冻结） */
  private memoryBaseline = '';

  constructor(private readonly deps: DriftDetectorDeps) {
    this.captureBaselines();
  }

  /** 刷新点基线捕获（构造与 reloadContext 经门面调用，防两处装配漂移）：漂移比对的基准，随刷新点与磁盘对齐 */
  captureBaselines(): void {
    this.globalSunshineBaseline = this.deps.readGlobalSunshine();
    this.sunshinexBaseline = this.deps.readSunshinex();
    this.skillsBaseline = skillIds(this.deps.root);
    this.memoryBaseline = this.deps.readMemoryIndex();
  }

  /** 漂移检测（原 ContextManager.checkConstantsDrift，语义逐字保持）：读盘比对刷新点基线，返回应尾追的说明行文本。
   *  基线随比对前进（同一变更只告知一次）；说明文案恒英文单语——经 appendChain 写链即提示词面（CLAUDE.md §15）。 */
  detect(): string[] {
    const out: string[] = [];
    const globalText = this.deps.readGlobalSunshine();
    if (globalText !== this.globalSunshineBaseline) {
      out.push(this.sunshineDriftText('Global SUNSHINE.md', globalText, this.deps.globalPath));
      this.globalSunshineBaseline = globalText;
    }
    const current = this.deps.readSunshinex();
    if (current !== this.sunshinexBaseline) {
      out.push(this.sunshineDriftText('SUNSHINE.md', current, path.join(this.deps.root, 'SUNSHINE.md')));
      this.sunshinexBaseline = current;
    }
    const ids = skillIds(this.deps.root);
    if (ids !== this.skillsBaseline) {
      const before = new Set(this.skillsBaseline.split('\n').filter((s) => s.length > 0));
      const added = ids.split('\n').filter((s) => s.length > 0 && !before.has(s));
      if (added.length > 0) {
        out.push(`[skills] added: ${added.join(', ')} — load with the skill tool`);
      }
      this.skillsBaseline = ids;
    }
    const mem = this.deps.readMemoryIndex();
    if (mem !== this.memoryBaseline) {
      out.push(this.memoryDriftText(mem, path.join(memoryDir(this.deps.root), INDEX_NAME)));
      this.memoryBaseline = mem;
    }
    return out;
  }

  /** 单层 SUNSHINE 漂移说明构建（全局/项目两层共用单点，防两处拼装漂移）：变更头+最新全文（超限截断附 read 指针）/ 消失态；文案恒英文单语（写链即提示词面） */
  private sunshineDriftText(label: string, current: string | null, filePath: string): string {
    const text =
      current === null
        ? `(${label} is gone)`
        : current.length > DRIFT_MAX_CHARS
          ? `${current.slice(0, DRIFT_MAX_CHARS)}\n…(truncated) — read ${filePath} for the rest`
          : current;
    return [
      `${label} changed (the session snapshot is stale; the text below is authoritative until the next refresh point):`,
      text,
    ].join('\n');
  }

  /** 记忆索引漂移说明构建（对齐 sunshineDriftText 形态，2026-10-02 用户要求「上下文绝对正确」——
   *  指针式「去读 MEMORY.md」升级为正文级尾追：变更头带 supersession 声明与 slug 失联警告，正文承载
   *  新索引全文（超限截断附 read 指针），使「链尾即真相」成立——模型不花工具调用也能拿到当前态） */
  private memoryDriftText(current: string, indexPath: string): string {
    const trimmed = current.trim();
    const text =
      trimmed.length === 0
        ? '(the memory index is now empty)'
        : current.length > DRIFT_MAX_CHARS
          ? `${current.slice(0, DRIFT_MAX_CHARS)}\n…(truncated) — read ${indexPath} for the rest`
          : trimmed;
    return [
      '[memory] index changed (the snapshot entry above is stale; records listed there may have been merged or removed and their slugs may no longer resolve; the index below is authoritative until the next refresh point):',
      text,
    ].join('\n');
  }
}

/** 技能 id 集（排序后 join，跨环境逐字节稳定）：漂移比对用——只比 id 集，技能正文永不进上下文 */
function skillIds(root: string): string {
  return loadSkills(root)
    .map((m) => m.id)
    .sort()
    .join('\n');
}

/** 漂移全文块字符上限：超过即截断并附 read <绝对路径> 指针（防单次尾追挤爆上下文）——
 *  与提取材料节同水位，单一来源在 extractor.SUNSHINE_EXCERPT_MAX_CHARS（本地别名保留 DRIFT 域语义：
 *  本处覆盖 SUNSHINE 与记忆索引两类漂移全文，水位须与材料面同进退） */
const DRIFT_MAX_CHARS = SUNSHINE_EXCERPT_MAX_CHARS;

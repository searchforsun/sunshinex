/**
 * 动态帧高度嗅探器（2026-09-30 方案 A 配套）：尾部原位重写需要「擦写起点距光标的行数」=
 * 尾部账本行数 + 动态帧行数。帧高不解析 ink 内部状态，从写流自身的模式识别——
 * ink3 每次动态帧重写经 log-update 发出「前导擦除序列（2K/1A 交替，即 eraseLines）+ 帧内容 + \n」，
 * 静态冲刷走「log.clear（纯擦除无换行）→ 静态内容 → 无前导擦除的帧」三连。
 * 只对形态可判定的写建立置信值：前导擦除帧、三连中的第三写；其余（冷挂首帧、清屏、2026 单写、
 * 未知裸内容）一律清零为 undefined——tui-loop 对无置信值回落全量路径，永不错位。
 */
export interface FrameSniffer {
  /** 最近一次置信学习到的动态帧行数；无置信值返回 undefined */
  frameLines(): number | undefined;
  /** 丢弃当前置信值（新挂载前调用，防上一挂载帧高串台） */
  reset(): void;
}

/** log-update 前导擦除：eraseLines(n) = 2K (1A 2K){n-1} G */
const ERASE_ONLY = /^\u001b\[2K(?:\u001b\[1A\u001b\[2K)*\u001b\[G?$/;
const FRAME_PREFIX = /^\u001b\[2K(?:\u001b\[1A\u001b\[2K)*\u001b\[G/;
/** DEC 2026 同步更新包裹（installSyncUpdateWrap 的产物）：嗅探在外层，先剥壳再分类 */
const SYNC_WRAP = /^\u001b\[\?2026h([\s\S]*)\u001b\[\?2026l$/;

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

export function installFrameSniffer(stream: { write: (...args: unknown[]) => unknown }): FrameSniffer {
  let frame: number | undefined;
  let afterClear = false;
  let afterStatic = false;
  const orig = stream.write.bind(stream);
  stream.write = (...args: unknown[]): unknown => {
    const chunk = args[0];
    if (typeof chunk === 'string' && chunk.length > 0) {
      const unwrapped = SYNC_WRAP.exec(chunk);
      const payload = unwrapped !== null ? unwrapped[1]! : chunk;
      if (!payload.includes('\n')) {
        if (ERASE_ONLY.test(payload)) {
          // log.clear：帧高不变，等后续「静态内容 → 帧」三连补位
          afterClear = true;
          afterStatic = false;
        } else {
          // 清屏（2J/3J/H）、2026 单写、光标控制等噪声：置信清零
          afterClear = false;
          afterStatic = false;
          frame = undefined;
        }
      } else if (FRAME_PREFIX.test(payload)) {
        // 常规动态帧重写（带前导擦除）：帧高 = 内容换行数
        frame = countNewlines(payload);
        afterClear = false;
        afterStatic = false;
      } else if (afterClear) {
        // 三连第 2 写：静态内容，跳过
        afterClear = false;
        afterStatic = true;
      } else if (afterStatic) {
        // 三连第 3 写：清帧后重打的动态帧（无前导擦除）
        frame = countNewlines(payload);
        afterStatic = false;
      } else {
        // 无标记裸内容（冷挂首帧/未知）：不置信
        frame = undefined;
      }
    }
    return orig(...args);
  };
  return {
    frameLines: () => frame,
    reset: () => {
      frame = undefined;
      afterClear = false;
      afterStatic = false;
    },
  };
}

import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Connection } from '../../connection';
import { applyChatEvent, appendUserMessage } from '../../chat-reducer';
import { expandFileRefs, expandRefContents } from './mention';

/** §7 提交路径单点(D32 第六批批F-7a 自 Chat.tsx 平移):idle→submit/running→steer;
 *  /btw /side 拦截/命令通道 supported 白名单/失败倒 error 条再 rethrow(编辑卡保卡
 *  保草稿)。send=Enter 分流壳;interrupt=停止。submitTextRef 赋值留宿主(事件 hook 消费面)。
 *  图片附件(2026-10-26):submitText 第二参 images(dataURL 列)——随 submit/steer 透传;携图时
 *  跳过 /btw·命令通道(命令/旁路面不承载图片,直走 sessionSubmit——daemon plan-arm 提交通道
 *  自行分流),空文+纯图合法(图片即消息)。
 *  计划模式(2026-11-03 无感化):/plan 系命令照走命令通道(命令是底层实现,GUI 只是渲染层,
 *  不在上层拦截底层命令)。/plan 命令成功后由宿主回调同步 sessMode pill 显示(渲染层跟随,
 *  不改底层命令语义)。 */
export function useChatSubmit(deps: {
  readonly conn: Connection;
  readonly sessionId: string;
  readonly running: boolean;
  readonly sessMode: 'read-only' | 'acceptEdits' | 'full-access' | 'plan';
  readonly root: string | undefined;
  readonly resolveFileRef: (name: string) => string | undefined;
  /** 2026-11-04 元素/终端片段引用账本(token→全量内容,发送期展开) */
  readonly refContents: ReadonlyMap<string, string>;
  readonly cmdData: { commands: string[]; descriptions: Record<string, string>; supported: string[] } | null;
  readonly setChat: Dispatch<SetStateAction<import('../../chat-reducer').ChatState>>;
  readonly onSideChat?: () => void;
  readonly refreshQueued: () => void;
  readonly input: string;
  readonly setInput: Dispatch<SetStateAction<string>>;
  /** composer 待发图片附件(dataURL 列,≤8 张;send 发送即清) */
  readonly images: string[];
  readonly setImages: Dispatch<SetStateAction<string[]>>;
  /** 提交被接受回调(2026-10-27 等待模型待态):idle 提交成功 resolve 即调——宿主据此时点
   *  起待态计时,run-open 落地(run 条出现)即收——命令通道不调(命令无 run-open,调了=永转) */
  readonly onAccepted?: () => void;
  /** 发送拦截(2026-10-31 用户报障「转圈时应该阻止发送,防止 409」):等待模型待态/提交在途期
   *  Enter 与发送钮一律不发(输入保留);运行中不在此列(运行中=steer 排队语义合法) */
  readonly sendBlocked?: boolean;
  /** 计划模式 pill 同步回调(2026-11-03):/plan 系命令成功后由宿主更新 sessMode 显示 */
  readonly onPlanModeChanged?: (mode: 'read-only' | 'acceptEdits' | 'full-access' | 'plan') => void;
}): {
  submitText: (text: string, images?: string[]) => Promise<void>;
  send: () => void;
  interrupt: () => void;
} {
  const { conn, sessionId, running, sessMode, root, resolveFileRef, refContents, cmdData, setChat, onSideChat, refreshQueued, input, setInput, images, setImages, onAccepted, sendBlocked, onPlanModeChanged } = deps;
/** §7 提交路径单点(idle→submit/running→steer):composer 与编辑卡共用。
 *  本地回显新条,失败倒 error 条(既有逻辑)再 rethrow——编辑卡借 Promise 结果保卡保草稿
 *  (spec §9:提交失败草稿不丢);成功 resolve;空文本且无图 resolve 忽略 */
const submitText = useCallback(
  (text: string, imgs?: string[]): Promise<void> => {
    const hasImages = imgs !== undefined && imgs.length > 0;
    // G14.124 @短写 → md 绝对链接(模型/正文/气泡统一 md 链接口径);命令面(/开头)不展开
    const expanded = expandRefContents(expandFileRefs(text, root, resolveFileRef), refContents).trim();
    const trimmed = expanded.trim();
    if (trimmed === '' && !hasImages) return Promise.resolve();
    // G14.29:/btw /side 输入拦截——开辅助对话旁路标签(Codex 同款;不占主链提交面);携图不拦(图片走主链)
    if (!hasImages && /^\/(btw|side)(\s|$)/.test(trimmed)) {
      onSideChat?.();
      return Promise.resolve();
    }
    // 命令通道判定(2026-11-03 修):**内置命令 /plan 恒识别为命令,不依赖 cmdData**——cmdData 异步
    // 在途/未加载时 isCommand 误 false → /plan 被当普通文本发给模型(用户实测根因)。/plan 是计划
    // 模式底层命令,恒走命令通道(底层承载);其余 / 词仍依赖 cmdData(skills/未知名回落纯文本)
    const cmdName = /^\/([a-z][\w-]*)/i.exec(trimmed)?.[1]?.toLowerCase() ?? '';
    const isBuiltinPlan = cmdName === 'plan';
    const isCommand = !running && !hasImages && /^\/[a-z][\w-]*(\s|$)/i.test(trimmed)
      ? isBuiltinPlan || (cmdData?.supported.some((c) => c.toLowerCase() === `/${cmdName}`) ?? false)
      : false;
    const dispatch = (): Promise<void> => {
      if (running) return conn.sessionSteer(sessionId, trimmed, imgs).then(() => refreshQueued(), () => {});
      if (hasImages) return conn.sessionSubmit(sessionId, trimmed, imgs); // 携图:直走提交面(daemon armed 拦截转 planFlow;命令/旁路面不承载图片)
      if (isCommand) {
        // G14.213 skills 回归纯文本:仅「daemon supported 清单内」的 / 词走命令通道,skills/
        // 未知名一律当普通文本提交(系统提示词 skills 清单含「/skill-id 引用优先加载」提示,
        // 模型自主判断)。此前一律先试命令通道、报文含 unsupported 才回落——daemon 现回 400
        // 报文不带该字样,回落失效直接倒错误条(「还是识别成命令了」)
        return conn
          .runCommand(sessionId, trimmed)
          .catch(async (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/unsupported|400|bad request/i.test(msg)) throw err; // busy 等真实失败照常倒 error 条
            await conn.sessionSubmit(sessionId, trimmed); // 清单过期兜底:命令通道拒即回退纯文本
          })
          .then(() => undefined);
      }
      return conn.sessionSubmit(sessionId, trimmed);
    };
    // 计划模式 arm 竞窗收口(2026-11-03):pill 乐观置选与 daemon setMode 异步在途的窗口内提交,
    // 先补 arm(快路径幂等恒 ok)再提交/入队,armed 拦截在 daemon submit 单点兜住;命令词不补。
    // 仅 plan 模式走「先 arm 后发」(微任务有序);非 plan 路径保持原同步形态(编辑卡/待态时序锚不动的纪律)
    const ensureArm: Promise<void> = sessMode === 'plan' && !isCommand
      ? conn.setSessionMode(sessionId, 'plan').catch(() => undefined)
      : Promise.resolve();
    // G14.89 运行中入队不本地回显:气泡等轮收束自动发送时由 submit 回显(队列语义=还没发生);
    // idle 提交即发生,照旧回显;命令通道由 daemon 回显
    if (!running && !isCommand) setChat((c) => appendUserMessage(c, trimmed, undefined, imgs));
    let req: Promise<void>;
    if (sessMode === 'plan' && !isCommand) req = ensureArm.then(dispatch);
    else req = dispatch();
    // /plan 系命令成功后同步 sessMode pill 显示(渲染层跟随,不改底层命令语义)
    if (/^\/plan\b/.test(trimmed) && !hasImages) {
      const isOff = trimmed.trim() === '/plan off';
      void req.then(() => {
        onPlanModeChanged?.(isOff ? 'acceptEdits' : 'plan');
      });
    }
    return req
      .then(() => {
        if (!running && !isCommand) onAccepted?.();
      })
      .catch((err: unknown) => {
        setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
        throw err;
      });
  },
  [conn, sessionId, running, sessMode, root, resolveFileRef, cmdData, onAccepted, onPlanModeChanged],
);
const send = (): void => {
    if (sendBlocked === true) return;
    const text = input.trim();
    if (text === '' && images.length === 0) return;
    setInput('');
    setImages([]);
    submitText(text, images).catch(() => undefined);
};
const interrupt = (): void => {
    void conn.sessionInterrupt(sessionId).catch((err: unknown) => {
      setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
    });
};
  return { submitText, send, interrupt };
}

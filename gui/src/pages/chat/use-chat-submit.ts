import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Connection } from '../../connection';
import { applyChatEvent, appendUserMessage } from '../../chat-reducer';
import { expandFileRefs } from './mention';

/** §7 提交路径单点(D32 第六批批F-7a 自 Chat.tsx 平移,行为零变化):idle→submit/running→steer/
 *  plan→/plan;/btw /side 拦截/命令通道 supported 白名单/失败倒 error 条再 rethrow(编辑卡保卡
 *  保草稿)。send=Enter 分流壳;interrupt=停止。submitTextRef 赋值留宿主(事件 hook 消费面)。 */
export function useChatSubmit(deps: {
  readonly conn: Connection;
  readonly sessionId: string;
  readonly running: boolean;
  readonly sessMode: 'read-only' | 'acceptEdits' | 'full-access' | 'plan';
  readonly root: string | undefined;
  readonly resolveFileRef: (name: string) => string | undefined;
  readonly cmdData: { commands: string[]; descriptions: Record<string, string>; supported: string[] } | null;
  readonly setChat: Dispatch<SetStateAction<import('../../chat-reducer').ChatState>>;
  readonly onSideChat?: () => void;
  readonly refreshQueued: () => void;
  readonly input: string;
  readonly setInput: Dispatch<SetStateAction<string>>;
}): {
  submitText: (text: string) => Promise<void>;
  send: () => void;
  interrupt: () => void;
} {
  const { conn, sessionId, running, sessMode, root, resolveFileRef, cmdData, setChat, onSideChat, refreshQueued, input, setInput } = deps;
/** §7 提交路径单点(idle→submit/running→steer/plan→/plan):composer 与编辑卡共用。
 *  本地回显新条,失败倒 error 条(既有逻辑)再 rethrow——编辑卡借 Promise 结果保卡保草稿
 *  (spec §9:提交失败草稿不丢);成功 resolve;空文本 resolve 忽略 */
const submitText = useCallback(
  (text: string): Promise<void> => {
    // G14.124 @短写 → md 绝对链接(模型/正文/气泡统一 md 链接口径);命令面(/开头)不展开
    const expanded = expandFileRefs(text, root, resolveFileRef).trim();
    const trimmed = expanded.trim();
    if (trimmed === '') return Promise.resolve();
    // G14.29:/btw /side 输入拦截——开辅助对话旁路标签(Codex 同款;不占主链提交面)
    if (/^\/(btw|side)(\s|$)/.test(trimmed)) {
      onSideChat?.();
      return Promise.resolve();
    }
    // G14.89 运行中入队不本地回显:气泡等轮收束自动发送时由 submit 回显(队列语义=还没发生);
    // idle/plan 提交即发生,照旧回显
    if (!running) setChat((c) => appendUserMessage(c, trimmed));
    let req: Promise<void>;
    if (running) req = conn.sessionSteer(sessionId, trimmed).then(() => refreshQueued(), () => {});
    else if (sessMode === 'plan') req = conn.runCommand(sessionId, `/plan ${trimmed}`);
    else if (/^\/[a-z][\w-]*(\s|$)/i.test(trimmed)) {
      // G14.213 skills 回归纯文本:仅「daemon supported 清单内」的 / 词走命令通道,skills/
      // 未知名一律当普通文本提交(系统提示词 skills 清单含「/skill-id 引用优先加载」提示,
      // 模型自主判断)。此前一律先试命令通道、报文含 unsupported 才回落——daemon 现回 400
      // 报文不带该字样,回落失效直接倒错误条(「还是识别成命令了」)
      const word = (/^\/([a-z][\w-]*)/i.exec(trimmed)?.[1] ?? '').toLowerCase();
      const isCommand = cmdData?.supported.some((c) => c.toLowerCase() === `/${word}`) ?? false;
      if (isCommand) {
        req = conn
          .runCommand(sessionId, trimmed)
          .catch(async (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/unsupported|400|bad request/i.test(msg)) throw err; // busy 等真实失败照常倒 error 条
            await conn.sessionSubmit(sessionId, trimmed); // 清单过期兜底:命令通道拒即回退纯文本
          })
          .then(() => undefined);
      } else req = conn.sessionSubmit(sessionId, trimmed);
    } else req = conn.sessionSubmit(sessionId, trimmed);
    return req.catch((err: unknown) => {
      setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
      throw err;
    });
  },
  [conn, sessionId, running, sessMode, root, resolveFileRef, cmdData],
);

const send = (): void => {
  const text = input.trim();
  if (text === '') return;
  setInput('');
  // fire-and-forget 语义不变:错误面已在 submitText 内倒 error 条;显式吞 rethrow——纯 `void`
  // 不消化 rejection,会留 unhandled rejection(改动前 rejection 被 req.catch 全消费)
    // 补全路径命令执行失败=无输出行(可重试);错误条可见化由主提交路径承担
  submitText(text).catch(() => undefined);
};

const interrupt = (): void => {
  void conn.sessionInterrupt(sessionId).catch((err: unknown) => {
    setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
  });
};
  return { submitText, send, interrupt };
}

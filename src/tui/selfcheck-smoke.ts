/**
 * TUI 流式管线自检冒烟（D80③ 自 cli/commands/selfcheck 抽出，tui 域自持冒烟细节）：
 * 合成流式适配器驱动 SessionController 全链（reasoning→thinking 折叠、token→reply 流式、
 * usage→本轮 tokens），离线零网络。cli 侧经此单点单向分发（与 index→runTui 同形），
 * 冒烟口径变更不再触 cli/commands。
 */
import { ChatRequest, ChatResult } from '../types';
import { ModelAdapter, UsageHooks } from '../model/adapter';
import { SessionController } from './session';
import { stripAnsi } from './md-ansi';
import { t } from '../i18n';

/** 自检用流式适配器：合成 reasoning → token 逐字流 → usage 上报（离线、零网络，驱动流式管线冒烟） */
class SelfcheckStreamAdapter implements ModelAdapter {
  readonly provider = 'selfcheck-stream';
  async chat(): Promise<ChatResult> {
    return { finish: 'stop', content: '流式自检 OK', toolCalls: [] };
  }
  async chatStream(_req: ChatRequest, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<ChatResult> {
    hooks?.onReasoning?.('自检思考');
    const text = '流式自检 OK';
    for (const ch of text) onDelta(ch);
    hooks?.onUsage?.(3);
    return { finish: 'stop', content: text, toolCalls: [] };
  }
}

export async function selfcheckTuiSmoke(): Promise<void> {
  const tuiCtrl = new SessionController({ root: process.cwd(), model: new SelfcheckStreamAdapter() });
  await tuiCtrl.submit('selfcheck tui 流式冒烟');
  await tuiCtrl.waitIdle();
  const tuiState = tuiCtrl.getState();
  // 正文流式改 markdansi 通道后 assistant 条目为 ANSI 渲染文本（ansi: true，renderMd 末行带换行），
  // 等值比对按剥码去尾换行的可见正文口径
  const tuiReply = tuiState.messages.filter((m) => m.role === 'assistant').map((m) => stripAnsi(m.text)).join('').trim();
  const tuiThink = tuiState.messages.filter((m) => m.role === 'thinking').length;
  if (tuiReply !== '流式自检 OK') throw new Error(`tui 流式答复异常：${tuiReply}`);
  if (tuiThink < 1) throw new Error('tui 思考折叠未生效');
  if (tuiState.metrics.turnTokens !== 3) throw new Error(`tui 本轮 tokens 异常：${tuiState.metrics.turnTokens}`);
  // 流式正文即最终正文（function calling：token 增量承载纯正文，无协议骨架过滤层）
  console.log('tui     :', t(
    `streaming pipeline OK (${tuiState.messages.length} messages; reply "${tuiReply}"; thinking folds ${tuiThink})`,
    `流式管线 OK（${tuiState.messages.length} 条消息；答复「${tuiReply}」；思考折叠 ${tuiThink} 段）`,
  ));
}

import { chainToHistoryItems, runCompaction, contextBreakdown } from '../harness/context';
import { removeLearnedSkill } from '../harness/skills';
import { resolveRunWindow } from '../config/termination-config';
import { setMemorySessionOverride } from '../config/memory-config';
import { resolveDataDir } from '../config/data-dir';
import { markSessionArchived, purgeSession, purgeSideJournals, readSessionMeta } from '../tui/session-journal';
import type { SessionRuntime } from './session';

/** command 直跑通道(G10 spec §6):TUI handleSlash 分支的 daemon 移植层。
 *  纪律:操作共享 runtime 单点;纯函数(chainToHistoryItems/runCompaction/contextBreakdown)从
 *  harness/context 公开面直接 import——零复制;pushMsg → transcript.push(notice)。
 *  支持集按批扩:重流程分支(/init /goal /plan /skill /kb-index /memory-add /memory-gc /tasks)随
 *  planFlow 等共享化逐批入列,GET /commands 消费面置灰判定同步。
 *  回执文案=规范英文单语产出(2026-11-04 裁定:底层产出语言中立原始语言——agent 动态内容与报错
 *  除外;语言渲染归前端:GUI 固定头模式表 gui/src/i18n-notice.ts、TUI 自身 t()。daemon 语言不再
 *  影响回执,改文案须与 GUI 模式表两处同添) */

/** 当前通道支持集(gui 命令面板置灰判定源;随分支移植批扩) */
export const COMMAND_SUPPORT = ['/status', '/compact', '/context', '/memory-on', '/memory-off', '/archive', '/unarchive', '/delete', '/plan', '/skills-rm'] as const;

export type CommandRunResult = 'ok' | 'unsupported' | 'busy';

const IDLE_ONLY = new Set(['/compact', '/archive', '/unarchive', '/delete']);

export function isCommandSupported(line: string): boolean {
  return (COMMAND_SUPPORT as readonly string[]).includes(line.split(/\s/)[0] ?? '');
}

export async function runCommand(s: SessionRuntime, line: string): Promise<CommandRunResult> {
  const cmd = line.split(/\s/)[0] ?? '';
  if (!isCommandSupported(line)) return 'unsupported';
  if (IDLE_ONLY.has(cmd) && s.status() !== 'idle') return 'busy';
  // 命令气泡入档+回显(2026-10-21 用户裁决,对齐 TUI submit 先例 j.log({t:'user'})+pushMsg 回显):
  // unsupported/busy 先行拦截——只有真执行的命令落 user 行,回放(刷新/回溯)才可见「执行过什么命令」
  // 的气泡而不仅结果回执;user 事件走 pump 单点(kernel 归约→journal 行+WS 广播),不进模型上下文
  // (命令不调 appendInstructionLine,模型链零影响)
  s.pump({ type: 'user', text: line, ts: Date.now() });
  // 命令执行三态(2026-10-31 用户裁定「与工具行三态一致」):tool-call 行=执行中(波纹),tool-result
  // 行=完成/失败终态——同步命令不再只落孤立 notice;回执文本经 notice 捕获为结果载荷
  const callId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  s.pump({ type: 'tool-call', text: cmd, payload: { input: {}, callId, status: 'pending' }, ts: Date.now() });
  let resultText = '';
  const notice = (text: string): void => {
    resultText = text; // 捕获为工具结果载荷(不再单独落 notice——三态行即回执面)
  };
  // 命令中断(2026-10-31 用户裁定「命令运行态可中断,后台统一返回对应命令的中断信息」):中止信号
  // 挂 Session.commandAbort,interrupt 端点无 run 在途即中止命令;中断即刻落终态回执(命令名专属文案,
  // 灰色系统提示——用户主动止,非失败),命令体迟到结果不再二次落行;体内在 apply 前检查信号=零副作用回滚
  const ac = new AbortController();
  s.commandAbort = ac;
  let settled = false;
  const emitInterrupted = (): void => {
    if (settled) return;
    settled = true;
    s.pump({ type: 'tool-result', text: interruptedLabel(cmd), payload: { callId, status: 'completed', ok: true, interrupted: true }, ts: Date.now() });
  };
  ac.signal.addEventListener('abort', emitInterrupted, { once: true });
  try {
    const r = await runCommandBody(s, line, cmd, notice, ac.signal);
    if (!settled) {
      settled = true;
      s.pump({ type: 'tool-result', text: resultText, payload: { callId, status: 'completed', ok: true }, ts: Date.now() });
    }
    return r;
  } catch (err) {
    if (ac.signal.aborted) {
      emitInterrupted(); // 体内因信号抛出=中断收口(非失败),HTTP 面照常 ok
      return 'ok';
    }
    if (!settled) {
      settled = true;
      s.pump({
        type: 'tool-result',
        text: err instanceof Error ? err.message : String(err),
        payload: { callId, status: 'failed', ok: false },
        ts: Date.now(),
      });
    }
    throw err;
  } finally {
    ac.signal.removeEventListener('abort', emitInterrupted);
    if (s.commandAbort === ac) s.commandAbort = undefined;
  }
}

/** 命令中断文案(命令名专属;规范英文产出,GUI 模式表承载中文渲染) */
function interruptedLabel(cmd: string): string {
  if (cmd === '/compact') return 'Context compaction interrupted';
  if (cmd === '/plan') return 'Planning interrupted';
  return `${cmd} interrupted`;
}

/** 命令体(三态包装拆出):notice=结果捕获(不再旁路落 notice 行) */
async function runCommandBody(s: SessionRuntime, line: string, cmd: string, notice: (text: string) => void, signal?: AbortSignal): Promise<CommandRunResult> {

  if (cmd === '/status') {
    const snap = s.snapshotResponse();
    notice(`session ${s.id} · ${snap.status} · model ${snap.model ?? 'default'} · mode ${snap.mode}`);
    return 'ok';
  }

  if (cmd === '/compact') {
    // 压缩协调单点(与 Reactor 自动压缩同链路):补链参与 → 压缩 → 摘要 → 折链(TUI /compact 同形移植)
    // 过程回执先行(2026-10-31 用户裁定「发送后正文显示压缩中说明」):压缩成功才落完成回执,
    // 中途失败/中断无完成行=链面自动回滚语义(runCompaction apply 前零副作用)
    notice('Compacting context'); // 运行态由波纹承载,不用 … 标识(2026-10-31 裁定)
    const ctx = s.runtime.harness.context;
    const chainItems = chainToHistoryItems(ctx.chainView());
    const items = ctx.assemble(chainItems);
    const before = ctx.window.estimate(items).used;
    const focus = line.trim().split(/\s+/).slice(1).join(' ').trim();
    const r = await runCompaction(ctx, items, {
      summaryTokenBudget: 2000,
      rereadTokenBudget: 2000,
      chainFoldedCount: chainItems.length,
      summaryModel: s.runtime.harness.model,
      ...(focus.length > 0 ? { focus } : {}),
      ...(signal !== undefined ? { signal } : {}), // 中断信号:apply 前检查,中断即零副作用回滚
    });
    const after = ctx.window.estimate(ctx.assemble()).used;
    notice(`Compressed: ${r.chunks.length} summary chunks re-injected (ctx ${before} → ${after} tokens)`);
    return 'ok';
  }

  if (cmd === '/context') {
    // 上下文构成观测(只读零副作用):不经 assemble、不写链(TUI /context 同形移植)
    const ctx = s.runtime.harness.context;
    const parts = ctx.snapshotPartsView();
    const b = contextBreakdown({
      stableSegment: s.runtime.harness.stableSegment(),
      instructions: parts.instructions,
      skills: parts.skills,
      agents: parts.agents,
      teams: parts.teams,
      memory: parts.memory,
      compacted: ctx.compactedView(),
      chain: ctx.chainView(),
      window: resolveRunWindow(s.runtime.harness.model),
      chainFrom: ctx.chainFromView(),
    });
    notice(
      'Context breakdown' +
        ':\n' +
        b.parts.map((p) => `${p.id}: ${p.tokens} (${Math.round((p.tokens / Math.max(1, b.total)) * 100)}%)`).join('\n') +
        `\ntotal ${b.total} / ${b.window}`,
    );
    return 'ok';
  }

  if (cmd === '/memory-on' || cmd === '/memory-off') {
    const on = cmd === '/memory-on';
    setMemorySessionOverride(on); // 会话内覆盖单点(与 TUI 同一全局控制面;daemon 侧即全局生效)
    notice(`Persistent memory ${on ? 'on' : 'off'} for this session`);
    return 'ok';
  }

  if (cmd === '/archive') {
    const jid = s.attachedJournalId;
    if (jid === undefined) {
      notice('Nothing to archive yet');
      return 'ok';
    }
    markSessionArchived(resolveDataDir(s.root), jid, true);
    notice('Session archived');
    return 'ok';
  }
  if (cmd === '/unarchive') {
    // D40 裁决（2026-10-21）：/unarchive 底层命令，gui 命令通道同名支持——作用于当前附接会话；
    // 跨会话撤销走归档会话页（撤销钮同 markSessionArchived false 原语）
    const jid = s.attachedJournalId;
    if (jid === undefined) {
      notice('Nothing to unarchive yet');
      return 'ok';
    }
    const dataDir = resolveDataDir(s.root);
    if (readSessionMeta(dataDir, jid).archived !== true) {
      notice('Session is not archived');
      return 'ok';
    }
    markSessionArchived(dataDir, jid, false);
    notice('Session unarchived');
    return 'ok';
  }
  if (cmd === '/delete') {
    const jid = s.attachedJournalId;
    if (jid === undefined) {
      notice('Nothing to delete yet');
      return 'ok';
    }
    const dataDir = resolveDataDir(s.root);
    if (readSessionMeta(dataDir, jid).archived !== true) {
      notice('Archive first (/archive), then /delete');
      return 'ok';
    }
    // 序即正确性(终审 F2):notice 趁运行时在座广播(teardown 后 pump 只入快照不再外发)→ await
    // teardown(seal 落最后一笔)→ purgeSession——旧序 purge 在前,异步 teardown 的 seal 复活已清档
    notice('Session deleted');
    await s.teardown();
    purgeSession(dataDir, jid);
    purgeSideJournals(dataDir, jid); // 辅助会话档连带删除(2026-11-06 用户裁定:主删则 side 全家清)
    return 'ok';
  }

  if (cmd === '/skills-rm') {
    // 学习技能删除(2026-10-31,GUI 学习技能页签删除钮同源 removeLearnedSkill):/skills-rm <id>
    // 只作用于学习根(learnedSkillsDir(root)),project/user 用户资产不可达;TUI /skills-rm 同径
    const id = line.trim().split(/\s+/).slice(1).join(' ').trim();
    if (id.length === 0) {
      notice('Usage: /skills-rm <id> — remove a learned skill from this workspace');
      return 'ok';
    }
    const r = removeLearnedSkill(s.root, id);
    notice(r === 'ok' ? `Learned skill removed: ${id}` : `No learned skill '${id}' in this workspace`);
    return 'ok';
  }

  if (cmd === '/plan') {
    // 2026-11-03 无感化（ask_question 同构）：/plan=纯切档（武装）——任何状态可用、幂等、永不 busy。
    // 带目标分流：挂卡在途→中断弃卡+按新目标重新提交；run 在途（调研/普通任务）→入 steer 队列
    // （run 收口后经 arm 拦截自然转规划,不中断在途工作）；空闲→立即提交（read-only 覆盖+会话作用域 run）。
    // off=解除武装（run 在途先中断弃卡;空闲直接落 acceptEdits）
    const arg = line.trim().split(/\s+/).slice(1).join(' ').trim();
    if (arg === 'off') {
      if (!s.isPlanArmed()) {
        notice('Not in plan mode');
        return 'ok';
      }
      if (s.status() === 'running') await s.interrupt(); // 放弃在途(调研/挂卡阻塞)——回输入态
      if ((await s.setMode('acceptEdits')) !== 'ok') {
        notice('Busy — leave plan mode when the session is idle');
        return 'ok';
      }
      notice('Left plan mode');
      return 'ok';
    }
    const wasArmed = s.isPlanArmed();
    await s.setMode('plan'); // 武装快路径:恒 ok
    if (arg.length === 0) {
      notice(wasArmed ? 'Already in plan mode' : 'Plan mode on — submissions will be planned first');
      return 'ok';
    }
    if (s.hasPlanPending()) {
      // 挂卡期:新目标=放弃当前卡（拒绝回填+run 中断收尾）——abortAndSettle 单点承担「中断+deny 回填+
      // 有界 settle 等待」（teardown 同款锚点）,旧 run 收口后按新目标重新提交
      await s.abortAndSettle();
    }
    if (s.status() === 'running') {
      s.steer(arg);
      notice('Queued — planning will start when the current task finishes');
      return 'ok';
    }
    const r = s.submit(arg);
    return r.ok ? 'ok' : 'busy';
  }

  return 'unsupported';
}

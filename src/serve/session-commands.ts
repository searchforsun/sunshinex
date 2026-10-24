import { chainToHistoryItems, runCompaction, contextBreakdown } from '../harness/context';
import { resolveRunWindow } from '../config/termination-config';
import { setMemorySessionOverride } from '../config/memory-config';
import { resolveDataDir } from '../config/data-dir';
import { markSessionArchived, purgeSession, readSessionMeta } from '../tui/session-journal';
import { t } from '../i18n';
import type { SessionRuntime } from './session';

/** command 直跑通道(G10 spec §6):TUI handleSlash 分支的 daemon 移植层。
 *  纪律:操作共享 runtime 单点;纯函数(chainToHistoryItems/runCompaction/contextBreakdown)从
 *  harness/context 公开面直接 import——零复制;pushMsg → transcript.push(notice)。
 *  支持集按批扩:重流程分支(/init /goal /plan /skill /kb-index /memory-add /memory-gc /tasks)随
 *  planFlow 等共享化逐批入列,GET /commands 消费面置灰判定同步。 */

/** 当前通道支持集(gui 命令面板置灰判定源;随分支移植批扩) */
export const COMMAND_SUPPORT = ['/status', '/compact', '/context', '/memory-on', '/memory-off', '/archive', '/unarchive', '/delete', '/plan'] as const;

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
  // G14.95 notice 走 pump 单点(pump 已含 transcript 入列+WS 广播)——原只入快照不广播,
  // GUI 实时面看不到命令回执(压缩/状态等)
  const notice = (text: string): void => s.pump({ type: 'notice', text, ts: Date.now() });

  if (cmd === '/status') {
    const snap = s.snapshotResponse();
    notice(
      t(
        `session ${s.id} · ${snap.status} · model ${snap.model ?? 'default'} · mode ${snap.mode}`,
        `会话 ${s.id} · ${snap.status === 'running' ? '运行中' : '空闲'} · 模型 ${snap.model ?? '缺省主模型'} · 权限 ${snap.mode}`,
      ),
    );
    return 'ok';
  }

  if (cmd === '/compact') {
    // 压缩协调单点(与 Reactor 自动压缩同链路):补链参与 → 压缩 → 摘要 → 折链(TUI /compact 同形移植)
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
    });
    const after = ctx.window.estimate(ctx.assemble()).used;
    notice(
      t(
        `Compressed: ${r.chunks.length} summary chunks re-injected (ctx ${before} → ${after} tokens)`,
        `已压缩:${r.chunks.length} 个摘要块重注入(水位 ${before} → ${after} tokens)`,
      ),
    );
    return 'ok';
  }

  if (cmd === '/context') {
    // 上下文构成观测(只读零副作用):技能块走 peek 不消费、不经 assemble、不写链(TUI /context 同形移植)
    const ctx = s.runtime.harness.context;
    const parts = ctx.snapshotPartsView();
    const b = contextBreakdown({
      stableSegment: s.runtime.harness.stableSegment(),
      instructions: parts.instructions,
      skills: parts.skills,
      memory: parts.memory,
      compacted: ctx.compactedView(),
      chain: ctx.chainView(),
      skill: ctx.peekSkill(),
      window: resolveRunWindow(s.runtime.harness.model),
      chainFrom: ctx.chainFromView(),
    });
    notice(
      t('Context breakdown', '上下文构成') +
        ':\n' +
        b.parts.map((p) => `${p.id}: ${p.tokens} (${Math.round((p.tokens / Math.max(1, b.total)) * 100)}%)`).join('\n') +
        `\n${t('total', '总量')} ${b.total} / ${b.window}`,
    );
    return 'ok';
  }

  if (cmd === '/memory-on' || cmd === '/memory-off') {
    const on = cmd === '/memory-on';
    setMemorySessionOverride(on); // 会话内覆盖单点(与 TUI 同一全局控制面;daemon 侧即全局生效)
    notice(
      t(
        `Persistent memory ${on ? 'on' : 'off'} for this session`,
        `本会话持久记忆已${on ? '开启' : '关闭'}`,
      ),
    );
    return 'ok';
  }

  if (cmd === '/archive') {
    const jid = s.attachedJournalId;
    if (jid === undefined) {
      notice(t('Nothing to archive yet', '暂无可归档的会话档'));
      return 'ok';
    }
    markSessionArchived(resolveDataDir(s.root), jid, true);
    notice(t('Session archived', '已归档'));
    return 'ok';
  }
  if (cmd === '/unarchive') {
    // D40 裁决（2026-10-21）：/unarchive 底层命令，gui 命令通道同名支持——作用于当前附接会话；
    // 跨会话撤销走归档会话页（撤销钮同 markSessionArchived false 原语）
    const jid = s.attachedJournalId;
    if (jid === undefined) {
      notice(t('Nothing to unarchive yet', '暂无可撤销归档的会话档'));
      return 'ok';
    }
    const dataDir = resolveDataDir(s.root);
    if (readSessionMeta(dataDir, jid).archived !== true) {
      notice(t('Session is not archived', '该会话未在归档中'));
      return 'ok';
    }
    markSessionArchived(dataDir, jid, false);
    notice(t('Session unarchived', '已撤销归档'));
    return 'ok';
  }
  if (cmd === '/delete') {
    const jid = s.attachedJournalId;
    if (jid === undefined) {
      notice(t('Nothing to delete yet', '暂无可删除的会话档'));
      return 'ok';
    }
    const dataDir = resolveDataDir(s.root);
    if (readSessionMeta(dataDir, jid).archived !== true) {
      notice(t('Archive first (/archive), then /delete', '先归档（/archive）再删除'));
      return 'ok';
    }
    // 序即正确性(终审 F2):notice 趁运行时在座广播(teardown 后 pump 只入快照不再外发)→ await
    // teardown(seal 落最后一笔)→ purgeSession——旧序 purge 在前,异步 teardown 的 seal 复活已清档
    notice(t('Session deleted', '已删除'));
    await s.teardown();
    purgeSession(dataDir, jid);
    return 'ok';
  }

  if (cmd === '/plan') {
    // plan-arm（阶段三 spec §5.1）：/plan <目标> = 单选 plan 档(armed)+提交——submit 入口拦截转
    // planFlow(TUI /plan 同构:规划→确认卡→批准落档→逐项执行)。档位切换 busy(运行中)/提交 409
    // (流程在途)统一 busy 面归 HTTP 409;裸 /plan(缺目标)=只武装不提交(TUI 用法提示同构——后续
    // 空闲提交经 armed 拦截自然进入规划流程)
    // setMode 异步化(终审修复:disarm 收口)后武装位照常 await——arm 至 plan 不触收口(同档幂等/无流程即直落)
    if ((await s.setMode('plan')) !== 'ok') return 'busy';
    const goal = line.trim().split(/\s+/).slice(1).join(' ').trim();
    if (goal.length === 0) {
      notice(
        t(
          'Usage: /plan <goal> — plan numbered steps first, confirm, then execute step by step',
          '用法：/plan <目标>——先规划产出编号步骤，确认后逐项执行',
        ),
      );
      return 'ok';
    }
    const r = s.submit(goal);
    return r.ok ? 'ok' : 'busy';
  }

  return 'unsupported';
}

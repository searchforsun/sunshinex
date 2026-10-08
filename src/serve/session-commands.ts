import { chainToHistoryItems, runCompaction, contextBreakdown } from '../harness/context';
import { resolveRunWindow } from '../config/termination-config';
import { setMemorySessionOverride } from '../config/memory-config';
import { t } from '../i18n';
import type { SessionRuntime } from './session';

/** command 直跑通道(G10 spec §6):TUI handleSlash 分支的 daemon 移植层。
 *  纪律:操作共享 runtime 单点;纯函数(chainToHistoryItems/runCompaction/contextBreakdown)从
 *  harness/context 公开面直接 import——零复制;pushMsg → transcript.push(notice)。
 *  支持集按批扩:重流程分支(/init /goal /plan /skill /kb-index /memory-add /memory-gc /tasks)随
 *  planFlow 等共享化逐批入列,GET /commands 消费面置灰判定同步。 */

/** 当前通道支持集(gui 命令面板置灰判定源;随分支移植批扩) */
export const COMMAND_SUPPORT = ['/status', '/compact', '/context', '/memory-on', '/memory-off'] as const;

export type CommandRunResult = 'ok' | 'unsupported' | 'busy';

const IDLE_ONLY = new Set(['/compact']);

export function isCommandSupported(line: string): boolean {
  return (COMMAND_SUPPORT as readonly string[]).includes(line.split(/\s/)[0] ?? '');
}

export async function runCommand(s: SessionRuntime, line: string): Promise<CommandRunResult> {
  const cmd = line.split(/\s/)[0] ?? '';
  if (!isCommandSupported(line)) return 'unsupported';
  if (IDLE_ONLY.has(cmd) && s.status() !== 'idle') return 'busy';
  const collector = s.transcript;
  const notice = (text: string): void => collector.push({ type: 'notice', text, ts: Date.now() });

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
      stableSegment: s.runtime.harness.reactor.stableSegment(),
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

  return 'unsupported';
}

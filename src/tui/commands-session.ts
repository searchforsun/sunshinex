import * as fs from 'fs';
import * as path from 'path';
import { t } from '../i18n';
import { resolveDataDir } from '../config/data-dir';
import { listSessions, parseJournalFile, reduceJournal, listAnchors, branchFrom, sessionsDir, type SessionMeta } from './session-journal';
import { collectRestorePlan, applyRestorePlan } from './session-snapshots';
import type { SessionController } from './session';

// D17 拆分件步3（docs/TECH-DEBT-SURVEY.md H1）：会话谱系命令族（resume/rewind/fork/branchFlow 一族）迁出；
// 恢复三面直注入逻辑随族走，SessionController 保留 resumeLatest 公开薄委托（构造器 --continue 消费）。

/** 会话恢复选择卡（/resume 与 --resume 启动共用单点）：mtime 降序候选（排除当前在飞会话）→ askUser 挂起 → restoreFromSession */
export async function resumeFlow(ctrl: SessionController): Promise<void> {
  const dataDir = resolveDataDir(ctrl.root);
  // /resume 候选排除当前在飞会话（事件级落盘：命令输入自身即时建档，不排除会把本次命令的自建档选为最新恢复目标）
  const currentId = ctrl.journal?.currentId;
  const sessions = listSessions(dataDir).filter((s) => s.id !== currentId);
  if (sessions.length === 0) {
    ctrl.pushMsg('system', t('No saved sessions yet', '暂无已保存会话'), { level: 'warn' });
    return;
  }
  // >8 项切 filterable 卡（规格 D6/D8）：全量直出、渲染层筛选，一次问询直达；≤8 项维持既有循环形态不变
  if (sessions.length > 8) {
    const items = sessions.map((s) => ({ label: s.id, description: s.firstUser ? s.firstUser.slice(0, 60) : t('(no user input)', '（无用户输入）') }));
    const answer = await ctrl.askUser({
      question: t('Resume which session? (type to filter)', '恢复哪个会话？（输入即筛选）'),
      options: items,
      filterable: true,
    });
    if (answer.type !== 'selected') {
      ctrl.pushMsg('system', t('Resume cancelled', '已取消恢复'));
      return;
    }
    const pick = sessions.find((s) => s.id === answer.labels[0]);
    if (!pick) {
      ctrl.pushMsg('system', t('No such session: ' + (answer.labels[0] ?? ''), '没有这个会话：' + (answer.labels[0] ?? '')), { level: 'warn' });
      return;
    }
    await restoreOrFork(ctrl, pick);
    return;
  }
  // ≤8 档全量直出（2026-09-30 翻页口径统一：滑窗自动翻页由渲染层承载，More…/Back… 循环退役）
  const answer = await ctrl.askUser({
    question: t('Resume which session?', '恢复哪个会话？'),
    options: sessions.map((s) => ({ label: s.id, description: s.firstUser ? s.firstUser.slice(0, 60) : t('(no user input)', '（无用户输入）') })),
  });
  if (answer.type === 'dismissed') {
    ctrl.pushMsg('system', t('Resume cancelled', '已取消恢复'));
    return;
  }
  const pickedId = answer.type === 'custom' ? answer.text.trim() : (answer.labels[0] ?? '');
  const pick = sessions.find((s) => s.id === pickedId);
  if (!pick) {
    ctrl.pushMsg('system', t('No such session: ' + pickedId, '没有这个会话：' + pickedId), { level: 'warn' });
    return;
  }
  await restoreOrFork(ctrl, pick);
}

/** --continue（规格 D1/D3）：续接最近会话（listSessions mtime 降序首项，对标 CC -c）；无档提示后按新会话继续（不静默吞） */
export function resumeLatest(ctrl: SessionController): void {
  const dataDir = resolveDataDir(ctrl.root);
  const meta = listSessions(dataDir)[0];
  if (!meta) {
    ctrl.pushMsg('system', t('No saved session to continue; started a fresh one', '没有可续接的已保存会话，已开启新会话'), { level: 'warn' });
    return;
  }
  restoreFromSession(ctrl, meta);
}

/** 恢复会话（规格 §6 恢复三面）：flush 当前 → 解析目标日志 → 版本守卫 → 三面直注入 → journal 续挂目标档 */
function restoreFromSession(ctrl: SessionController, meta: SessionMeta): void {
  const parsed = parseJournalFile(meta.file);
  const replay = reduceJournal(parsed.events);
  if (replay.version !== 1) {
    ctrl.pushMsg('system', t('Cannot restore this session: unsupported journal version', '无法恢复该会话：日志版本不受支持'), { level: 'error' });
    return;
  }
  // 三面还原（直注入不经 pushMsg/订阅——零重复入志、零前缀击穿）：链/压缩归 ContextManager；消息/待办/档位归控制器；UI 现场暂存供 entry 播种
  ctrl.runtime.harness.context.restoreSession({ chain: replay.chain, chainFrom: replay.chainFrom, compacted: replay.compacted });
  ctrl.msgSeq = replay.nextSeq;
  // 模型选择还原（/model）：档内 modelId 事件末值即目标态（undefined = 回缺省主模型，内芯一并复位）；
  // 配置漂移（id 已不在清单）保持当前不硬切、告警行随状态注入后上屏（注入前 push 会被 replay.messages 吞掉）
  let modelDriftWarn: string | undefined;
  let restoredModelId: string | undefined;
  if (ctrl.modelSwitcher) {
    const ok = ctrl.modelSwitcher.switchTo(replay.modelId);
    restoredModelId = ctrl.modelSwitcher.currentId();
    if (!ok) modelDriftWarn = t(`Saved model "${replay.modelId}" is no longer in settings.json providers; keeping the current model`, `存档模型「${replay.modelId}」已不在 settings.json providers 清单，保持当前模型`);
  }
  ctrl.state = {
    ...ctrl.state,
    messages: replay.messages,
    todos: replay.todos,
    status: 'idle',
    ...(replay.tier !== undefined ? { tier: replay.tier } : {}),
    ...(replay.effort !== undefined ? { effort: replay.effort } : {}),
    ...(restoredModelId !== undefined
      ? { modelId: restoredModelId, modelLabel: ctrl.modelSwitcher!.label, ...(ctrl.modelSwitcher!.contextWindow !== undefined ? { modelWindow: ctrl.modelSwitcher!.contextWindow } : { modelWindow: undefined }) }
      : { modelId: undefined, modelLabel: undefined, modelWindow: undefined }),
    approval: undefined,
    live: undefined,
    children: [],
    delegations: [],
    // 板投影重播种自工作区真相源(harness 任务板快照):任务板是工作区级状态,不随会话恢复清空
    board: ctrl.runtime.harness.taskboard.snapshot(),
  };
  ctrl.restoredUi = { history: replay.history, expandAll: replay.view.expandAll, latestFull: replay.view.latestFull };
  ctrl.ensureJournal().attach(meta.id);
  // 模型配置漂移告警（状态注入后上屏，防被 replay.messages 吞掉）
  if (modelDriftWarn !== undefined) ctrl.pushMsg('system', modelDriftWarn, { level: 'warn' });
  // 横幅在状态注入后上屏（注入前 push 会被 messages 覆盖吞掉）；撕裂场景合并提示，保持「消息 + 单条提示行」
  if (parsed.truncated) {
    ctrl.pushMsg('system', t('Session restored: ' + meta.id + ' — journal tail was truncated (previous crash?); restored up to the last complete event', '已恢复会话：' + meta.id + '（日志尾部截断，此前可能异常退出；已恢复到最后一条完整事件）'), { level: 'warn' });
  } else {
    ctrl.pushMsg('system', t('Session restored: ' + meta.id, '已恢复会话：' + meta.id));
  }
}

/** /resume 选中后二级动作卡（rewind/fork 规格 §7.2 入口 B）：restore=现行恢复路径；Fork from…=branchFlow 显式源分档——可从任意历史会话分叉，目标无需是当前会话。
 *  不走「先 restore 源会话再 branch」：事件级落盘下中间 restore 会把横幅行追加进源档（违背 §7.2 源会话原地保留）并污染分档前缀 */
async function restoreOrFork(ctrl: SessionController, pick: SessionMeta): Promise<void> {
  const mode = await ctrl.askUser({
    question: t('Restore this session, or fork from it?', '恢复该会话，还是从它分叉？'),
    options: [{ label: 'restore' }, { label: 'Fork from…' }],
  });
  if (mode.type === 'dismissed') {
    ctrl.pushMsg('system', t('Resume cancelled', '已取消恢复'));
    return;
  }
  const mpick = mode.type === 'custom' ? mode.text.trim() : (mode.labels[0] ?? '');
  if (mpick === 'Fork from…') {
    await branchFlow(ctrl, 'fork', pick);
    return;
  }
  restoreFromSession(ctrl, pick);
}

/** /rewind //fork 共用分支流程（rewind/fork 规格 §7）：锚点选择 → 分档 → 装载 → 代码回退（可选）→ 回执 + 输入回填；
 *  source 缺省=当前会话（/rewind //fork 斜杠入口），显式传入=/resume Fork from… 的任意历史会话（§7.2 入口 B） */
export async function branchFlow(ctrl: SessionController, kind: 'rewind' | 'fork', source?: SessionMeta): Promise<void> {
  const dataDir = resolveDataDir(ctrl.root);
  const srcId = source?.id ?? ctrl.journal?.currentId;
  const srcFile = srcId ? path.join(sessionsDir(dataDir), srcId + '.jsonl') : undefined;
  if (!srcId || !srcFile || !fs.existsSync(srcFile)) {
    ctrl.pushMsg('system', t(kind === 'rewind' ? 'No journaled session to rewind' : 'No journaled session to fork', kind === 'rewind' ? '当前会话没有可回退的日志' : '当前会话没有可分叉的日志'), { level: 'warn' });
    return;
  }
  const parsed = parseJournalFile(srcFile);
  const anchors = listAnchors(parsed);
  if (anchors.length === 0) {
    ctrl.pushMsg('system', t(kind === 'rewind' ? 'No turns to rewind yet' : 'No turns to fork yet', kind === 'rewind' ? '暂无可回退的任务轮' : '暂无可分叉的任务轮'), { level: 'warn' });
    return;
  }
  const a = await ctrl.askUser({
    question: t(kind === 'rewind' ? 'Rewind to which turn?' : 'Fork from which turn?', kind === 'rewind' ? '回退到哪一轮？' : '从哪一轮分叉？'),
    options: anchors.map((x, i) => ({
      label: String(i + 1),
      description: x.text.length > 48 ? x.text.slice(0, 48) + '…' : x.text,
    })),
  });
  if (a.type === 'dismissed') {
    ctrl.pushMsg('system', t(kind === 'rewind' ? 'Rewind cancelled' : 'Fork cancelled', kind === 'rewind' ? '已取消回退' : '已取消分叉'));
    return;
  }
  const idx = Number.parseInt(a.type === 'custom' ? a.text.trim() : (a.labels[0] ?? ''), 10) - 1;
  const anchor = Number.isInteger(idx) && idx >= 0 && idx < anchors.length ? anchors[idx] : undefined;
  if (!anchor) {
    ctrl.pushMsg('system', t('No such turn', '没有这一轮'), { level: 'warn' });
    return;
  }
  let codeAction = false;
  if (kind === 'rewind') {
    const hasFiles = collectRestorePlan(srcFile, anchor.line).length > 0;
    const opts = hasFiles ? ['code and conversation', 'conversation only', 'code only'] : ['conversation only'];
    const b = await ctrl.askUser({
      question: t('What to restore?', '恢复哪些内容？'),
      options: opts.map((label) => ({ label })),
    });
    if (b.type === 'dismissed') {
      ctrl.pushMsg('system', t('Rewind cancelled', '已取消回退'));
      return;
    }
    const picked = b.type === 'custom' ? b.text.trim() : (b.labels[0] ?? '');
    if (picked === 'code and conversation' || picked === 'code only') codeAction = true;
  } else {
    const c = await ctrl.askUser({
      question: t('Fork a parallel session from this turn?', '从这一轮分叉出平行会话？'),
      options: [{ label: 'fork' }],
    });
    if (c.type === 'dismissed') {
      ctrl.pushMsg('system', t('Fork cancelled', '已取消分叉'));
      return;
    }
  }
  let newId: string;
  try {
    newId = branchFrom(dataDir, srcId, anchor.line - 1, kind); // 锚点行不进新档（规格 §5.2）
  } catch (err) {
    ctrl.pushMsg('system', t('Branch failed: ' + String((err as Error).message), '分档失败：' + String((err as Error).message)), { level: 'warn' });
    return;
  }
  // 续挂新档并切指针（不可变分档：源档零改动；事件级落盘下 restore 无收口写回面）
  ctrl.journal?.attach(newId);
  restoreFromSession(ctrl, { id: newId, file: path.join(sessionsDir(dataDir), newId + '.jsonl'), updatedAt: Date.now() });
  if (kind === 'rewind' && codeAction) {
    const plan = collectRestorePlan(srcFile, anchor.line); // 以分支前源档收集（规格 §6.2）
    const r = applyRestorePlan(ctrl.root, plan, path.join(dataDir, 'sessions', '_blobs'));
    const parts = [
      r.restored.length > 0 ? `${r.restored.length} restored` : '',
      r.removed.length > 0 ? `${r.removed.length} removed` : '',
      r.skipped.length > 0 ? `${r.skipped.length} skipped` : '',
    ].filter(Boolean).join(', ');
    ctrl.pushMsg('system', t('Code restored to turn start (' + parts + ')', '代码已回退到该轮起点（' + parts + '）'), r.skipped.length > 0 ? { level: 'warn' } : undefined);
  }
  const anchorIdx = anchors.indexOf(anchor) + 1;
  if (kind === 'rewind') {
    ctrl.pushMsg('system', t(`Rewound to turn ${anchorIdx} — previous timeline kept, /resume to return`, `已回退到第 ${anchorIdx} 轮——原时间线保留，/resume 可回`));
  } else {
    ctrl.pushMsg('system', t(`Forked new session from turn ${anchorIdx} — source session kept`, `已从第 ${anchorIdx} 轮分叉出新会话——源会话保留`));
  }
  ctrl.state = { ...ctrl.state, backfill: anchor.text }; // 锚点轮输入回填（重发经正常任务提交进链）
  ctrl.notify();
}

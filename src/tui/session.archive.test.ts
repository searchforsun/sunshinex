import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { readSessionMeta, sessionsDir } from './session-journal';
import { resolveDataDir } from '../config/data-dir';

test('/archive:/delete 门禁与真清(TUI)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-archcmd-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const jid = ctrl.journal?.currentId as string;
    const dataDir = resolveDataDir(tmp);

    await ctrl.submit('/delete');
    assert.equal(readSessionMeta(dataDir, jid).archived, undefined, '未归档 /delete 拒绝且档还在');
    assert.ok(fs.existsSync(path.join(sessionsDir(dataDir), `${jid}.jsonl`)), '档未被清');

    await ctrl.submit('/archive');
    assert.equal(readSessionMeta(dataDir, jid).archived, true, '/archive 打标');

    await ctrl.submit('/delete');
    assert.equal(fs.existsSync(path.join(sessionsDir(dataDir), `${jid}.jsonl`)), false, '归档态 /delete 真清');
    assert.equal(ctrl.journal?.currentId !== undefined && ctrl.journal.currentId !== jid, true, '已软重置到新会话档');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/unarchive 选择卡撤销归档;TUI /resume 滤归档（D40 裁决：选择卡=撤销通道，滤除后撤销即可见于 /resume）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-unarch-'));
  const prev = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    // jid1：将被归档的会话；ctrl1 /new 轮转到 jid1b（非归档可见面，供 /resume 有候选）
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl1.submit('造档任务');
    await ctrl1.waitIdle();
    const jid1 = ctrl1.journal?.currentId as string;
    await ctrl1.submit('/archive');
    assert.equal(readSessionMeta(resolveDataDir(tmp), jid1).archived, true, '前置：jid1 已归档');
    await ctrl1.submit('/new');
    const jid1b = ctrl1.journal?.currentId as string;
    assert.notEqual(jid1b, jid1, '前置：/new 轮转出新档');

    // ctrl2：独立会话 jid2（当前会话被 /resume 排除的口径不干扰三会话结构）
    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"忽略"}']) });
    await ctrl2.submit('另一会话');
    await ctrl2.waitIdle();

    // TUI /resume 滤归档：选择卡不出现 jid1（归档），其余可见（jid1b；jid2 为当前被排除）
    // 选择卡挂起期间 submit 不返回——挂起类命令一律不 await，waitFor 应答状态
    void ctrl2.submit('/resume');
    await waitFor(() => ctrl2.getState().status === 'awaiting-question');
    const resumeLabels = ctrl2.getState().question?.options.map((o) => o.label) ?? [];
    assert.ok(!resumeLabels.includes(jid1), '/resume 选择卡不列归档会话');
    assert.ok(resumeLabels.includes(jid1b), '未归档会话照常在卡');
    ctrl2.resolveAskAnswer({ type: 'dismissed' });
    await waitFor(() => ctrl2.getState().status === 'idle');

    // /unarchive 选择卡：归档会话入卡，选中即撤销（meta 翻回，不切会话）
    void ctrl2.submit('/unarchive');
    await waitFor(() => ctrl2.getState().status === 'awaiting-question');
    assert.deepEqual(ctrl2.getState().question?.options.map((o) => o.label) ?? [], [jid1], '选择卡列出归档会话');
    ctrl2.resolveAskAnswer({ type: 'selected', labels: [jid1] });
    await waitFor(() => ctrl2.getState().status === 'idle');
    assert.equal(readSessionMeta(resolveDataDir(tmp), jid1).archived, undefined, '选中后归档标记移除（撤销）');

    // 撤销后 /resume 复见（滤除通道闭环：归档→不可见→撤销→复见）
    void ctrl2.submit('/resume');
    await waitFor(() => ctrl2.getState().status === 'awaiting-question');
    assert.ok((ctrl2.getState().question?.options.map((o) => o.label) ?? []).includes(jid1), '撤销后 /resume 复见该会话');
    ctrl2.resolveAskAnswer({ type: 'dismissed' });
    await waitFor(() => ctrl2.getState().status === 'idle');

    // 空归档面：/unarchive 无归档会话时提示不开卡（早退路径，submit 可 await）
    await ctrl2.submit('/unarchive');
    await waitFor(() => ctrl2.getState().status === 'idle');
    assert.match(messageTexts(ctrl2), /No archived sessions|暂无归档会话/, '无归档会话提示不开卡（双语容忍，D37 正解）');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function messageTexts(ctrl: SessionController): string {
  return ctrl.getState().messages.map((m) => m.text).join('\n');
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), 'waitFor 超时');
}

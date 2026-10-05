/** T2(P2 spec §5):send_message 双面工具——校验(to 白名单/text 非空≤4000)→ FileInbox 落盘 →
 *  agent-message 事件 → 回执文案;from()/knownRecipients() 注入器经闭包生效;teammate 派生面注册断言。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileInbox } from './file-inbox';
import { makeSendMessageTool } from './message-tools';
import { deriveTeammateRegistry } from './teammate-tools';
import { CodedToolError, RegisteredTool, ToolRegistry } from '../harness/tools';
import { TASKBOARD_TOOL_NAMES } from '../harness/tools/taskboard-tools';
import { SPAWN_TOOL_NAME } from '../harness/subagent';
import { TaskBoard } from './board';
import { TeamStore } from './store';
import { SessionEvent } from '../types';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function isInvalidArg(e: unknown): e is CodedToolError {
  return e instanceof CodedToolError && e.code === 'INVALID_ARG';
}

test('合法投递:落盘 jsonl(from/to/text)+ 事件载荷 deepEqual + 回执文案 + from() 注入器闭包计数', async () => {
  const tmp = tmpdir('sunshinex-tb-msgtool-1-');
  try {
    const inbox = new FileInbox(path.join(tmp, 'inbox'));
    const events: SessionEvent[] = [];
    let fromCalls = 0;
    const tool = makeSendMessageTool({
      inbox,
      onEvent: (e) => events.push(e),
      knownRecipients: () => ['w1', 'w2'],
      from: () => {
        fromCalls += 1;
        return 'lead';
      },
    });
    assert.equal(tool.name, 'send_message');
    assert.equal(tool.category, 'task');
    const out = (await tool.executor({ to: 'w1', text: 'hi' })) as { stdout: string };
    assert.match(out.stdout, /^message m1 delivered to w1$/, '回执文案 message <id> delivered to <to>');
    assert.equal(fromCalls, 1, 'from() 注入器每次投递求值一次(闭包计数生效)');
    // 事件载荷逐字段(与落档记录同源):messageId/from/to/text,ts 取消息 ts
    assert.equal(events.length, 1);
    const ev = events[0]!;
    assert.equal(ev.type, 'agent-message');
    assert.deepEqual(ev.payload, { messageId: 'm1', from: 'lead', to: 'w1', text: 'hi' });
    // 文件落盘:读 jsonl 断言 from/to/text,ts 与事件一致
    const raw = fs.readFileSync(path.join(tmp, 'inbox', 'w1.jsonl'), 'utf8').trim().split('\n');
    assert.equal(raw.length, 1);
    const rec = JSON.parse(raw[0]!) as { id: string; from: string; to: string; text: string; ts: number };
    assert.deepEqual([rec.id, rec.from, rec.to, rec.text], ['m1', 'lead', 'w1', 'hi']);
    assert.equal(ev.ts, rec.ts, '事件 ts 与落档消息 ts 同源');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('to 校验:未知收件人拒(INVALID_ARG,含活名单文案);lead 恒可达', async () => {
  const tmp = tmpdir('sunshinex-tb-msgtool-2-');
  try {
    const inbox = new FileInbox(path.join(tmp, 'inbox'));
    const events: SessionEvent[] = [];
    const tool = makeSendMessageTool({ inbox, onEvent: (e) => events.push(e), knownRecipients: () => ['w1', 'w2'], from: () => 'lead' });
    await assert.rejects(
      tool.executor({ to: 'ghost', text: 'hi' }),
      (e: unknown) => isInvalidArg(e) && e.message.includes('unknown recipient: ghost') && e.message.includes('live: lead, w1, w2'),
      '未知 to 应 INVALID_ARG 且文案含活名单',
    );
    // lead 直达(knownRecipients 不含 lead 也合法——'lead' 恒可达)
    const out = (await tool.executor({ to: 'lead', text: 'to main' })) as { stdout: string };
    assert.match(out.stdout, /delivered to lead/);
    assert.equal(events.length, 1, '被拒调用不产生事件');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('text 校验:空文本拒、4001 超长拒(≤4000 合法)', async () => {
  const tmp = tmpdir('sunshinex-tb-msgtool-3-');
  try {
    const inbox = new FileInbox(path.join(tmp, 'inbox'));
    const tool = makeSendMessageTool({ inbox, knownRecipients: () => ['w1'], from: () => 'lead' });
    await assert.rejects(tool.executor({ to: 'w1', text: '' }), isInvalidArg, '空 text 拒');
    await assert.rejects(tool.executor({ to: 'w1', text: 'x'.repeat(4001) }), isInvalidArg, '4001 字符超长拒');
    const out = (await tool.executor({ to: 'w1', text: 'y'.repeat(4000) })) as { stdout: string };
    assert.match(out.stdout, /delivered to w1/, '恰 4000 字符合法');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('teammate 面:deriveTeammateRegistry(base, board, team, tool) → send_message/get_board/get_task 在场、五件套不在场;排己 knownRecipients 闭包拒自发', async () => {
  const tmp = tmpdir('sunshinex-tb-msgtool-4-');
  try {
    const base = new ToolRegistry();
    const dummy = (name: string): RegisteredTool => ({
      name,
      description: `dummy ${name}`,
      parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
      category: 'read',
      executor: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    });
    for (const name of [SPAWN_TOOL_NAME, 'todo_write', 'ask_question', 'worktree', ...TASKBOARD_TOOL_NAMES]) base.register(dummy(name));
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner: {} as never,
      registry: {} as never,
    });
    const team = { aliveNames: () => ['w1', 'w2', 'w3'] };
    const inbox = new FileInbox(path.join(tmp, 'inbox'));
    // teammate 面 knownRecipients(harness registryFactory 同款):lead + 其余活名(排己)
    const msgTool = makeSendMessageTool({
      inbox,
      knownRecipients: () => ['lead', ...team.aliveNames().filter((n) => n !== 'w2')],
      from: () => 'w2',
    });
    const face = deriveTeammateRegistry(base, board, team, msgTool);
    assert.ok(face.get('send_message') !== undefined, 'teammate 面应含 send_message');
    assert.ok(face.get('get_board') !== undefined, 'teammate 面应含 get_board');
    assert.ok(face.get('get_task') !== undefined, 'teammate 面应含 get_task');
    for (const name of [SPAWN_TOOL_NAME, 'todo_write', 'ask_question', 'worktree', ...TASKBOARD_TOOL_NAMES]) {
      assert.equal(face.get(name), undefined, `teammate 面不得含 ${name}`);
    }
    // 排己:自发(to=自己)不在白名单 → INVALID_ARG
    await assert.rejects(
      msgTool.executor({ to: 'w2', text: 'self' }),
      (e: unknown) => isInvalidArg(e) && e.message.includes('unknown recipient: w2'),
      'teammate 面不得给自己发消息',
    );
    // teammate 面发给 lead/他队友合法,from 注入为 teammate 名
    const out = (await msgTool.executor({ to: 'lead', text: 'report' })) as { stdout: string };
    assert.match(out.stdout, /delivered to lead/);
    const rec = JSON.parse(fs.readFileSync(path.join(tmp, 'inbox', 'lead.jsonl'), 'utf8').trim()) as { from: string };
    assert.equal(rec.from, 'w2', '落档 from 来自注入器(teammate 名)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

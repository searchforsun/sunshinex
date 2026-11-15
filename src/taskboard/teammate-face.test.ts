import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deriveTeammateRegistry } from './teammate-tools';
import { RegisteredTool, ToolRegistry } from '../harness/tools';
import { TaskBoard } from './board';
import { TeamStore } from './store';
import type { AskUserRequest, AskUserSeam } from '../types';

/** teammate face 路由 ask（2026-11-15 sunx P2 Task 1，形态对齐 fork deriveChildRegistry/subagent.ask-route）：
 *  ask 接缝在场 → 注册路由版 ask_question（askedBy={label:成员名, taskId:板任务 id} 归因直通主对话挂起卡）；
 *  ask 缺席（headless 装配）→ 维持剔除旧制（成员不中途发问，结论回写即应答）。剔除族其余不动。 */

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function dummy(name: string): RegisteredTool {
  return {
    name,
    description: `dummy ${name}`,
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    category: 'read',
    executor: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
  };
}

function makeBoard(tmp: string): TaskBoard {
  return new TaskBoard({ store: new TeamStore(path.join(tmp, 'teams', 'main')), registry: {} as never });
}

describe('teammate face 路由 ask（P2 Task 1）', () => {
  test('ask 接缝在场 + askedBy：ask_question 在册且归因（label/taskId）随请求透传父接缝', async () => {
    const tmp = tmpdir('sunshinex-tmface-1-');
    try {
      const base = new ToolRegistry();
      base.register(dummy('ask_question'));
      base.register(dummy('spawn'));
      const board = makeBoard(tmp);
      const seen: AskUserRequest[] = [];
      const parent: AskUserSeam = async (req) => {
        seen.push(req);
        throw new Error('stop-here');
      };
      const face = deriveTeammateRegistry(base, board, { ask: parent, askedBy: { label: 'w1', taskId: 'task-1' } });
      const ask = face.get('ask_question');
      assert.ok(ask, '路由版 ask_question 应在 teammate 面（无条件剔除已放开）');
      await assert.rejects(ask.executor({ question: '选哪个?', options: [{ label: 'A' }, { label: 'B' }] }), /stop-here/);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0].askedBy, { label: 'w1', taskId: 'task-1' }, '归因=成员名+板任务 id（Task 2 板通道直接复用形态）');
      assert.deepEqual(seen[0].options.map((o) => o.label), ['A', 'B'], '问询本体字段原样透传');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('ask 接缝缺席（headless 装配）：ask_question 不在册=剔除旧制', () => {
    const tmp = tmpdir('sunshinex-tmface-2-');
    try {
      const base = new ToolRegistry();
      base.register(dummy('ask_question'));
      const face = deriveTeammateRegistry(base, makeBoard(tmp));
      assert.equal(face.get('ask_question'), undefined, 'ask 缺席维持旧制（结论回写即应答）');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('ask 接缝在场但未传归因：同样不在册（fork 派生第三例同构）', () => {
    const tmp = tmpdir('sunshinex-tmface-3-');
    try {
      const base = new ToolRegistry();
      base.register(dummy('ask_question'));
      const face = deriveTeammateRegistry(base, makeBoard(tmp), { ask: async () => ({ type: 'dismissed' }) });
      assert.equal(face.get('ask_question'), undefined, '归因缺席不注册（无归因路由=身份悬空）');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

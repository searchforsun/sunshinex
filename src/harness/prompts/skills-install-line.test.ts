import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Reactor } from '../reactor';
import { ScriptedAdapter } from '../../model/adapter';
import type { ModelAdapter } from '../../model/adapter';
import type { ChatRequest } from '../../types';
import { SKILLS_INSTALL_LINE } from './shared';
import { builtinTools } from '../tools/builtin';
import { ToolRegistry } from '../tools';
import { ContextManager } from '../context';
import { FileStore } from '../../storage/adapter';
import { PolicyEngine } from '../security/policy';
import { SecurityGuard } from '../security/guard';
import { ProcessSandbox } from '../security/sandbox';
import { DryRun } from '../security/dryrun';
import { SafetyChain } from '../security/chain';

/** §11 回归：技能安装政策行进稳定段——首步即在，相邻步逐字节不变（差异只允许落在尾部新增段） */

const DONE = '{"done":true,"reply":"ok"}';

test('稳定段携带 SKILLS_INSTALL_LINE 且相邻步前缀逐字节稳定', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-skills-line-'));
  try {
    const store = new FileStore(path.join(tmp, '.data'));
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
    const registry = new ToolRegistry();
    for (const t of builtinTools(safety, tmp)) registry.register(t);
    const context = new ContextManager(tmp, store);
    const requests: ChatRequest[] = [];
    const base = new ScriptedAdapter([DONE]);
    const capture: ModelAdapter = {
      provider: base.provider,
      chat: async (req, hooks) => {
        requests.push(req);
        return base.chat(req, hooks);
      },
    };
    const reactor = new Reactor({ registry, safety, context, model: capture });
    const r = await reactor.run({ goal: '技能安装行回归' }, { maxSteps: 3 });
    assert.equal(r.done, true);
    const first = requests[0].messages[0]?.content ?? '';
    assert.ok(first.includes(SKILLS_INSTALL_LINE), '首步稳定段必须逐字节包含 SKILLS_INSTALL_LINE');
    assert.ok(!SKILLS_INSTALL_LINE.match(/[\u4e00-\u9fff]/), '政策行为英文单语（提示词恒英文）');
    if (requests.length > 1) {
      const second = requests[1].messages[0]?.content ?? '';
      // 相邻步稳定段逐字节一致：首个差异点只允许出现在尾部新增段
      assert.equal(second.startsWith(first.split('\n').slice(0, -1).join('\n')), true, '稳定段（末行工作目录除外）跨步逐字节不变');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { resolveMemoryConfig, setMemorySessionOverride } from '../config/memory-config';

/** /memory on|off 会话内开关（规格 §7/§10）：不落盘、会话级覆盖优先于控制面；/new 清除；运行中拒绝沿用 /memory 守卫。
 *  列表回执尾追当前开关状态与容量提示。 */

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-memtoggle-'));
  process.env.SUNSHINEX_DATA_DIR = tmp;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    await fn(root);
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const sysTexts = (ctrl: SessionController): string[] =>
  ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text);

test('/memory off → 会话内关闭（不落盘 SUNSHINE.md），列表回执含当前状态；on 恢复', async () => {
  await withRoot(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    await ctrl.submit('/memory off');
    assert.ok(
      sysTexts(ctrl).some((x) => /Persistent memory off for this session|已关闭/.test(x)),
      'off 回执',
    );
    assert.ok(!fs.existsSync(path.join(root, 'SUNSHINE.md')), '开关切换不落盘 SUNSHINE.md');
    await ctrl.submit('/memory');
    assert.ok(
      sysTexts(ctrl).some((x) => /Persistent memory: OFF|持久记忆：本会话关闭/.test(x)),
      '列表回执含当前状态（off）',
    );
    await ctrl.submit('/memory on');
    assert.ok(
      sysTexts(ctrl).some((x) => /Persistent memory on for this session|已开启/.test(x)),
      'on 回执',
    );
    await ctrl.submit('/memory');
    assert.ok(
      sysTexts(ctrl).some((x) => /Persistent memory: ON|持久记忆：本会话开启/.test(x)),
      '列表回执含当前状态（on）',
    );
    assert.equal(resolveMemoryConfig().autoMemory, true, '会话覆盖生效：控制面读面为 on');
  });
});

test('/memory off 生效于运行时判门（提取/注入面返回空集）；/new 清除覆盖', async () => {
  await withRoot(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    await ctrl.submit('/memory off');
    assert.equal(resolveMemoryConfig().autoMemory, false, 'off 覆盖生效（运行时判门单点）');
    await ctrl.submit('/new');
    assert.equal(resolveMemoryConfig().autoMemory, true, '/new 清除会话覆盖（控制面缺省）');
  });
});

test('任务运行中拒绝 /memory on|off（守卫覆盖全部子命令）', async () => {
  await withRoot(async (root) => {
    const ctrl = new SessionController({
      root,
      mode: 'manual',
      model: new ScriptedAdapter([
        '{"tool":"exec","input":{"command":"touch toggle-running.txt"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    const p = ctrl.submit('跑个命令');
    await waitFor(() => ctrl.getState().status === 'awaiting-approval');
    await ctrl.submit('/memory on');
    assert.ok(
      sysTexts(ctrl).some((x) => /A task is running|暂不能执行/.test(x)),
      '非 idle 拒绝 /memory on|off',
    );
    await ctrl.resolveApproval('deny');
    await p;
    await ctrl.waitIdle();
  });
});

test('配置 off + 会话 on → 覆盖生效；进程退出态恢复（finally 卫生）', async () => {
  process.env.SUNSHINEX_AUTO_MEMORY = 'off';
  try {
    await withRoot(async (root) => {
      const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
      await ctrl.submit('/memory on');
      assert.equal(resolveMemoryConfig().autoMemory, true, '会话覆盖优先于 env off');
      await ctrl.submit('/memory');
      assert.ok(
        sysTexts(ctrl).some((x) => /Persistent memory: ON|持久记忆：本会话开启/.test(x)),
        '列表回执反映覆盖后的 on',
      );
    });
  } finally {
    delete process.env.SUNSHINEX_AUTO_MEMORY;
    setMemorySessionOverride(undefined);
  }
});

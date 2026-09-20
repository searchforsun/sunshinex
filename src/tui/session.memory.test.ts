import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { SLASH_COMMANDS } from './components/App';
import { MemoryStore } from '../harness/memory/store';

/** /memory 命令族（规格 §6）：列表/add（同闸门）/rm/gc，运行中拒绝，命令清单与帮助同步 */

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 数据目录重定向 + 清理（测试卫生：绝不触碰真实家目录） */
async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-memcmd-'));
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

test('/memory 空态给提示；命令清单与帮助含 /memory', async () => {
  await withRoot(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    await ctrl.submit('/memory');
    assert.ok(sysTexts(ctrl).some((x) => /No memories yet|暂无记忆/.test(x)), '空态提示');
    assert.ok(SLASH_COMMANDS.includes('/memory'), '斜杠补全清单含 /memory');
    await ctrl.submit('/help');
    assert.ok(sysTexts(ctrl).some((x) => x.includes('/memory')), '帮助清单含 /memory');
  });
});

test('/memory add 落盘并回执 slug；列表可见；重复与临时措辞被闸门拒绝', async () => {
  await withRoot(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    await ctrl.submit('/memory add prefers concise replies');
    assert.ok(sysTexts(ctrl).some((x) => x.includes('prefers-concise-replies')), '回执含 slug');

    const store = new MemoryStore(root);
    assert.equal(store.count(), 1);
    assert.equal(store.list()[0]?.body, 'prefers concise replies');

    await ctrl.submit('/memory');
    assert.ok(sysTexts(ctrl).some((x) => x.includes('prefers-concise-replies')), '列表含新增行');

    await ctrl.submit('/memory add prefers concise replies');
    assert.ok(sysTexts(ctrl).some((x) => /Duplicate|重复/.test(x)), '重复拒绝');
    assert.equal(store.count(), 1, '重复不落第二条');

    await ctrl.submit('/memory add 昨天说的临时结论');
    assert.ok(sysTexts(ctrl).some((x) => /Rejected|已拒绝/.test(x)), '临时措辞拒绝');
    assert.equal(store.count(), 1);
  });
});

test('/memory rm 删除并重建索引；不存在 slug 报错', async () => {
  await withRoot(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    await ctrl.submit('/memory add project uses pnpm');
    const store = new MemoryStore(root);
    const slug = store.list()[0]?.slug ?? '';
    assert.ok(slug.length > 0, '前提：已落盘一条');

    await ctrl.submit(`/memory rm ${slug}`);
    assert.equal(store.count(), 0, '记录已删');
    assert.equal(store.indexText(), '', '索引已重建');
    await ctrl.submit('/memory');
    assert.ok(sysTexts(ctrl).some((x) => /No memories yet|暂无记忆/.test(x)), '列表回到空态');

    await ctrl.submit('/memory rm ghost');
    assert.ok(sysTexts(ctrl).some((x) => /No such|不存在/.test(x)), '不存在 slug 报错');
  });
});

test('/memory gc：非真实模型通道给提示；真实模型通道阈值外显式整理', async () => {
  await withRoot(async (root) => {
    const seed = new MemoryStore(root);
    assert.ok(seed.add({ type: 'project', description: 'memo alpha', body: 'alpha body' }).ok);
    assert.ok(seed.add({ type: 'project', description: 'memo beta', body: 'beta body' }).ok);

    const scripted = new SessionController({ root, model: new ScriptedAdapter([]) });
    await scripted.submit('/memory gc');
    assert.ok(sysTexts(scripted).some((x) => /real model|真实模型/.test(x)), 'stub 通道给提示');
    assert.equal(seed.count(), 2, 'stub 通道零副作用');

    const merging: ModelAdapter = {
      provider: 'openai',
      complete: async () => {
        throw new Error('complete must not be called on the chat path');
      },
      chat: async (req: { messages: Array<{ role: string; content: string }> }) => {
        const prompt = req.messages.map((m) => (m.role === 'user' ? m.content : '')).join('\n');
        if (!prompt.includes('memory-consolidation')) throw new Error('unexpected non-consolidation call');
        return {
          finish: 'tool_calls' as const,
          content: '',
          toolCalls: [{ id: 'call_0', name: 'submit_memory_items', argsJson: JSON.stringify({ items: [{ type: 'project', description: 'merged memo', body: 'single merged record' }] }) }],
        };
      },
    } as unknown as ModelAdapter;
    const real = new SessionController({ root, model: merging });
    await real.submit('/memory gc');
    assert.equal(seed.count(), 1, '阈值外显式整理生效（gc 为 force 入口）');
    assert.ok(sysTexts(real).some((x) => x.includes('memory')), '回执含整理结果');
  });
});

test('/memory 运行中拒绝（/compact 同款守卫）', async () => {
  await withRoot(async (root) => {
    const ctrl = new SessionController({
      root,
      mode: 'manual',
      model: new ScriptedAdapter([
        '{"tool":"exec","input":{"command":"touch mem-ok.txt"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    const p = ctrl.submit('跑个命令');
    await waitFor(() => ctrl.getState().status === 'awaiting-approval');
    await ctrl.submit('/memory');
    assert.ok(sysTexts(ctrl).some((x) => /unavailable now|暂不能/.test(x)), '非 idle 拒绝');
    await ctrl.resolveApproval('deny');
    await p;
    await ctrl.waitIdle();
  });
});

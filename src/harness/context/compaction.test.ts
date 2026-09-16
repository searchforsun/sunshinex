import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chainToHistoryItems, ContextManager, runCompaction } from './index';
import { ContextItem } from '../../types';
import { FileStore } from '../../storage/adapter';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-cpt-'));
  const cm = new ContextManager(root, new FileStore(root));
  return { root, cm };
}

async function compactOf(cm: ContextManager, content: string) {
  const items: ContextItem[] = [{ kind: 'history', content }];
  return cm.window.compact(items);
}

test('trackFile 去重且 LRU 上限 5', () => {
  const { cm } = setup();
  for (const f of ['a', 'b', 'c', 'd', 'e', 'f']) cm.trackFile(f);
  cm.trackFile('c');
  assert.deepEqual(cm.recentFiles(), ['b', 'd', 'e', 'f', 'c']);
});

test('applyCompaction 注入摘要与重读条目，位于 history 之前', async () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'notes.md'), 'line1\nline2');
  cm.trackFile('notes.md');

  const chunks = await compactOf(cm, '很长的旧上下文 '.repeat(50));
  await cm.applyCompaction(chunks);

  const items = cm.assemble([{ kind: 'history', content: '新步骤' }]);
  const histIdx = items.findIndex((i) => i.content === '新步骤');
  const sumIdx = items.findIndex((i) => i.content.startsWith('[Compacted summary'));
  const reIdx = items.findIndex((i) => i.content.startsWith('[重读] notes.md'));
  assert.ok(sumIdx !== -1 && sumIdx < histIdx, '摘要应位于 history 之前');
  assert.ok(reIdx !== -1 && reIdx < histIdx, '重读应位于 history 之前');
  assert.ok(items[reIdx].content.includes('line1'));
  assert.match(items[sumIdx].content, /^\[Compacted summary checksum=[0-9a-f]{16}\]/);
});

test('重复 applyCompaction 相同 chunks 幂等：不重复注入', async () => {
  const { cm } = setup();
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  await cm.applyCompaction(chunks);
  await cm.applyCompaction(chunks);
  assert.equal(cm.assemble().filter((i) => i.content.startsWith('[Compacted summary')).length, 1);
});

test('重读失败（文件缺失）跳过该文件，注入不受影响', async () => {
  const { cm } = setup();
  cm.trackFile('ghost.md');
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  await assert.doesNotReject(() => cm.applyCompaction(chunks));
  const items = cm.assemble();
  assert.ok(!items.some((i) => i.content.startsWith('[重读] ghost.md')));
  assert.ok(items.some((i) => i.content.startsWith('[Compacted summary')));
});

test('重读截断为每文件前 500 行', async () => {
  const { root, cm } = setup();
  const lines = Array.from({ length: 600 }, (_, i) => `line${i}`);
  fs.writeFileSync(path.join(root, 'big.md'), lines.join('\n'));
  cm.trackFile('big.md');
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  await cm.applyCompaction(chunks);
  const reread = cm.assemble().find((i) => i.content.startsWith('[重读] big.md'));
  assert.ok(reread);
  assert.ok(reread.content.includes('line499'));
  assert.ok(!reread.content.includes('line500'));
});

test('重读条目内容过凭据脱敏（密钥不进上下文）', async () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'secret.env'), 'TEST_API_KEY=sk-abcdefghijklmnopqrst1234\n普通内容');
  cm.trackFile('secret.env');
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  await cm.applyCompaction(chunks);
  const reread = cm.assemble().find((i) => i.content.startsWith('[重读] secret.env'));
  assert.ok(reread, '重读条目应存在');
  assert.ok(!reread.content.includes('sk-abcdefghijklmnopqrst1234'), '密钥明文不得进入重读条目');
  assert.ok(reread.content.includes('***'), '命中片段应替换为 ***');
  assert.ok(reread.content.includes('普通内容'), '非敏感内容应保留');
});

test('重读预算化：超限按 LRU 最旧先丢整文件', async () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'old.md'), 'O'.repeat(2000)); // 重读 ≈ 506 tok
  fs.writeFileSync(path.join(root, 'new.md'), 'N'.repeat(200));  // ≈ 56 tok
  cm.trackFile('old.md');
  cm.trackFile('new.md');
  const chunks = await cm.window.compact([{ kind: 'history', content: '旧上下文要点'.repeat(10) }]);
  await cm.applyCompaction(chunks, { rereadTokenBudget: 200 });
  const items = cm.assemble();
  const texts = items.map((i) => i.content);
  assert.ok(!texts.some((t) => t.startsWith('[重读] old.md')), '最旧文件整条被丢');
  assert.ok(texts.some((t) => t.startsWith('[重读] new.md')), '预算内新文件保留');
});

test('重读预算化：预算内全部保留（与未传参数行为一致）', async () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'a.md'), 'a'.repeat(100));
  cm.trackFile('a.md');
  const chunks = await cm.window.compact([{ kind: 'history', content: '旧上下文要点'.repeat(10) }]);
  await cm.applyCompaction(chunks, { rereadTokenBudget: 100000 });
  const items = cm.assemble();
  assert.ok(items.map((i) => i.content).some((t) => t.startsWith('[重读] a.md')));
});

const MODEL_BODY = '## Goal\n压缩验证目标\n## Open\n无';

test('applyCompaction 摘要分叉：模型成功 → 正文为模型文本，checksum 头不变，重读机制不变', async () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'notes.md'), 'line1');
  cm.trackFile('notes.md');
  const chunks = await compactOf(cm, '很长的旧上下文——含完整任务轨迹与工具观察'.repeat(20));
  let calls = 0;
  const via = await cm.applyCompaction(chunks, {
    rereadTokenBudget: 2000,
    summaryTokenBudget: 2000,
    summaryModel: { provider: 'openai', complete: async () => { calls++; return MODEL_BODY; } },
  });
  assert.equal(via, 'model');
  const items = cm.assemble();
  const sum = items.find((i) => i.content.startsWith('[Compacted summary'));
  assert.ok(sum, '压缩块存在');
  assert.match(sum!.content, /^\[Compacted summary checksum=[0-9a-f]{16}\]\n## Goal/);
  assert.ok(sum!.content.includes(MODEL_BODY), '正文为模型文本');
  assert.ok(!sum!.content.includes('- [history] '), '确定性 join 行被替换');
  assert.ok(items.some((i) => i.content.startsWith('[重读] notes.md')), '重读条目机制不变');
  assert.equal(calls, 1, '模型恰好调用一次');
});

test('applyCompaction 摘要分叉：模型抛错/空输出 → 回退确定性 join（逐字节今日行为）', async () => {
  for (const complete of [async () => { throw new Error('boom'); }, async () => '   '] as const) {
    const { cm } = setup();
    const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
    const via = await cm.applyCompaction(chunks, { summaryModel: { provider: 'openai', complete } });
    assert.equal(via, 'deterministic');
    const sum = cm.assemble().find((i) => i.content.startsWith('[Compacted summary'));
    assert.ok(sum && sum.content.includes('- [history] 旧上下文要点'), '回退体为 - [type] 摘要 行');
  }
});

test('applyCompaction replay 幂等：同一 chunks 二次应用不再发起模型调用', async () => {
  const { cm } = setup();
  let calls = 0;
  const model = { provider: 'openai', complete: async () => { calls++; return MODEL_BODY; } };
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  await cm.applyCompaction(chunks, { summaryModel: model });
  const via2 = await cm.applyCompaction(chunks, { summaryModel: model });
  assert.equal(via2, 'replay');
  assert.equal(calls, 1, 'replay 不发起模型调用');
  assert.equal(cm.assemble().filter((i) => i.content.startsWith('[Compacted summary')).length, 1, '不重复注入');
});

test('applyCompaction provider 门禁：非 openai 通道不走模型直接确定性', async () => {
  const { cm } = setup();
  let calls = 0;
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  const via = await cm.applyCompaction(chunks, { summaryModel: { provider: 'stub', complete: async () => { calls++; return 'X'; } } });
  assert.equal(via, 'deterministic');
  assert.equal(calls, 0, 'stub 通道零模型调用');
});

test('chainToHistoryItems：链行 → history 条目唯一格式（与 reactor toHistory 同源）', () => {
  const items = chainToHistoryItems([
    { step: 3, action: 'read', observation: 'o1' },
    { step: 4, observation: 'o2' },
  ]);
  assert.deepEqual(items.map((i) => i.content), ['3: read -> o1', '4:  -> o2']);
  assert.ok(items.every((i) => i.kind === 'history'));
});

test('runCompaction：协调单点——压缩、模型摘要、折链', async () => {
  const { cm } = setup();
  cm.appendChain([{ action: 'read', observation: 'Y'.repeat(800) }]);
  const items = cm.assemble(chainToHistoryItems(cm.chainView()));
  const r = await runCompaction(cm, items, {
    summaryTokenBudget: 2000,
    rereadTokenBudget: 2000,
    chainFoldedCount: 1,
    summaryModel: { provider: 'openai', complete: async () => MODEL_BODY },
  });
  assert.equal(r.via, 'model');
  assert.ok(r.chunks.length > 0);
  assert.equal(cm.chainView().length, 0, 'chainFoldedCount>0 时折链（压缩块与链不双份）');
  assert.ok(cm.assemble().some((i) => i.content.startsWith('[Compacted summary')));
});

test('runCompaction：replay 幂等——不再折链、不重复注入', async () => {
  const { cm } = setup();
  cm.appendChain([{ observation: 'Y'.repeat(50) }, { observation: 'Z'.repeat(50) }]);
  const items = cm.assemble(cm.chainView().map((s) => ({ kind: 'history' as const, content: `${s.step}: ${s.action ?? ''} -> ${s.observation}` })));
  const r1 = await runCompaction(cm, items, { summaryTokenBudget: 2000, rereadTokenBudget: 2000 });
  assert.notEqual(r1.via, 'replay');
  const r2 = await runCompaction(cm, items, { summaryTokenBudget: 2000, rereadTokenBudget: 2000, chainFoldedCount: cm.chainView().length });
  assert.equal(r2.via, 'replay');
  assert.equal(cm.chainView().length, 2, 'replay 不折链（防重复推进水位）');
  assert.equal(cm.assemble().filter((i) => i.content.startsWith('[Compacted summary')).length, 1, '不重复注入');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractCompactInstructions } from './loader';
import { ContextManager, runCompaction } from './index';
import { FileStore } from '../../storage/adapter';
import type { ModelAdapter } from '../../model/adapter';

/** Task 6（规格 E 项）：SUNSHINE.md「Compact Instructions」区提取 */

test('extractCompactInstructions：英文标题区命中，返回区体', () => {
  const md = ['# P', 'base rule', '## Compact Instructions', 'keep migration details', 'preserve error list'].join('\n');
  assert.equal(extractCompactInstructions(md), 'keep migration details\npreserve error list');
});

test('extractCompactInstructions：中文标题「压缩指令」同样命中', () => {
  const md = ['# 项目', '规则', '## 压缩指令', '保留迁移细节'].join('\n');
  assert.equal(extractCompactInstructions(md), '保留迁移细节');
});

test('extractCompactInstructions：区体在下个二级标题处终止', () => {
  const md = ['## Compact Instructions', 'focus line', '## Other', 'other body'].join('\n');
  assert.equal(extractCompactInstructions(md), 'focus line');
});

test('extractCompactInstructions：无区返回 null；空区体返回 null', () => {
  assert.equal(extractCompactInstructions('# P\nrule\n'), null);
  assert.equal(extractCompactInstructions('## Compact Instructions\n\n## Next\nx\n'), null);
});

const SUMMARY = '## Goal\nx\n## Constraints\nx\n## Progress\nx\n## Verified\nx\n## Open\nx\n## Rationale\nx';

function recorderModel(seen: string[]): ModelAdapter {
  return {
    provider: 'openai',
    complete: async (p: string) => {
      seen.push(p);
      return SUMMARY;
    },
  } as unknown as ModelAdapter;
}

test('Task6 集成：有区时摘要 prompt 含区体', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshine-t6-'));
  try {
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), ['# P', 'rule', '## Compact Instructions', 'keep migration notes'].join('\n'));
    const cm = new ContextManager(tmp, new FileStore(tmp));
    cm.appendChain([{ action: 'read', observation: 'Y'.repeat(2000) }]);
    const seen: string[] = [];
    await runCompaction(cm, cm.assemble([{ kind: 'history', content: '1: read -> Y' }]), {
      summaryTokenBudget: 2000,
      rereadTokenBudget: 2000,
      chainFoldedCount: 1,
      summaryModel: recorderModel(seen),
    });
    const summaryCall = seen.find((p) => p.includes('handoff summary'));
    assert.ok(summaryCall, '应发起摘要调用');
    assert.match(summaryCall, /keep migration notes/, '区体应并入摘要 prompt');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task6 集成：无区时摘要 prompt 零变形（不含区体/关注点）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshine-t6b-'));
  try {
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), '# P\nrule\n');
    const cm = new ContextManager(tmp, new FileStore(tmp));
    cm.appendChain([{ action: 'read', observation: 'Y'.repeat(2000) }]);
    const seen: string[] = [];
    await runCompaction(cm, cm.assemble([{ kind: 'history', content: '1: read -> Y' }]), {
      summaryTokenBudget: 2000,
      rereadTokenBudget: 2000,
      chainFoldedCount: 1,
      summaryModel: recorderModel(seen),
    });
    const call = seen.find((p) => p.includes('handoff summary'));
    assert.ok(call);
    assert.doesNotMatch(call, /keep migration notes|Focus|关注点/, '无区无 focus 时零变形');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

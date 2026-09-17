import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager, runCompaction } from './index';
import { FileStore } from '../../storage/adapter';

/** Task 8（规格 G 项）：SUNSHINE.md 会话冻结——装配读快照，四刷新点生效 */

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeCM(tmp: string): ContextManager {
  return new ContextManager(tmp, new FileStore(tmp));
}

function sunshineOf(cm: ContextManager): string {
  const item = cm.assemble().find((i) => i.kind === 'instruction' && i.content.includes('rule'));
  return item?.content ?? '';
}

test('Task8 构造后改盘 → assemble 仍为快照内容（冻结）', () => {
  const tmp = tmpdir('sunshine-t8a-');
  try {
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), 'rule-v1');
    const cm = makeCM(tmp);
    assert.ok(sunshineOf(cm).includes('rule-v1'));
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), 'rule-v2');
    assert.ok(sunshineOf(cm).includes('rule-v1'), '应仍为快照 v1');
    assert.ok(!sunshineOf(cm).includes('rule-v2'), '新值不应出现');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task8 reloadContext() → 快照刷新（/init 路径）', () => {
  const tmp = tmpdir('sunshine-t8b-');
  try {
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), 'rule-v1');
    const cm = makeCM(tmp);
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), 'rule-v2');
    cm.reloadContext();
    assert.ok(sunshineOf(cm).includes('rule-v2'), '显式刷新后生效');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task8 压缩成功后快照刷新；replay 不刷新', async () => {
  const tmp = tmpdir('sunshine-t8c-');
  try {
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), 'rule-v1');
    const cm = makeCM(tmp);
    cm.appendChain([{ action: 'read', observation: 'Y'.repeat(2000) }]);
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), 'rule-v2');
    await runCompaction(cm, cm.assemble([{ kind: 'history', content: '1: read -> Y' }]), {
      summaryTokenBudget: 2000,
      rereadTokenBudget: 2000,
      chainFoldedCount: 1,
    });
    assert.ok(sunshineOf(cm).includes('rule-v2'), '压缩点刷新（对标 CC）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task8 resetSession 后快照刷新', () => {
  const tmp = tmpdir('sunshine-t8d-');
  try {
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), 'rule-v1');
    const cm = makeCM(tmp);
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), 'rule-v2');
    cm.resetSession();
    assert.ok(sunshineOf(cm).includes('rule-v2'), '/new 后生效');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task8 compactInstructions 缓存随快照刷新', async () => {
  const tmp = tmpdir('sunshine-t8e-');
  try {
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), 'rule-v1');
    const cm = makeCM(tmp);
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), ['rule-v2', '## Compact Instructions', 'keep migration notes'].join('\n'));
    // reloadContext（压缩成功路径同一刷新口）后：E 项区缓存应同步重提取
    cm.reloadContext();
    cm.appendChain([{ action: 'read', observation: 'Y'.repeat(2000) }]);
    const seen: string[] = [];
    await runCompaction(cm, cm.assemble([{ kind: 'history', content: '1: read -> Y' }]), {
      summaryTokenBudget: 2000,
      rereadTokenBudget: 2000,
      chainFoldedCount: 1,
      summaryModel: {
        provider: 'openai',
        complete: async (p: string) => {
          seen.push(p);
          return '## Goal\nx\n## Constraints\nx\n## Progress\nx\n## Verified\nx\n## Open\nx\n## Rationale\nx';
        },
      } as never,
    });
    const call = seen.find((p) => p.includes('handoff summary'));
    assert.ok(call && call.includes('keep migration notes'), '快照刷新后新指令区应进入摘要 prompt');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

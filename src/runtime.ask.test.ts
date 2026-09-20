import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCliAskSeam } from './runtime';
import type { AskUserRequest } from './types';

const OPTS = [{ label: 'Yes' }, { label: 'No' }, { label: 'Maybe' }];
const REQ: AskUserRequest = { question: 'Proceed?', options: OPTS };

function fakeIO(script: string[]) {
  const queue = [...script];
  const asked: string[] = [];
  return {
    asked,
    io: {
      isTTY: true,
      question: async (q: string) => {
        asked.push(q);
        return queue.length > 0 ? (queue.shift() as string) : '';
      },
    },
  };
}

test('cliAskSeam：非 TTY 直接 dismissed（headless 不挂死、零提问）', async () => {
  const { io, asked } = fakeIO([]);
  const seam = createCliAskSeam({ ...io, isTTY: false });
  const a = await seam(REQ);
  assert.deepEqual(a, { type: 'dismissed' });
  assert.equal(asked.length, 0, '不应发起任何提问');
});

test('cliAskSeam：单选编号 → label；空输入 → dismissed', async () => {
  const first = fakeIO(['2']);
  const a = await createCliAskSeam({ ...first.io, isTTY: true })(REQ);
  assert.deepEqual(a, { type: 'selected', labels: ['No'] });

  const second = fakeIO(['']);
  const b = await createCliAskSeam({ ...second.io, isTTY: true })(REQ);
  assert.deepEqual(b, { type: 'dismissed' });
});

test('cliAskSeam：多选空格分隔编号 → 按选项序回 labels（去重）', async () => {
  const { io } = fakeIO(['3 1 3']);
  const a = await createCliAskSeam({ ...io, isTTY: true })({ ...REQ, multiple: true });
  assert.deepEqual(a, { type: 'selected', labels: ['Yes', 'Maybe'] });
});

test('cliAskSeam：Other 行（customIndex）→ 追问自由文本 → custom（trim）', async () => {
  const { io } = fakeIO(['4', '  my custom answer  ']);
  const a = await createCliAskSeam({ ...io, isTTY: true })({ ...REQ, customIndex: 3 });
  assert.deepEqual(a, { type: 'custom', text: 'my custom answer' });
});

test('cliAskSeam：非法编号 → dismissed', async () => {
  const { io } = fakeIO(['zz']);
  const a = await createCliAskSeam({ ...io, isTTY: true })(REQ);
  assert.deepEqual(a, { type: 'dismissed' });
});

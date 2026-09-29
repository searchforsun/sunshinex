import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFrameSniffer } from './frame-sniffer';

/** ink log-update 前导擦除（eraseLines(n) = 2K (1A 2K){n-1} G） */
const erase = (n: number): string => {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += '\u001b[2K';
    if (i < n - 1) s += '\u001b[1A';
  }
  return n > 0 ? s + '\u001b[G' : '';
};

function fakeStream(): { writes: string[]; stream: { write: (...args: unknown[]) => unknown } } {
  const writes: string[] = [];
  return { writes, stream: { write: (...args: unknown[]): unknown => { writes.push(String(args[0])); return true; } } };
}

test('frame-sniffer：常规动态帧重写（前导擦除 + 帧内容）→ 帧高=内容换行数', () => {
  const { stream } = fakeStream();
  const sniffer = installFrameSniffer(stream);
  assert.equal(sniffer.frameLines(), undefined, '未学习前无置信值');
  stream.write(erase(4) + 'a\nb\n');
  assert.equal(sniffer.frameLines(), 2, '帧行数按内容换行计');
  stream.write(erase(3) + 'x\ny\nz\n');
  assert.equal(sniffer.frameLines(), 3, '后续帧覆盖学习');
});

test('frame-sniffer：静态冲刷三连（clear → 静态内容 → 无前导擦除帧）正确归位', () => {
  const { stream } = fakeStream();
  const sniffer = installFrameSniffer(stream);
  // 先建立已知帧高
  stream.write(erase(2) + '旧帧\n');
  assert.equal(sniffer.frameLines(), 1);
  // 静态冲刷：log.clear（纯擦除无换行）→ 静态内容（裸内容）→ 新帧（无前导擦除）
  stream.write(erase(3));
  stream.write('历史块第一行\n历史块第二行\n');
  assert.equal(sniffer.frameLines(), 1, '静态内容不误记为帧');
  stream.write('新帧1\n新帧2\n');
  assert.equal(sniffer.frameLines(), 2, '三连第三写=清帧后重打的动态帧');
});

test('frame-sniffer：清屏/2026 单写/裸内容噪声 → 置信清零（tail 回落全量的安全源）', () => {
  const { stream } = fakeStream();
  const sniffer = installFrameSniffer(stream);
  stream.write(erase(2) + '帧\n');
  assert.equal(sniffer.frameLines(), 1);
  // 清屏（全量重绘路径）
  stream.write('\u001b[2J\u001b[3J\u001b[H');
  assert.equal(sniffer.frameLines(), undefined, '清屏后置信清零');
  // DEC 2026 包裹的常规帧：剥壳后照常学习
  stream.write(`\u001b[?2026h${erase(2)}p1\np2\n\u001b[?2026l`);
  assert.equal(sniffer.frameLines(), 2, '2026 包裹剥壳学习');
  // 无标记裸内容（冷挂首帧形态）：不置信
  stream.write('裸内容\n');
  assert.equal(sniffer.frameLines(), undefined, '无标记内容不置信');
  // reset 手动清零
  stream.write(erase(2) + 'f\n');
  assert.equal(sniffer.frameLines(), 1);
  sniffer.reset();
  assert.equal(sniffer.frameLines(), undefined);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTuiDiskState, saveTuiDiskState, tuiStateFile } from './ui-state-disk';

/** TUI 面私有态落盘钉测(CLAUDE.md §13 持久化分层):<slug>/tui/ui-state.json 与 data/ 平级;
 *  读改写合并(cap 200 新者居尾)/坏档容错/原子写不留 .tmp */
test('ui-state-disk:落 <slug>/tui/ui-state.json;读改写合并+cap;坏档容错', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuiui-'));
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });

    // 缺档:空对象
    assert.deepEqual(loadTuiDiskState(root), {});

    // 写 → 文件在 slug/tui/ 平级位(不在 data/ 内),读回一致
    saveTuiDiskState(root, { latestFull: true, history: ['a', 'b'] });
    const file = tuiStateFile(root);
    assert.ok(file.includes(path.join('tui', 'ui-state.json')), '面私有子目录位');
    assert.ok(!file.includes(path.join('data', 'tui')), '不在 data/ 共享域内');
    assert.deepEqual(loadTuiDiskState(root), { latestFull: true, history: ['a', 'b'] });

    // 读改写合并:二次写只 patch 一键,另一键保留
    saveTuiDiskState(root, { latestFull: false });
    assert.deepEqual(loadTuiDiskState(root), { latestFull: false, history: ['a', 'b'] });

    // cap 200:250 条历史截尾保留最新 200
    const big = Array.from({ length: 250 }, (_, i) => `h${i}`);
    saveTuiDiskState(root, { history: big });
    assert.equal(loadTuiDiskState(root).history?.length, 200);
    assert.equal(loadTuiDiskState(root).history?.[199], 'h249');

    // 坏档容错:手写垃圾 JSON → 读回空对象不炸
    fs.writeFileSync(file, '{broken', 'utf8');
    assert.deepEqual(loadTuiDiskState(root), {});
    // 原子写无 .tmp 残留
    saveTuiDiskState(root, { latestFull: true });
    assert.ok(!fs.existsSync(`${file}.tmp`), '原子写不留临时档');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

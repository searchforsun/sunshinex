import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectSlug } from '../config/data-dir';
import { reapBuiltinBrowsers, builtinCdpMetaPath } from './builtin-browser';

/** 内置浏览器收割面钉（D63 L 项清偿：直杀进程面此前零直接测试——外提纯函数后 roots 注入可离线钉）。
 *  不钉真实树杀效果（win32 taskkill 对假 pid 静默失败=无害），钉的是账面行为：shell 档自保跳过+清扫、
 *  非 shell pid 进刀不炸、缺档静默。写面钉：workspace.json root 解析+默认锚点降级+skip 无根档。 */

function makeWorkspace(dir: string, slug: string, root?: string): string {
  const dataDir = slug === '.' ? dir : path.join(dir, slug, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  if (root !== undefined) {
    fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify({ root }));
  }
  return dataDir;
}

test('reapBuiltinBrowsers：shell 档自保跳过+指针档清扫；非 shell pid 进刀不炸；缺档静默', () => {
  const prev = process.env.SUNSHINEX_PROJECTS_DIR;
  // 全量跑测预载 test-env.cjs 设了 SUNSHINEX_DATA_DIR(优先级高于 PROJECTS_DIR),不清则 resolveDataDir
  // 不走 PROJECTS_DIR/<slug>/data,夹具与被测路径错位(单跑过、全量必挂)
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  delete process.env.SUNSHINEX_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-bb-reap-'));
  process.env.SUNSHINEX_PROJECTS_DIR = dir;
  // 函数契约=按工作区 root 经 resolveDataDir 解析数据目录（PROJECTS_DIR/<slug>/data）——夹具沿同径
  const roots = ['D:/w/shell-root', 'D:/w/live-root', 'D:/w/bare-root'];
  const dataOf = (root: string): string => path.join(dir, projectSlug(root), 'data');
  const shellData = makeWorkspace(dataOf(roots[0]!), '.', undefined) && dataOf(roots[0]!);
  const liveData = dataOf(roots[1]!);
  const bareData = dataOf(roots[2]!);
  fs.mkdirSync(path.join(shellData, 'plugins', 'browser-use'), { recursive: true });
  fs.writeFileSync(builtinCdpMetaPath(shellData), JSON.stringify({ kind: 'shell', ws: 'ws://x', pid: process.pid }));
  fs.mkdirSync(path.join(liveData, 'plugins', 'browser-use'), { recursive: true });
  fs.writeFileSync(builtinCdpMetaPath(liveData), JSON.stringify({ pid: 999_999_999 })); // 非 shell：进刀（假 pid 树杀无害）
  try {
    reapBuiltinBrowsers(roots);
    // shell 指针档随退场清扫（死端口 meta 留盘误导 GUI）
    assert.equal(fs.existsSync(builtinCdpMetaPath(shellData)), false, 'shell 档 meta 清扫');
    // 非 shell meta 原样（收割不写面；pid 999999999 的树杀对不存在进程无害）
    const meta = JSON.parse(fs.readFileSync(builtinCdpMetaPath(liveData), 'utf8')) as { pid: number };
    assert.equal(meta.pid, 999_999_999, '非 shell meta 零写面副作用');
    assert.equal(fs.existsSync(builtinCdpMetaPath(bareData)), false, '缺档=无内置浏览器，静默');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prev;
    if (prevData !== undefined) process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('purgeBrowserState:删除会话的浏览器状态文件与输出目录,他会话不受影响', async () => {
  const { purgeBrowserState } = await import('./builtin-browser');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-purge-'));
  try {
    const base = path.join(dataDir, 'plugins', 'browser-use');
    fs.mkdirSync(path.join(base, 'state'), { recursive: true });
    fs.mkdirSync(path.join(base, 'output', 'jid-a'), { recursive: true });
    fs.mkdirSync(path.join(base, 'output', 'jid-b'), { recursive: true });
    fs.writeFileSync(path.join(base, 'state', 'jid-a.json'), '{}');
    fs.writeFileSync(path.join(base, 'state', 'jid-b.json'), '{}');
    fs.writeFileSync(path.join(base, 'output', 'jid-a', 'shot.png'), 'x');
    purgeBrowserState(dataDir, 'jid-a');
    assert.equal(fs.existsSync(path.join(base, 'state', 'jid-a.json')), false);
    assert.equal(fs.existsSync(path.join(base, 'output', 'jid-a')), false);
    assert.equal(fs.existsSync(path.join(base, 'state', 'jid-b.json')), true);
    assert.equal(fs.existsSync(path.join(base, 'output', 'jid-b')), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('sweepOrphanBrowserState:无对应会话档的状态文件/输出目录清除,有档的保留(大小写不敏感)', async () => {
  const { sweepOrphanBrowserState } = await import('./builtin-browser');
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sweep-'));
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  try {
    const base = path.join(dataDir, 'plugins', 'browser-use');
    fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'sessions', '20261103T051016Z-Live.jsonl'), '{}\n');
    fs.mkdirSync(path.join(base, 'state'), { recursive: true });
    for (const k of ['20261103T051016Z-Live', 'gone-jid', 'proc-123-abc']) {
      fs.writeFileSync(path.join(base, 'state', `${k}.json`), '{}');
      fs.mkdirSync(path.join(base, 'output', k), { recursive: true });
    }
    sweepOrphanBrowserState();
    assert.deepEqual(fs.readdirSync(path.join(base, 'state')), ['20261103T051016Z-Live.json']);
    assert.deepEqual(fs.readdirSync(path.join(base, 'output')), ['20261103T051016Z-Live']);
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

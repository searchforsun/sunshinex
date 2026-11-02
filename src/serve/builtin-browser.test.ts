import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectSlug } from '../config/data-dir';
import { reapBuiltinBrowsers, writeShellMetas, builtinCdpMetaPath } from './builtin-browser';

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
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeShellMetas：workspace.json root 落 meta（kind shell）；默认锚点降级；无根档跳过', () => {
  const prev = process.env.SUNSHINEX_PROJECTS_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-bb-meta-'));
  process.env.SUNSHINEX_PROJECTS_DIR = dir;
  try {
    const dataA = path.join(dir, projectSlug('D:/w/a'), 'data');
    makeWorkspace(dataA, '.', 'D:/w/a');
    fs.mkdirSync(path.join(dir, 'ws-noroot', 'data'), { recursive: true }); // 无 workspace.json=无根档
    writeShellMetas('ws://facade');
    const metaA = JSON.parse(fs.readFileSync(builtinCdpMetaPath(dataA), 'utf8')) as { kind: string; ws: string; pid: number };
    assert.equal(metaA.kind, 'shell');
    assert.equal(metaA.ws, 'ws://facade');
    assert.equal(metaA.pid, process.pid, 'meta pid=壳进程自身（收割自保判据的写入端）');
    const norootMeta = path.join(dir, 'ws-noroot', 'data', 'plugins', 'browser-use', 'builtin-cdp.json');
    assert.equal(fs.existsSync(norootMeta), false, '无根档跳过不落 meta');
    // 默认锚点降级（G14.96）：sunshinex-default 无 workspace.json → root=tmp/<锚点>，
    // meta 落其 resolveDataDir 解析位（PROJECTS_DIR/<slug(tmp锚点)>/data——slug 走解析链非目录名直拼）
    const anchorRoot = path.join(os.tmpdir(), 'sunshinex-default');
    const dataDef = path.join(dir, projectSlug(anchorRoot), 'data');
    fs.mkdirSync(path.join(dir, 'sunshinex-default'), { recursive: true }); // 写面靠 readdir 发现工作区目录
    writeShellMetas('ws://facade');
    const defMeta = builtinCdpMetaPath(dataDef);
    assert.equal(fs.existsSync(defMeta), true, '默认锚点降级照落 meta');
    assert.equal(fs.existsSync(path.join(dir, 'sunshinex-default', 'data')), false, '降级锚点不落目录名直拼位');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

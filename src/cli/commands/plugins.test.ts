import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runPlugins } from './plugins';

/**
 * plugins list/validate 子命令（Task 13）：插件作者 lint 面——schema 同源校验（parsePluginManifest），
 * exit code 可进 CI。进程内直跑命令函数（kb-index.test 的 console 临时换桩先例），
 * tmp 夹具沿 config/plugins.test 的 tmpPlugin/mkPluginIn 小助手形态；
 * list 经 loadEffectivePlugins 注入面（builtinRoot/userRoot/settingsReader/platform）免真写 HOME。
 */

/** console 临时换桩：收集输出行与命令返回码，finally 还原（进程内测试不向测试日志喷命令输出）。
 *  通道即语义：stdout（console.log）= 结果面（表格/ok 摘要），stderr（console.error/warn）= 诊断面（error/warn） */
async function captureConsole(fn: () => Promise<number>): Promise<{ out: string[]; err: string[]; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void err.push(a.join(' '));
  console.warn = (...a: unknown[]) => void err.push(a.join(' '));
  try {
    const code = await fn();
    return { out, err, code };
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

/** 在装载根下造一个合法插件目录（目录名 = id，规避 id ≠ 目录名告警） */
function mkPluginIn(root: string, id: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(path.join(root, id), { recursive: true });
  writeFileSync(path.join(root, id, 'plugin.json'), JSON.stringify({ manifestVersion: 1, id, name: 'Demo', version: '0.1.0', description: 'd', ...extra }));
}

function tmpRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('validate：合法目录 exit 0 + ok 摘要含 id/version', async () => {
  const dir = tmpRoot('sunshinex-pcli-ok-');
  try {
    mkPluginIn(dir, 'demo');
    const { out, code } = await captureConsole(() => runPlugins(['validate', path.join(dir, 'demo')]));
    assert.equal(code, 0, '合法目录应 exit 0');
    const text = out.join('\n');
    assert.ok(/ok/.test(text), `应上屏 ok 级摘要：${JSON.stringify(text)}`);
    assert.ok(text.includes('demo'), '摘要应含 id');
    assert.ok(text.includes('0.1.0'), '摘要应含 version');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validate：非法 manifest exit 1 且 error: 行上屏', async () => {
  const dir = tmpRoot('sunshinex-pcli-bad-');
  try {
    mkPluginIn(dir, 'demo', { name: undefined, version: undefined, description: undefined });
    const { err, code } = await captureConsole(() => runPlugins(['validate', path.join(dir, 'demo')]));
    assert.equal(code, 1, 'schema 错误应 exit 1');
    const text = err.join('\n');
    assert.ok(text.includes('error:'), `应上屏 error: 前缀行：${JSON.stringify(text)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validate：仅告警（未知字段）不致命——warn: 行 + exit 0', async () => {
  const dir = tmpRoot('sunshinex-pcli-warn-');
  try {
    mkPluginIn(dir, 'demo', { futureThing: 1 });
    const { out, err, code } = await captureConsole(() => runPlugins(['validate', path.join(dir, 'demo')]));
    assert.equal(code, 0, '仅告警不致命应 exit 0');
    assert.ok(err.join('\n').includes('warn:'), '应上屏 warn: 前缀行');
    assert.ok(/ok/.test(out.join('\n')), '告警仍在场合法摘要照常上屏');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list：表格含 id/version/来源/启用态/server 名，告警表后 [warn] 逐行', async () => {
  const bRoot = tmpRoot('sunshinex-pcli-b-');
  const uRoot = tmpRoot('sunshinex-pcli-u-');
  try {
    mkPluginIn(bRoot, 'demo', { defaultEnabled: true, mcpServers: { srv: { command: 'node' } }, futureThing: 1 });
    mkPluginIn(bRoot, 'idle'); // 缺省禁用对照组
    const { out, err, code } = await captureConsole(() => runPlugins(['list', '--root', bRoot], {
      builtinRoot: bRoot,
      userRoot: uRoot,
      platform: 'win32',
      settingsReader: () => null,
    }));
    assert.equal(code, 0, 'list 信息面应 exit 0');
    const text = out.join('\n');
    assert.ok(text.includes('demo') && text.includes('idle'), `表格应含插件 id：${JSON.stringify(text)}`);
    assert.ok(text.includes('0.1.0'), '表格应含 version');
    assert.ok(text.includes('builtin'), '表格应含来源列值');
    assert.ok(text.includes('srv'), '表格应含 server 名');
    assert.ok(/on/.test(text) && text.includes('off'), '表格应含启用态（on/off）');
    const diag = err.join('\n');
    assert.ok(diag.includes('[warn]'), `装载告警应表后 [warn] 逐行（stderr）：${JSON.stringify(diag)}`);
    assert.ok(diag.includes('[builtin:demo]'), '告警应带 [builtin:id] 前缀点名');
  } finally {
    rmSync(bRoot, { recursive: true, force: true });
    rmSync(uRoot, { recursive: true, force: true });
  }
});

test('未知子命令/缺参 → usage 行 + exit 1（沿仓内非法参数 exit 1 口径）', async () => {
  for (const args of [[], ['wat'], ['validate'], ['list', '--root']]) {
    const { err, code } = await captureConsole(() => runPlugins(args));
    assert.equal(code, 1, `args=${JSON.stringify(args)} 应 exit 1`);
    assert.ok(/Usage: sunshinex plugins/.test(err.join('\n')), `应上屏 usage 行：args=${JSON.stringify(args)}`);
  }
});

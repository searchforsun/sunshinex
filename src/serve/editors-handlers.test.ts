import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEditors, detectEditorsAsync, editorCandidates } from './editors-handlers';

/** 预设应用安装态探测:同 id 多档取首个命中,缺席不列(用户裁定「只有实际安装的才显示」) */
test('detectEditors: 只列存在的应用,同 id 用户级优先系统级', () => {
  const env = { USERPROFILE: 'C:\\u', ProgramFiles: 'C:\\pf', windir: 'C:\\w' } as unknown as NodeJS.ProcessEnv;
  const candidates = editorCandidates(env);
  assert.ok(candidates.some((c) => c.exe === 'C:\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'));
  assert.ok(candidates.some((c) => c.exe === 'C:\\pf\\Microsoft VS Code\\Code.exe'));
  const editors = detectEditors(
    (p) => p === 'C:\\w\\explorer.exe' || p === 'C:\\pf\\Microsoft VS Code\\Code.exe',
    env,
  );
  // explorer 恒列;vscode 两档只命中系统级→仍列一次;cursor 缺席不列
  assert.deepEqual(editors.map((e) => e.id), ['explorer', 'vscode']);
  // 同 id 多候选用户级先于系统级命中(editorCandidates 序)
  assert.equal(editors.find((e) => e.id === 'vscode')?.exe, 'C:\\pf\\Microsoft VS Code\\Code.exe');
});

test('detectEditors: 全部缺席则空表(explorer 路径也由 exists 裁决)', () => {
  assert.deepEqual(detectEditors(() => false, {} as NodeJS.ProcessEnv), []);
});

test('detectEditors: PATH shim 兜底——静态位全缺时经 where 回溯源 exe;解析不到真 exe 宁缺', () => {
  const env = { USERPROFILE: 'C:\\u', ProgramFiles: 'C:\\pf', windir: 'C:\\w' } as unknown as NodeJS.ProcessEnv;
  const exists = (p: string): boolean => p === 'D:\\cursor\\Cursor.exe' || p === 'C:\\w\\explorer.exe';
  // where cursor 命中 bin shim → ../Cursor.exe 命中真身;where code 命中的 shim 相对位无 Code.exe → 弃
  const where = (shim: string): string | null =>
    shim === 'cursor' ? 'D:\\cursor\\bin\\cursor.cmd' : shim === 'code' ? 'D:\\other\\codeBin\\code.cmd' : null;
  const editors = detectEditors(exists, env, where);
  assert.deepEqual(
    editors.map((e) => e.id + '=' + e.exe),
    ['explorer=C:\\w\\explorer.exe', 'cursor=D:\\cursor\\Cursor.exe'],
  );
});

test('detectEditors: 静态位已有编辑器则不叠 PATH 兜底', () => {
  const env = { USERPROFILE: 'C:\\u', ProgramFiles: 'C:\\pf', windir: 'C:\\w' } as unknown as NodeJS.ProcessEnv;
  const editors = detectEditors((p) => p.includes('Microsoft VS Code') || p === 'C:\\w\\explorer.exe', env, () => 'D:\\x\\cursor.cmd');
  assert.equal(editors.some((e) => e.id === 'cursor'), false);
});

// ---- 生产路径锚(2026-10-27 技术债轮 F7):detectEditorsAsync(注册表兜底+异步 where)是
// handleEditorsGet/open 的真实现——原测试全部打在自述「测试锚」的同步版上,async 面零覆盖。
// where/vscodeRegistry 全参可注入,打真实现零 mock 框架 ----

const ASYNC_ENV = { USERPROFILE: 'C:\\u', ProgramFiles: 'C:\\pf', windir: 'C:\\w' } as unknown as NodeJS.ProcessEnv;

test('detectEditorsAsync: 注册表兜底回捞非标盘位 VS Code(静态位全缺→InstallLocation 命中)', async () => {
  const exists = (p: string): boolean => p === 'C:\\w\\explorer.exe' || p === 'D:\\MyWorkSoftware\\VS Code\\Code.exe';
  const editors = await detectEditorsAsync(exists, ASYNC_ENV, () => Promise.resolve(null), () =>
    Promise.resolve('D:\\MyWorkSoftware\\VS Code'),
  );
  assert.deepEqual(
    editors.map((e) => e.id + '=' + e.exe),
    ['explorer=C:\\w\\explorer.exe', 'vscode=D:\\MyWorkSoftware\\VS Code\\Code.exe'],
  );
});

test('detectEditorsAsync: registry/shim 双兜底全落空→宁缺(静态/兜底全缺席即空表)', async () => {
  const editors = await detectEditorsAsync(() => false, ASYNC_ENV, () => Promise.resolve(null), () => Promise.resolve(null));
  assert.deepEqual(editors.map((e) => e.id), []);
});

test('detectEditorsAsync: 静态位优先于注册表/PATH shim(先命中先得不叠兜底,同 id 用户级候选先列)', async () => {
  const exists = (p: string): boolean => p.includes('Microsoft VS Code') || p === 'C:\\w\\explorer.exe';
  const editors = await detectEditorsAsync(
    exists,
    ASYNC_ENV,
    () => Promise.resolve('D:\\shim\\code.cmd'),
    () => Promise.resolve('D:\\reg\\VS Code'),
  );
  assert.equal(editors.find((e) => e.id === 'vscode')?.exe, 'C:\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe');
});

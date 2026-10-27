import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEditors, editorCandidates } from './editors-handlers';

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
  assert.equal(editors.find((e) => e.id === 'vscode')?.exe, 'C:\\pf\\Microsoft VS Code\\Code.exe');
});

test('detectEditors: 全部缺席则空表(explorer 路径也由 exists 裁决)', () => {
  assert.deepEqual(detectEditors(() => false, {} as NodeJS.ProcessEnv), []);
});

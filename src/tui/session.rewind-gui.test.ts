import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copySessionStores, forkIncludeCut, listAnchors, parseJournalFile, readSessionMeta, retractDanglingUser, rewindSessionStores, sessionsDir, writeSessionMeta } from './session-journal';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** GUI 形档(session-kernel v3 词汇):header / seg user / chain(task) / …——锚点=chain 行回退,
 *  seg user 行先于其 chain 行落档(实测父档 29=user 段/30=task 链行) */
function writeGuiJournal(dataDir: string, id: string): void {
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(dataDir), id + '.jsonl'), [
    `{"t":"header","v":3,"id":"${id}","createdAt":"x"}`,
    '{"t":"seg","kind":"user","md":"第一问","ts":1,"seq":1}',
    '{"t":"chain","steps":[{"step":1,"action":"task","observation":"第一问"}]}',
    '{"t":"runmeta","seconds":2}',
    '{"t":"seg","kind":"user","md":"第二问","ts":2,"seq":2}',
    '{"t":"chain","steps":[{"step":2,"action":"task","observation":"第二问"}]}',
  ].join('\n') + '\n', 'utf8');
}

test('retractDanglingUser: GUI 档 rewind 切点回撤该轮 user 段行(锚点 chain 行前一格=seg user)', () => {
  const dataDir = tmpdir('rewind-gui-a-');
  try {
    writeGuiJournal(dataDir, 'g1');
    const file = path.join(sessionsDir(dataDir), 'g1.jsonl');
    const parsed = parseJournalFile(file);
    const anchors = listAnchors(parsed);
    assert.equal(anchors.length, 2);
    // 回退第 2 轮:chain2(行6) 前一格=行5(seg user 第二问)→回撤到行4(runmeta)
    assert.equal(retractDanglingUser(parsed, anchors[1]!.line - 1), 4);
    // 回退第 1 轮:chain1(行3) 前一格=行2(seg user 第一问)→回撤到行1(header)——编辑首条消息=全清
    assert.equal(retractDanglingUser(parsed, anchors[0]!.line - 1), 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('retractDanglingUser: TUI 档(user 行锚点)零动——切点已落在 user 行之前', () => {
  const dataDir = tmpdir('rewind-gui-b-');
  try {
    fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(dataDir), 't1.jsonl'), [
      '{"t":"header","v":1,"id":"t1","createdAt":"x"}',
      '{"t":"user","text":"第一问"}',
      '{"t":"chain","steps":[{"step":1,"action":"task","observation":"第一问"}]}',
      '{"t":"user","text":"第二问"}',
      '{"t":"chain","steps":[{"step":2,"action":"task","observation":"第二问"}]}',
    ].join('\n') + '\n', 'utf8');
    const parsed = parseJournalFile(path.join(sessionsDir(dataDir), 't1.jsonl'));
    const anchors = listAnchors(parsed); // user 行路径:锚点=行2/行4
    assert.equal(anchors[0]!.line, 2);
    assert.equal(retractDanglingUser(parsed, anchors[1]!.line - 1), 3, '行3=chain,非 user,不回撤');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('forkIncludeCut: 回撤改抽共享件后行为零变化(GUI 档切在下一轮 user 段行前)', () => {
  const dataDir = tmpdir('rewind-gui-c-');
  try {
    writeGuiJournal(dataDir, 'g2');
    const parsed = parseJournalFile(path.join(sessionsDir(dataDir), 'g2.jsonl'));
    const anchors = listAnchors(parsed);
    // fork 第 1 轮=含整轮,切在下一轮(行5 seg user 第二问)之前→回撤悬挂 user 后=行4
    assert.equal(forkIncludeCut(parsed, anchors, 1), 4);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('rewindSessionStores: 账本/团队面克隆到新 id,辅助档 sideOf 原地改指(不克隆)', () => {
  const dataDir = tmpdir('rewind-gui-d-');
  try {
    fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(dataDir), 'src1.jsonl'), '{"t":"header","v":3,"id":"src1","createdAt":"x"}\n', 'utf8');
    fs.mkdirSync(path.join(dataDir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'tasks', 'ledger-src1.jsonl'), '{"id":"bg1"}\n', 'utf8');
    fs.mkdirSync(path.join(dataDir, 'teams', 'src1'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'teams', 'src1', 'registry.json'), '{}', 'utf8');
    // 辅助档:sideOf 回指 src1,带 title(writeSessionMeta 合并语义下改指后须保留)
    fs.writeFileSync(path.join(sessionsDir(dataDir), 'side1.jsonl'), '{"t":"header","v":3,"id":"side1","createdAt":"x"}\n', 'utf8');
    writeSessionMeta(dataDir, 'side1', { side: true, title: '辅助对话 1', sideOf: 'src1' });

    rewindSessionStores(dataDir, 'src1', 'new1');

    assert.equal(fs.readFileSync(path.join(dataDir, 'tasks', 'ledger-new1.jsonl'), 'utf8'), '{"id":"bg1"}\n', '账本整件克隆');
    assert.equal(fs.existsSync(path.join(dataDir, 'teams', 'new1', 'registry.json')), true, '团队面递归克隆');
    const sideMeta = readSessionMeta(dataDir, 'side1');
    assert.equal(sideMeta.sideOf, 'new1', 'sideOf 原地改指新 journal id');
    assert.equal(sideMeta.side, true);
    assert.equal(sideMeta.title, '辅助对话 1', 'side/title 随合并保留');
    const sideFiles = fs.readdirSync(sessionsDir(dataDir)).filter((n) => n.startsWith('side1') && n.endsWith('.jsonl'));
    assert.deepEqual(sideFiles, ['side1.jsonl'], '辅助档本体不克隆(原地续档)');
    assert.equal(fs.existsSync(path.join(sessionsDir(dataDir), 'side1.meta.json')), true, 'meta 单文件落盘');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('copySessionStores: 抽件重构后行为零变化(辅助档整档克隆+sideOf 改指子档)', () => {
  const dataDir = tmpdir('rewind-gui-e-');
  try {
    fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(dataDir), 'src2.jsonl'), '{"t":"header","v":3,"id":"src2","createdAt":"x"}\n{"t":"user","text":"q"}\n', 'utf8');
    fs.writeFileSync(path.join(sessionsDir(dataDir), 'side2.jsonl'), '{"t":"header","v":3,"id":"side2","createdAt":"x"}\n', 'utf8');
    writeSessionMeta(dataDir, 'side2', { side: true, sideOf: 'src2' });

    copySessionStores(dataDir, 'src2', 'child2');

    const sideMeta = readSessionMeta(dataDir, 'side2');
    assert.equal(sideMeta.sideOf, 'src2', '源辅助档改指不动(fork 语义:子档拿克隆件)');
    const cloned = fs.readdirSync(sessionsDir(dataDir)).filter((n) => n !== 'src2.jsonl' && n !== 'side2.jsonl' && n.endsWith('.jsonl'));
    assert.equal(cloned.length, 1, '恰好克隆一个子辅助档');
    const clonedId = cloned[0]!.slice(0, -'.jsonl'.length);
    assert.equal(readSessionMeta(dataDir, clonedId).sideOf, 'child2', '克隆件 sideOf 改指子档');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

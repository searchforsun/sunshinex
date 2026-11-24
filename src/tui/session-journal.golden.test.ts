/** journal 黄金档钉测（D80① 批D）：src/tui/session-journal.ts 外迁 session/journal.ts 前的回归锚。
 *  一份覆盖全词汇的 <id>.jsonl（header(v:3) + v1/v2 面行 + v3 全部段级/机制行，行形态逐字取自
 *  session-journal.test.ts / seglog.test.ts / session-journal.branch.test.ts / session.resume.test.ts
 *  的既有合法样本，零自造字段）→ parseJournalFile / reduceJournal / reduceSegRows / reduceSteerRows /
 *  reduceWakeScheduleRows / reducePendingRows 六面输出逐字节内嵌钉。迁移后任何解析/归约行为漂移
 *  （字段丢弃/键序重排/归一语义变化）都会击穿本档。期望串来自真实运行捕获（捕获版 console.log 回填），
 *  改 fixture 必须重捕获，禁止手写臆造。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseJournalFile, reduceJournal, sessionsDir, type JournalEvent } from './session-journal';
import { reducePendingRows, reduceSegRows, reduceSteerRows, reduceWakeScheduleRows } from '../session/seglog';

// 文件级数据目录钉定（sunx-face.test.ts 先例）：单文件直跑时统一落本文件临时沙箱
const filePrevData = process.env.SUNSHINEX_DATA_DIR;
const fileDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-journal-golden-'));
process.env.SUNSHINEX_DATA_DIR = fileDataDir;
test.after(() => {
  if (filePrevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
  else process.env.SUNSHINEX_DATA_DIR = filePrevData;
  fs.rmSync(fileDataDir, { recursive: true, force: true });
});

const GOLDEN_ID = '20261123T000000Z-g0ld';

/** 全词汇黄金档行列（行形态逐字取自既有测试合法样本；分组注释标来源） */
const GOLDEN_ROWS: JournalEvent[] = [
  // header（v:3 现役档版本；session.resume.test.ts writeJournalFile 同形）
  { t: 'header', v: 3, id: GOLDEN_ID, createdAt: '2026-11-23T00:00:00.000Z' },
  // ctx-snap 早期形态（session-journal.test.ts snapRow 同形——后被末行覆盖，钉「末行为准」）
  { t: 'ctx-snap', items: [{ part: 'skills', kind: 'system', content: '旧快照块' }], sig: { skills: 'a', memory: '', sunshinex: null, globalSunshine: null } },
  // ===== v1/v2 面行（reduceJournal 消费；样本=session-journal.test.ts 全词汇归约用例）=====
  { t: 'user', text: '黄金档第一问' },
  { t: 'msg', item: { role: 'user', text: '黄金档第一问', ts: 1, seq: 1 } },
  { t: 'snapshots', files: [{ path: 'src/a.ts', hash: 'h1' }] },
  { t: 'chain', steps: [{ step: 1, observation: 's1' }] },
  { t: 'chain', steps: [{ step: 2, action: 'edit', observation: 's2' }] } as unknown as JournalEvent, // 历史载荷直转不可（tsc2322）：双重断言保留旧形态输入——chain steps 直通不校验 action 值域（session-journal.test.ts 同款）
  // msg-update 同 seq 原位替换（基行在场）+ SPAWN 富化回写形态（session-journal.test.ts msg-update 用例）
  { t: 'msg', item: { role: 'tool', text: 'SPAWN w', ts: 1, seq: 3 } },
  { t: 'msg-update', item: { role: 'tool', text: 'SPAWN w', ts: 1, seq: 3, detail: '转录', subagentMeta: { steps: 2, durationMs: 5000, tokens: 100 } } },
  { t: 'msg', item: { role: 'assistant', text: '答一句', ts: 2, seq: 5 } },
  { t: 'msg-update', item: { role: 'assistant', text: '答一句(终稿)', ts: 2, seq: 5 } },
  { t: 'compact', chainFrom: 1, compacted: [{ kind: 'system', content: '摘要块' }] },
  // todos 旧布尔+新三态混合载荷（session-journal.test.ts 归一用例；旧布尔载荷直转不可 tsc2352——双重断言同款）
  { t: 'todos', items: [{ text: '旧项', done: true }, { text: '新项', status: 'in_progress' }] } as unknown as JournalEvent,
  // model 末值覆盖（session.journal.test.ts tier+modelId 形 → session-journal.test.ts tier-only 形——modelId 随末行缺省回落）
  { t: 'model', tier: 'small', modelId: 'deepseek/deepseek-chat' },
  { t: 'model', tier: 'large' },
  { t: 'view', expandAll: false, latestFull: true },
  // ===== v3 段级行（reduceSegRows 消费；样本=seglog.test.ts / session.resume.test.ts）=====
  { t: 'run-open', ts: 100, seq: 1 },
  { t: 'runmeta', seconds: 14, steps: 5, runSteps: 2, tokens: 12000, endedTs: 2500 },
  { t: 'seg', kind: 'user', md: '目标', ts: 100, seq: 2 },
  { t: 'seg', kind: 'tool', md: '', ts: 200, seq: 3, callId: 'c1', name: 'read', input: { path: 'a.ts' } },
  { t: 'seg-update', seq: 3, ts: 300, result: { text: 'file body\nmore', ok: true } },
  // seg-update 字段回填面（seglog.test.ts 乱序先行用例形：name/input 对位回填）
  { t: 'seg-update', seq: 3, ts: 850, name: 'read', input: { path: 'b.ts' } },
  { t: 'seg', kind: 'thinking', md: '想想', ts: 300, seq: 4, seconds: 7 },
  { t: 'seg', kind: 'assistant', md: '正文', ts: 400, seq: 5 },
  { t: 'seg', kind: 'notice', md: '瞬态将截', ts: 450, seq: 6 },
  // truncate 行即时生效：截掉 seq>5（瞬态 notice seq:6 从转录投影消失）
  { t: 'truncate', upToSeq: 5 },
  { t: 'seg', kind: 'user', md: '带图', ts: 500, seq: 7, images: ['D:/data/images-cache/20261031T140114Z-5e8877a5cbeb.png'] },
  { t: 'seg', kind: 'notice', md: '<task-notification>x</task-notification>', ts: 600, seq: 8, wake: [{ id: 'a', name: 'n' }, { id: 'b', board: true, boardRef: 't3' }] },
  { t: 'seg', kind: 'notice', md: '<schedule-wake>\nScheduled wake', ts: 700, seq: 9, schedule: true },
  { t: 'seg', kind: 'notice', md: '恢复唤醒轮', ts: 750, seq: 10, restored: true },
  // error 段行（session-journal.readable.test.ts 同形）
  { t: 'seg', kind: 'error', md: '出错了', ts: 800, seq: 11 },
  // 悬空 run-open（无 runmeta 对位→meta.stopped=true）+ 悬空 tool 行（result 永不到达→interrupted result）
  { t: 'run-open', ts: 900, seq: 12 },
  { t: 'seg', kind: 'tool', md: '', ts: 1000, seq: 13, callId: 'c2' },
  // ===== 机制行（reduceSegRows 忽略；各自读面专取）=====
  // steer 整列重写末行为准（seglog.test.ts P5 用例形）
  { t: 'steer', items: [{ seq: 0, text: '旧', front: false }] },
  { t: 'steer', items: [{ seq: 0, text: '甲', front: false }, { seq: 1, text: '乙', front: true }] },
  // 板面/委派/子智能体影子投影行（seglog.test.ts G14.2xx 用例形，原件直存）
  { t: 'board', e: { type: 'task-created', ts: 1, payload: { taskId: 't1' } } },
  { t: 'delegation', e: { type: 'delegation-started', ts: 2, payload: { delegationId: 'd1' } } },
  { t: 'subagent', e: { type: 'tool-call', ts: 3, payload: { subagent: 'w1' } } },
  // wake-schedule 机制行（seglog.test.ts P2 Task 3 用例形：arm→firedAt 终态行，末行为准）
  { t: 'wake-schedule', id: 'sched-1', fireAt: 1700000000000, note: 'check the oven' },
  { t: 'wake-schedule', id: 'sched-2', fireAt: 1700000005000, note: 'refresh cache', taskSpec: 'TASK-SPEC', firedAt: 1700000006000 },
  { t: 'wake-schedule', id: 'sched-1', fireAt: 1700000000000, note: 'check the oven', firedAt: 1700000002000 },
  // pending 机制行（seglog.test.ts P2 Task 4 用例形：ask/approval/plan-approval 三态 + resolve 配对，p3 留 open）
  { t: 'pending-open', pid: 'p1', kind: 'ask', req: { question: '用哪个数据库？', options: [{ label: 'postgres' }, { label: 'sqlite' }], askedBy: { label: 'alpha', taskId: 't3' } } },
  { t: 'pending-open', pid: 'p2', kind: 'approval', req: { id: 'ap-1', kind: 'write', subject: 'out/x.txt', reason: 'r' } },
  { t: 'pending-open', pid: 'p3', kind: 'plan-approval', req: { name: '重构计划', doc: '# 重构计划\n1. 步骤', items: ['步骤'] } },
  { t: 'pending-resolve', pid: 'p1', outcome: 'selected: postgres' },
  { t: 'pending-resolve', pid: 'p2', outcome: 'allow' },
  // ctx-snap 末行（session-journal.test.ts charter string 形——末行为准 + charter 随档透传）
  { t: 'ctx-snap', items: [{ part: 'instructions', kind: 'instruction', content: 'C1' }], sig: { skills: 'a', memory: '', sunshinex: null, globalSunshine: null, charter: 'Charter v1' } },
  // 真未知事件（未来版本行）：parse 保留在 events、reduce/seg 读面跳过不炸（外迁保真面）
  JSON.parse('{"t":"future-event","x":1}') as unknown as JournalEvent,
];

// ===== 黄金期望串（真实运行捕获于 2026-11-23，捕获版 console.log 逐字回填；改 fixture 必须重捕获）=====
const GOLDEN_EVENTS_JSON = '[{"t":"header","v":3,"id":"20261123T000000Z-g0ld","createdAt":"2026-11-23T00:00:00.000Z"},{"t":"ctx-snap","items":[{"part":"skills","kind":"system","content":"旧快照块"}],"sig":{"skills":"a","memory":"","sunshinex":null,"globalSunshine":null}},{"t":"user","text":"黄金档第一问"},{"t":"msg","item":{"role":"user","text":"黄金档第一问","ts":1,"seq":1}},{"t":"snapshots","files":[{"path":"src/a.ts","hash":"h1"}]},{"t":"chain","steps":[{"step":1,"observation":"s1"}]},{"t":"chain","steps":[{"step":2,"action":"edit","observation":"s2"}]},{"t":"msg","item":{"role":"tool","text":"SPAWN w","ts":1,"seq":3}},{"t":"msg-update","item":{"role":"tool","text":"SPAWN w","ts":1,"seq":3,"detail":"转录","subagentMeta":{"steps":2,"durationMs":5000,"tokens":100}}},{"t":"msg","item":{"role":"assistant","text":"答一句","ts":2,"seq":5}},{"t":"msg-update","item":{"role":"assistant","text":"答一句(终稿)","ts":2,"seq":5}},{"t":"compact","chainFrom":1,"compacted":[{"kind":"system","content":"摘要块"}]},{"t":"todos","items":[{"text":"旧项","done":true},{"text":"新项","status":"in_progress"}]},{"t":"model","tier":"small","modelId":"deepseek/deepseek-chat"},{"t":"model","tier":"large"},{"t":"view","expandAll":false,"latestFull":true},{"t":"run-open","ts":100,"seq":1},{"t":"runmeta","seconds":14,"steps":5,"runSteps":2,"tokens":12000,"endedTs":2500},{"t":"seg","kind":"user","md":"目标","ts":100,"seq":2},{"t":"seg","kind":"tool","md":"","ts":200,"seq":3,"callId":"c1","name":"read","input":{"path":"a.ts"}},{"t":"seg-update","seq":3,"ts":300,"result":{"text":"file body\\nmore","ok":true}},{"t":"seg-update","seq":3,"ts":850,"name":"read","input":{"path":"b.ts"}},{"t":"seg","kind":"thinking","md":"想想","ts":300,"seq":4,"seconds":7},{"t":"seg","kind":"assistant","md":"正文","ts":400,"seq":5},{"t":"seg","kind":"notice","md":"瞬态将截","ts":450,"seq":6},{"t":"truncate","upToSeq":5},{"t":"seg","kind":"user","md":"带图","ts":500,"seq":7,"images":["D:/data/images-cache/20261031T140114Z-5e8877a5cbeb.png"]},{"t":"seg","kind":"notice","md":"<task-notification>x</task-notification>","ts":600,"seq":8,"wake":[{"id":"a","name":"n"},{"id":"b","board":true,"boardRef":"t3"}]},{"t":"seg","kind":"notice","md":"<schedule-wake>\\nScheduled wake","ts":700,"seq":9,"schedule":true},{"t":"seg","kind":"notice","md":"恢复唤醒轮","ts":750,"seq":10,"restored":true},{"t":"seg","kind":"error","md":"出错了","ts":800,"seq":11},{"t":"run-open","ts":900,"seq":12},{"t":"seg","kind":"tool","md":"","ts":1000,"seq":13,"callId":"c2"},{"t":"steer","items":[{"seq":0,"text":"旧","front":false}]},{"t":"steer","items":[{"seq":0,"text":"甲","front":false},{"seq":1,"text":"乙","front":true}]},{"t":"board","e":{"type":"task-created","ts":1,"payload":{"taskId":"t1"}}},{"t":"delegation","e":{"type":"delegation-started","ts":2,"payload":{"delegationId":"d1"}}},{"t":"subagent","e":{"type":"tool-call","ts":3,"payload":{"subagent":"w1"}}},{"t":"wake-schedule","id":"sched-1","fireAt":1700000000000,"note":"check the oven"},{"t":"wake-schedule","id":"sched-2","fireAt":1700000005000,"note":"refresh cache","taskSpec":"TASK-SPEC","firedAt":1700000006000},{"t":"wake-schedule","id":"sched-1","fireAt":1700000000000,"note":"check the oven","firedAt":1700000002000},{"t":"pending-open","pid":"p1","kind":"ask","req":{"question":"用哪个数据库？","options":[{"label":"postgres"},{"label":"sqlite"}],"askedBy":{"label":"alpha","taskId":"t3"}}},{"t":"pending-open","pid":"p2","kind":"approval","req":{"id":"ap-1","kind":"write","subject":"out/x.txt","reason":"r"}},{"t":"pending-open","pid":"p3","kind":"plan-approval","req":{"name":"重构计划","doc":"# 重构计划\\n1. 步骤","items":["步骤"]}},{"t":"pending-resolve","pid":"p1","outcome":"selected: postgres"},{"t":"pending-resolve","pid":"p2","outcome":"allow"},{"t":"ctx-snap","items":[{"part":"instructions","kind":"instruction","content":"C1"}],"sig":{"skills":"a","memory":"","sunshinex":null,"globalSunshine":null,"charter":"Charter v1"}},{"t":"future-event","x":1}]';
const GOLDEN_REPLAY_JSON = '{"version":3,"chain":[{"step":1,"observation":"s1"},{"step":2,"action":"edit","observation":"s2"}],"chainFrom":1,"compacted":[{"kind":"system","content":"摘要块"}],"messages":[{"role":"user","text":"黄金档第一问","ts":1,"seq":1},{"role":"tool","text":"SPAWN w","ts":1,"seq":3,"detail":"转录","subagentMeta":{"steps":2,"durationMs":5000,"tokens":100}},{"role":"assistant","text":"答一句(终稿)","ts":2,"seq":5}],"nextSeq":5,"history":["黄金档第一问"],"todos":[{"text":"旧项","status":"completed"},{"text":"新项","status":"in_progress"}],"view":{"expandAll":false,"latestFull":true},"snapshot":{"items":[{"part":"instructions","kind":"instruction","content":"C1"}],"sig":{"skills":"a","memory":"","sunshinex":null,"globalSunshine":null,"charter":"Charter v1"}},"tier":"large"}';
const GOLDEN_SEG_ENTRIES_JSON = '[{"seq":1,"ts":100,"kind":"run","md":"","meta":{"seconds":14,"steps":5,"runSteps":2,"tokens":12000,"endedTs":2500}},{"seq":2,"ts":100,"kind":"user","md":"目标"},{"seq":3,"ts":200,"kind":"tool","md":"","callId":"c1","name":"read","input":{"path":"b.ts"},"result":{"text":"file body\\nmore","ok":true}},{"seq":4,"ts":300,"kind":"thinking","md":"想想","seconds":7},{"seq":5,"ts":400,"kind":"assistant","md":"正文"},{"seq":7,"ts":500,"kind":"user","md":"带图","images":["D:/data/images-cache/20261031T140114Z-5e8877a5cbeb.png"]},{"seq":8,"ts":600,"kind":"notice","md":"<task-notification>x</task-notification>","wake":[{"id":"a","name":"n"},{"id":"b","board":true,"boardRef":"t3"}]},{"seq":9,"ts":700,"kind":"notice","md":"<schedule-wake>\\nScheduled wake","schedule":true},{"seq":10,"ts":750,"kind":"notice","md":"恢复唤醒轮","restored":true},{"seq":11,"ts":800,"kind":"error","md":"出错了"},{"seq":12,"ts":900,"kind":"run","md":"","meta":{"stopped":true}},{"seq":13,"ts":1000,"kind":"tool","md":"","callId":"c2","result":{"text":"(interrupted)","ok":false}}]';
const GOLDEN_STEER_ITEMS_JSON = '[{"seq":0,"text":"甲","front":false},{"seq":1,"text":"乙","front":true}]';
const GOLDEN_WAKE_SCHEDULE_JSON = '[{"id":"sched-1","fireAt":1700000000000,"note":"check the oven","firedAt":1700000002000},{"id":"sched-2","fireAt":1700000005000,"note":"refresh cache","taskSpec":"TASK-SPEC","firedAt":1700000006000}]';
const GOLDEN_PENDING_VIEW_JSON = '{"open":[{"pid":"p3","kind":"plan-approval","title":"重构计划"}],"resolved":[{"pid":"p1","kind":"ask","title":"用哪个数据库？","options":["postgres","sqlite"],"askedBy":{"label":"alpha","taskId":"t3"},"outcome":"selected: postgres"},{"pid":"p2","kind":"approval","title":"out/x.txt","outcome":"allow"}]}';

test('journal 黄金档：全词汇 fixture 的 parse/reduce 输出逐字节钉（D80① 外迁锚）', () => {
  const dir = sessionsDir(fileDataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, GOLDEN_ID + '.jsonl');
  fs.writeFileSync(file, GOLDEN_ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const parsed = parseJournalFile(file);
  assert.equal(parsed.truncated, false, '全词汇档逐行合法（零截断）');
  assert.equal(parsed.lines.length, GOLDEN_ROWS.length, '行数往返一致');

  const eventsJson = JSON.stringify(parsed.events);
  const replayJson = JSON.stringify(reduceJournal(parsed.events));
  const segJson = JSON.stringify(reduceSegRows(parsed.events));
  const steerJson = JSON.stringify(reduceSteerRows(parsed.events));
  const wakeJson = JSON.stringify(reduceWakeScheduleRows(parsed.events));
  const pendingJson = JSON.stringify(reducePendingRows(parsed.events));
  assert.equal(eventsJson, GOLDEN_EVENTS_JSON, 'parseJournalFile 事件列逐字节（字段/键序零漂移；未知行原样保留）');
  assert.equal(replayJson, GOLDEN_REPLAY_JSON, 'reduceJournal 回放逐字节（未知行跳过/msg-update 原位覆盖/todos 归一/model·view·ctx-snap 末值覆盖）');
  assert.equal(segJson, GOLDEN_SEG_ENTRIES_JSON, 'reduceSegRows 转录条逐字节（seg-update 字段回填/truncate 即时截断/悬空 run 标 stopped/悬空 tool 补 interrupted）');
  assert.equal(steerJson, GOLDEN_STEER_ITEMS_JSON, 'reduceSteerRows 等待队列逐字节（末行整列重写）');
  assert.equal(wakeJson, GOLDEN_WAKE_SCHEDULE_JSON, 'reduceWakeScheduleRows 调度位逐字节（同 id 末行终态覆盖）');
  assert.equal(pendingJson, GOLDEN_PENDING_VIEW_JSON, 'reducePendingRows 挂起视图逐字节（open/resolved 按 pid 配对）');
});

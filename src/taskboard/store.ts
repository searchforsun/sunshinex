import * as fs from 'fs';
import * as path from 'path';
import { applyBoardEvent, BoardEvent, emptyBoard, TaskBoardState } from './model';

/** team 目录 event sourcing(spec §7.2):events.jsonl 为协调状态唯一真相源(append-only 单行原子),
 *  board.json 为物化快照缓存(tmp+rename 原子写,FileStore 先例)——P1 写不读,载入走全量重放
 *  (Ruling 5;快照读取优化 P2)。损坏行跳过 = Claude Code「单条脏数据卡死收件箱」教训的结构性回避(§7.3)。
 *  目录惰性建档:首写才 mkdir,空 team 零文件。inbox/ 子目录 P1 不建(随 P2 agent-message 落地,Ruling 7)。 */
export class TeamStore {
  private dirMade = false;

  constructor(private readonly teamDir: string) {}

  private eventsPath(): string {
    return path.join(this.teamDir, 'events.jsonl');
  }

  private ensureDir(): void {
    if (this.dirMade) return;
    fs.mkdirSync(this.teamDir, { recursive: true });
    this.dirMade = true;
  }

  append(ev: BoardEvent): void {
    this.ensureDir();
    fs.appendFileSync(this.eventsPath(), JSON.stringify(ev) + '\n', 'utf8');
  }

  writeSnapshot(state: TaskBoardState): void {
    this.ensureDir();
    const target = path.join(this.teamDir, 'board.json');
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, target);
  }

  /** 全量重放载入(P1 真相路径):文件缺失 = 空 team;损坏行(无换行截断/非法 JSON/缺 t 字段)跳过不炸 */
  load(): TaskBoardState {
    let raw: string;
    try {
      raw = fs.readFileSync(this.eventsPath(), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyBoard(); // 缺文件 = 新 team;其余读错误(EACCES 等)上抛不吞
      throw e;
    }
    let state = emptyBoard();
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let ev: BoardEvent | undefined;
      try {
        const parsed = JSON.parse(line) as BoardEvent;
        if (typeof parsed.t === 'string') ev = parsed;
      } catch {
        ev = undefined; // 崩溃截断行:跳过该行
      }
      if (ev !== undefined) state = applyBoardEvent(state, ev);
    }
    return state;
  }
}

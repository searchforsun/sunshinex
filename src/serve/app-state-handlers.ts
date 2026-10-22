import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { SessionRuntime } from './session';
import { validSessionId } from './session-id';
import type { SessionHandlerIo } from './session-handlers';
import { resolveDataDir } from '../config/data-dir';
import { userConfigDir } from '../config/env';

/**
 * 应用级指针档 + 置顶档 + GUI 面私有态三族（D42 端点族拆分自 session-handlers.ts，行搬运
 * 零逻辑变化）：机器级 ui-state.json/pins.json 落 userConfigDir/gui（projects 根保持纯 slug
 * 工作区位），面私有标签态按 journalId 落 <slug>/gui/sessions。消费方经 session-handlers
 * 原路径再导出取用（daemon 路由零迁移）。
 */

/** G14.2xx 应用级 GUI 指针档(~/sunshinex 等价 userConfigDir()/gui/ui-state.json):
 *  lastRoot/lastJournalId——浏览器刷新后的「恢复现场」入口。指针是**机器级**场景状态
 *  (不属于任何 projects 根/工作区):放 userConfigDir 使 projects 根保持纯 slug 工作区位
 *  (与面私有分层口径一致——工作区私有归 <slug>/gui|tui,应用级归 userConfigDir/gui) */
function appGuiStateFile(): string {
  return path.join(userConfigDir(), 'gui', 'ui-state.json');
}

/** 置顶档(2026-10-21,GUI 专属会话置顶):userConfigDir/gui/pins.json——机器级跨工作区
 *  视图偏好(置顶组跨工作区聚合),与指针档同目录同分层口径;GET 缺档/坏档回 {pins:[]} */
function appPinsFile(): string {
  return path.join(userConfigDir(), 'gui', 'pins.json');
}

export async function handleAppPinsGet(io: SessionHandlerIo, res: http.ServerResponse): Promise<void> {
  try {
    const raw = JSON.parse(fs.readFileSync(appPinsFile(), 'utf8')) as unknown;
    io.send(res, 200, { pins: Array.isArray(raw) ? raw : [] });
  } catch {
    io.send(res, 200, { pins: [] });
  }
}

/** 置顶档写(原子写):body.pins 须数组,逐条校验(id/root 非空串,title 可缺,updatedAt 数目)——
 *  坏条目弃置不拒整单(容错口径同 SIDECAR) */
export async function handleAppPinsPut(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const rawPins = (parsed.body as { pins?: unknown } | null)?.pins;
  if (!Array.isArray(rawPins)) {
    io.send(res, 400, { error: 'pins array required' });
    return;
  }
  const pins = rawPins.flatMap((p) => {
    const e = p as { id?: unknown; root?: unknown; title?: unknown; updatedAt?: unknown };
    if (typeof e?.id !== 'string' || e.id === '' || typeof e?.root !== 'string' || e.root === '') return [];
    return [{
      id: e.id,
      root: e.root,
      ...(typeof e.title === 'string' && e.title !== '' ? { title: e.title } : {}),
      ...(typeof e.updatedAt === 'number' && Number.isFinite(e.updatedAt) ? { updatedAt: e.updatedAt } : {}),
    }];
  });
  const file = appPinsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pins), 'utf8');
  fs.renameSync(tmp, file);
  io.send(res, 200, { ok: true, pins });
}

/** 应用级指针档读:缺档/坏档回 {state:null}(首启无现场,客户端落欢迎页) */
export async function handleAppGuiStateGet(io: SessionHandlerIo, res: http.ServerResponse): Promise<void> {
  try {
    io.send(res, 200, { state: JSON.parse(fs.readFileSync(appGuiStateFile(), 'utf8')) });
  } catch {
    io.send(res, 200, { state: null });
  }
}

/** 应用级指针档写(原子写):body.state 须对象 */
export async function handleAppGuiStatePut(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const state = (parsed.body as { state?: unknown } | null)?.state;
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    io.send(res, 400, { error: 'state object required' });
    return;
  }
  const file = appGuiStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, file);
  io.send(res, 200, { ok: true });
}

/** G14.2xx GUI 面私有态文件(<projects 根>/<工作区 slug>/gui/sessions/<journalId>.json——
 *  CLAUDE.md §13 持久化分层:与 data/ 共享域平级的面私有子目录。档键=attachedJournalId:
 *  跨 daemon 重启稳定的会话身份——会话 id 每次重启重新发号,按 id 存档刷新后必空(实测病根);
 *  journalId 形同会话面,防文件名逃逸) */
function guiStateFile(session: SessionRuntime): string {
  const dataDir = resolveDataDir(session.root);
  const key = session.attachedJournalId;
  return path.join(path.dirname(dataDir), 'gui', 'sessions', `${key}.json`);
}

/** GUI 面私有态读(标签页/面板偏好等,按 journalId 键):未附 journal 或无档回 {state:null}——
 *  客户端回落内存缺省(纯新会话本就无可恢复语义) */
export async function handleGuiStateGet(io: SessionHandlerIo, res: http.ServerResponse, id: string | undefined): Promise<void> {
  if (id === undefined || !validSessionId(id)) {
    io.send(res, 400, { error: 'invalid session id' });
    return;
  }
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  if (session.attachedJournalId === undefined) {
    io.send(res, 200, { state: null });
    return;
  }
  try {
    io.send(res, 200, { state: JSON.parse(fs.readFileSync(guiStateFile(session), 'utf8')) });
  } catch {
    io.send(res, 200, { state: null });
  }
}

/** GUI 面私有态写(写透;临时文件+rename 原子落——半写档不得成为下次启动的真相)。
 *  未附 journal(纯新会话,重启即逝)→ 200 no-op 不落盘:防孤儿档按发号 id 堆积 */
export async function handleGuiStatePut(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): Promise<void> {
  if (id === undefined || !validSessionId(id)) {
    io.send(res, 400, { error: 'invalid session id' });
    return;
  }
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  if (session.attachedJournalId === undefined) {
    io.send(res, 200, { ok: true, persisted: false });
    return;
  }
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const state = (parsed.body as { state?: unknown } | null)?.state;
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    io.send(res, 400, { error: 'state object required' });
    return;
  }
  const file = guiStateFile(session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, file);
  io.send(res, 200, { ok: true });
}

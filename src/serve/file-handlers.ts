import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { SessionRuntime } from './session';
import { MAX_PREVIEW_BYTES, insideTrustedRoots, realPathOf, readFileBounded } from './daemon-static';
import { urlOf } from './daemon-wire';
import { resolveDataDir } from '../config/data-dir';

/** 会话文件面 HTTP 处理器（D31 批2 拆分自 daemon.ts 类）：/file 只读预览（信任根判界+有界读+
 *  变更集定位）、/diff 双变更对比、/tree 工作区树——io 仅 send/sessionFor 两面，判界与有界读原语
 *  消费 daemon-static 叶子；行为零变化（daemon.diff.test 等为锚）。
 */

export interface FileHandlerIo {
  send(res: http.ServerResponse, status: number, body: object): void;
  sessionFor(res: http.ServerResponse, id: string | undefined): SessionRuntime | undefined;
}

/** tree 忽略名集（G8b T4 /tree 端点）：VCS 内脏/依赖安装物/构建产物——GUI 树的纯噪音，恒不枚举 */
const IGNORED = new Set(['.git', 'node_modules', 'dist', 'dist-gui']);

/** tree 单层上限（G8b T4）：500 条；超限截断 + truncated:true（GUI 呈现「已截断」而非无界载荷） */
const TREE_MAX_ENTRIES = 500;

/** 影子快照族（注册名小写口径）：write 与 edit 同走 writeSnapshot 缝捕获 pre-image——与
 *  modes.ts WRITE_TOOL_NAMES（规范名大写）是两个名域各表其面，第三支快照族工具两处同频 */
const SNAPSHOT_TOOLS = new Set(['write', 'edit']);

export function handleFile(io: FileHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
  const url = urlOf(req);
  const q = url.searchParams.get('path');
  if (q === null || q.length === 0) {
    io.send(res, 400, { error: 'path query param required' });
    return;
  }
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  const abs = path.resolve(session.root, q);
  // 判界基准：目标经 realPathOf 归一（存在段 realpath，防符号链接逃逸——read 工具同口径）；
  // 归一不可得回退字面 abs（fail-closed：字面 isWithin 判定兜底，越界照拒）。
  // G14.40:本会话数据档(data/memory 等)一并放行——memory 产物是用户可见面,Files 预览可达。
  // G14.106 修复:resolveDataDir 本身即 .../data(原再拼 'data' 成 \data\data,放行从未生效)
  const real = realPathOf(abs) ?? abs;
  const dataRoot = path.resolve(resolveDataDir(session.root));
  const inData = real === dataRoot || real.startsWith(dataRoot + path.sep);
  if (!inData && !insideTrustedRoots(session.runtime.harness.safety, real)) {
    // G14.106 判界拒绝诊断(root/dataDir/real 三点对照——memory 放行失配的定位面)
    console.error(`[file 403] root=${session.root} dataRoot=${dataRoot} real=${real}`);
    io.send(res, 403, { error: 'path outside trusted roots' });
    return;
  }
  const read = readFileBounded(abs);
  if (read === 'missing') {
    // G14.2xx 目录路径:Files 页输入目录(如 ./src/harness)→ directory 标记回执(客户端移交目录页签
    // 定位;原 EISDIR 归 404 不可辨识,用户面表现「相对路径打不开」)
    let st: fs.Stats | undefined;
    try { st = fs.statSync(abs); } catch { /* missing 即 404 面 */ }
    if (st?.isDirectory() === true) {
      io.send(res, 200, { path: abs, type: 'directory' });
      return;
    }
    io.send(res, 404, { error: 'not found' });
    return;
  }
  if (read === 'binary') {
    io.send(res, 415, { error: 'binary file' });
    return;
  }
  io.send(res, 200, { path: abs, content: read.content, ...(read.truncated ? { truncated: true } : {}) });
}

export function handleDiff(io: FileHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
  const url = urlOf(req);
  const callId = url.searchParams.get('callId');
  if (callId === null || callId.length === 0) {
    io.send(res, 400, { error: 'callId query param required' });
    return;
  }
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  // 帧 copy 一致性：扫描与位次计数同一快照（bufferedFrames 每调用新数组，两遍扫同一引用）
  const frames = session.bufferedFrames();
  /** 目标帧定位：首枚 callId 命中的 tool-call（text=注册名，payload.input 形态现场核 batch-runner：
   *  emit('tool-call', name, {input, callId, status})） */
  let targetSeq = -1;
  let targetAbs: string | undefined;
  for (const f of frames) {
    const e = f.e;
    if (e.type !== 'tool-call') continue;
    const p = e.payload as { callId?: unknown } | undefined;
    if (p?.callId !== callId) continue;
    if (!SNAPSHOT_TOOLS.has(e.text ?? '')) {
      io.send(res, 404, { error: 'no snapshot' }); // 命中 callId 但非快照族——无 pre-image 面
      return;
    }
    const inPath = (e.payload as { input?: unknown } | undefined)?.input;
    const p2 = inPath !== null && typeof inPath === 'object' ? (inPath as { path?: unknown }) : undefined;
    if (typeof p2?.path !== 'string' || p2.path.length === 0) {
      io.send(res, 404, { error: 'no snapshot' }); // 坏参调用（argsOf null 面）——无快照可查
      return;
    }
    targetAbs = path.resolve(session.root, p2.path);
    targetSeq = f.seq;
    break;
  }
  let entry: ReturnType<typeof session.runtime.harness.writeSnapshot.nthFor>;
  if (targetAbs !== undefined && targetSeq >= 0) {
    /** 调用序位次：同路径（resolve 归一后等值）且先于目标的快照族调用数 + 1（sink 清单内的序——
     *  write/edit 同一 sink 清单，混合序列按调用序统一对位）；
     *  P11 三帧:running 帧是同 callId 的二次 tool-call（幂等回填,非新调用）——位次按调用不按帧,跳过防双计 */
    let ordinal = 1;
    for (const f of frames) {
      if (f.seq >= targetSeq) break;
      const e = f.e;
      if (e.type !== 'tool-call' || !SNAPSHOT_TOOLS.has(e.text ?? '')) continue;
      if ((e.payload as { status?: unknown } | undefined)?.status === 'running') continue;
      const inPath = (e.payload as { input?: unknown } | undefined)?.input;
      const p = inPath !== null && typeof inPath === 'object' ? (inPath as { path?: unknown }) : undefined;
      if (typeof p?.path === 'string' && p.path.length > 0 && path.resolve(session.root, p.path) === targetAbs) ordinal += 1;
    }
    const sink = session.runtime.harness.writeSnapshot;
    entry = sink.nthFor(targetAbs, ordinal);
  } else {
    // G14.4 回退：callId 不可寻（重放会话/帧环已裁）且带 path 参数 → journal snapshots 行末次
    // pre-image（重放会话展开 diff 仍真，与折叠行 stat 同源不假增）
    const relParam = url.searchParams.get('path');
    const fb = relParam !== null && relParam !== '' ? session.diffPreImageFor(relParam) : undefined;
    if (fb === undefined) {
      io.send(res, 404, { error: 'no snapshot' });
      return;
    }
    targetAbs = fb.abs;
    entry = fb.entry;
  }
  if (entry === undefined) {
    io.send(res, 404, { error: 'no snapshot' }); // root 外写不入清单/序越界——同恒定文案
    return;
  }
  // 判界同 /file：pre-image 在场 ⇒ 写时路径在 root 内，此处防符号链接逃逸（现文件读侧）
  const real = realPathOf(targetAbs) ?? targetAbs;
  if (!insideTrustedRoots(session.runtime.harness.safety, real)) {
    io.send(res, 403, { error: 'path outside trusted roots' });
    return;
  }
  // oldContent：pre-image blob（新建写 entry.deleted 缺场；读侧 512KB 截断）
  let oldContent: string | undefined;
  let truncated = false;
  if (entry.deleted !== true && entry.hash.length > 0) {
    const blob = session.runtime.harness.writeSnapshot.readBlob(entry.hash);
    if (blob !== null) {
      truncated = blob.length > MAX_PREVIEW_BYTES;
      oldContent = blob.subarray(0, MAX_PREVIEW_BYTES).toString('utf8');
    }
  }
  // newContent：磁盘现文件（判界/截断/二进制同 /file——readFileBounded 单点）
  const read = readFileBounded(targetAbs);
  if (read === 'missing') {
    io.send(res, 404, { error: 'not found' });
    return;
  }
  if (read === 'binary') {
    io.send(res, 415, { error: 'binary file' });
    return;
  }
  truncated = truncated || read.truncated;
  io.send(res, 200, {
    path: targetAbs,
    ...(oldContent !== undefined ? { oldContent } : {}),
    newContent: read.content,
    ...(truncated ? { truncated: true } : {}),
  });
}

export function handleTree(io: FileHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
  const url = urlOf(req);
  const rel = url.searchParams.get('path') ?? ''; // 缺 path 与 ?path= 空串同义=会话 root
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  const abs = path.resolve(session.root, rel);
  // 判界基准同 /file：目标经 realPathOf 归一（存在段 realpath 防符号链接逃逸）；归一不可得回退
  // 字面 abs（fail-closed：字面 isWithin 判定兜底，越界照拒）
  const real = realPathOf(abs) ?? abs;
  if (!insideTrustedRoots(session.runtime.harness.safety, real)) {
    io.send(res, 403, { error: 'path outside trusted roots' });
    return;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(abs); // 跟随后实态：指向目录的链接本身就是目录（root 即此口径进入）
  } catch {
    io.send(res, 404, { error: 'not found' });
    return;
  }
  if (!st.isDirectory()) {
    io.send(res, 400, { error: 'not a directory' });
    return;
  }
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    io.send(res, 404, { error: 'not found' }); // stat 在场但列举失败（权限面/竞态删除）：fail-closed 归 404
    return;
  }
  const entries: Array<{ name: string; kind: 'dir' | 'file' }> = [];
  for (const d of dirents) {
    if (IGNORED.has(d.name)) continue;
    // 分型：真实目录/文件直取 dirent；链接（及其它非常规实体——socket/fifo）dirent 按链接本体
    // 分类（指向目录的链接 isDirectory()=false），statSync 跟随实态校正——断链/竞态消失/跟随落空
    // 既非 dir 又非 file 的条目不枚举
    let kind: 'dir' | 'file' | undefined = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : undefined;
    if (kind === undefined) {
      try {
        const follow = fs.statSync(path.join(abs, d.name));
        kind = follow.isDirectory() ? 'dir' : follow.isFile() ? 'file' : undefined;
      } catch {
        kind = undefined;
      }
    }
    if (kind !== undefined) entries.push({ name: d.name, kind });
  }
  // 排序口径：目录段先于文件段，同段内 name 码点序（显式 </> 而非 localeCompare——后者随区域/ICU
  // 漂移，树呈现需跨机确定性；混合大小写段的码点序稳定可预测，目录先序在段级优先）
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const truncated = entries.length > TREE_MAX_ENTRIES;
  if (truncated) entries.length = TREE_MAX_ENTRIES; // 截断保序：裁尾，前 500 条维持排序面
  io.send(res, 200, { entries, ...(truncated ? { truncated: true } : {}) });
}

import * as fs from 'fs';
import * as path from 'path';
import type { ArtifactFile, ChangeFile } from '../types';
import { isDeliverablePath } from '../types';
import { sanitizeArtifacts } from '../session/entry';

/** 轮次产物并入（2026-11-12 spec §3.4-3.5；2026-11-14 口径放宽,用户实测 copy.png 缺卡补）：
 *  声明面（write/edit，已保末次）∪ bash 兜底两网——①git 收尾差集中白名单**新建**（git 项目
 *  可见面）②mtime 轮窗有界扫描（非 git 项目/ignored/未跟踪修改对差集不可见,默认工作区即非
 *  git）;按 path 去重声明 > 差集 > 扫描,64 帽（声明集在先,溢出静默截断） */
export const ARTIFACTS_CAP = 64;

export function mergeRunArtifacts(declared: ArtifactFile[], gitExtra: ChangeFile[], scanBash: ChangeFile[] = []): ArtifactFile[] {
  const seen = new Set(declared.map((a) => a.path));
  const pick = (list: ChangeFile[]): ArtifactFile[] =>
    list
      .filter((c) => c.status === 'added' || c.status === 'untracked')
      .map((c) => c.path.replaceAll('\\', '/'))
      .filter((p) => isDeliverablePath(p) && !seen.has(p))
      .map((p) => {
        seen.add(p);
        return { path: p, source: 'bash' as const };
      });
  return [...declared, ...pick(gitExtra), ...pick(scanBash)].slice(0, ARTIFACTS_CAP);
}

const SCAN_SKIP_DIRS = new Set(['node_modules']);
const SCAN_MAX_DEPTH = 6;
const SCAN_MAX_ENTRIES = 20000;

/** bash 兜底 mtime 扫描网（2026-11-14 用户实测:默认工作区非 git,git 差集面为空,bash 产件
 *  全漏）：有界遍历项目根,白名单扩展名 + mtime 落 [startedAtMs, endedAtMs] 轮窗即候选;
 *  跳过 node_modules 与点目录,深 6 层/2 万条目封顶;git 项目作差集的并集网（覆盖 ignored/
 *  未跟踪修改——差集对二类不可见）。stat/readdir 失败静默收窄（竞态删除不阻断收尾） */
export function scanDeliverableFiles(rootAbs: string, startedAtMs: number, endedAtMs: number): ChangeFile[] {
  const out: ChangeFile[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > SCAN_MAX_DEPTH || visited > SCAN_MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (visited > SCAN_MAX_ENTRIES) return;
      visited += 1;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.') || SCAN_SKIP_DIRS.has(ent.name)) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!ent.isFile() || !isDeliverablePath(ent.name)) continue;
      try {
        const m = fs.statSync(abs).mtimeMs;
        if (m >= startedAtMs && m <= endedAtMs) {
          out.push({ path: path.relative(rootAbs, abs).replaceAll('\\', '/'), status: 'added', added: null, deleted: null });
        }
      } catch {
        // stat 失败（竞态删除）:跳过
      }
    }
  };
  walk(rootAbs, 0);
  return out;
}

/** 产物库聚合行（2026-11-12 spec §6.2）：跨 run 按 path 去重保留最新 run（库语义），runSeq 倒序 */
export interface AggregatedArtifact {
  path: string;
  source: 'write' | 'edit' | 'bash';
  callId?: string;
  runSeq: number;
  endedTs?: number;
}

/** journal jsonl 行扫描 → 聚合（纯函数；内存当轮面由 session.artifactsAggregated 在其上合并）：
 *  run-open 行开轮记 seq，runmeta 行 artifacts 绑轮；坏行跳过（撕裂不阻断扫描） */
export function scanArtifactsJsonl(text: string): AggregatedArtifact[] {
  const best = new Map<string, AggregatedArtifact>();
  let openSeq = -1;
  for (const line of text.split('\n')) {
    if (!line.includes('"run-open"') && !line.includes('"runmeta"')) continue;
    try {
      const e = JSON.parse(line) as { t?: string; seq?: unknown; artifacts?: unknown; endedTs?: unknown };
      if (e.t === 'run-open') {
        openSeq = typeof e.seq === 'number' ? e.seq : openSeq;
        continue;
      }
      if (e.t !== 'runmeta' || e.seq !== undefined || openSeq < 0) continue;
      const artifacts = sanitizeArtifacts(e.artifacts);
      const endedTs = typeof e.endedTs === 'number' ? e.endedTs : undefined;
      if (artifacts === undefined) continue;
      for (const a of artifacts) {
        const prev = best.get(a.path);
        if (prev !== undefined && prev.runSeq >= openSeq) continue;
        best.set(a.path, {
          path: a.path,
          source: a.source,
          ...(a.callId !== undefined ? { callId: a.callId } : {}),
          runSeq: openSeq,
          ...(endedTs !== undefined ? { endedTs } : {}),
        });
      }
    } catch {
      // 坏行跳过（撕裂不阻断扫描,turnChangeFor 同款）
    }
  }
  return [...best.values()].sort((x, y) => y.runSeq - x.runSeq);
}

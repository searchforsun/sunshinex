/**
 * G14.2xx TUI 面私有态落盘（CLAUDE.md §13 持久化分层）：视图偏好与输入历史跨**进程**续命——
 * `<projects 根>/<工作区 slug>/tui/ui-state.json`（与 data/ 共享域平级的面私有子目录）。
 * 盘为真相源，内存 retain 只作缓存/加速；expandAll/todoExpanded 不入档（2026-09-30/10-01
 * 用户裁定：Tab opt-in 瞬态，落盘会把演示态带回下一进程）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveDataDir } from '../config/data-dir';

export interface TuiDiskState {
  /** 详情深度偏好（Ctrl+O 翻转；--continue 恢复路径同款语义） */
  latestFull?: boolean;
  /** 输入历史（↑↓ 续用；跨会话共享同一工作区——shell history 同位；cap 200 新者居尾） */
  history?: string[];
}

const HISTORY_CAP = 200;

/** 档位单点：<dataDir>（<slug>/data）的父目录即 slug 目录，面私有子目录 tui/ 与 data/ 平级 */
export function tuiStateFile(root: string): string {
  return path.join(path.dirname(resolveDataDir(root)), 'tui', 'ui-state.json');
}

/** 读档：缺档/坏 JSON/越型键一律容错丢弃（半写档由原子写杜绝，坏值不得炸启动） */
export function loadTuiDiskState(root: string): TuiDiskState {
  try {
    const raw = JSON.parse(fs.readFileSync(tuiStateFile(root), 'utf8')) as Record<string, unknown>;
    const out: TuiDiskState = {};
    if (typeof raw.latestFull === 'boolean') out.latestFull = raw.latestFull;
    if (Array.isArray(raw.history)) {
      out.history = raw.history.filter((h): h is string => typeof h === 'string').slice(-HISTORY_CAP);
    }
    return out;
  } catch {
    return {};
  }
}

/** 写档（读旧合并 + 临时文件 rename 原子落）：history 截尾 cap，半写档不成真相 */
export function saveTuiDiskState(root: string, patch: TuiDiskState): void {
  const merged: TuiDiskState = { ...loadTuiDiskState(root) };
  if (patch.latestFull !== undefined) merged.latestFull = patch.latestFull;
  if (patch.history !== undefined) merged.history = patch.history.slice(-HISTORY_CAP);
  const file = tuiStateFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged), 'utf8');
  fs.renameSync(tmp, file);
}

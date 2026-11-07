import * as fs from 'node:fs';
import * as path from 'node:path';
import { userConfigDir } from '../config/env';

/**
 * 终端回放落盘(2026-11-07 用户裁定「要看连续,不能接着跑可接受」):daemon 持有的 pty 环形缓冲
 * 在 daemon 生命周期内由 WS replay 帧回放;daemon 重启即进程全灭,该缓冲原本随之蒸发=重启后终端
 * 只剩新壳。此 store 把环形缓冲按 ptyId 落盘(`<userConfigDir>/pty-replay/`),新 pty 分配时凭
 * GUI 持有的死档 ptyId(prev)回种为初始环形内容——滚动区视觉连续(shell 无法跨 daemon 存活,
 * 命令不能接着跑,与 VSCode pty 宿主重启同边界)。尽力而为:落盘/读取失败静默(终端无损)。
 */

const dir = (): string => path.join(userConfigDir(), 'pty-replay');
const fileFor = (key: string): string => path.join(dir(), `replay-${key.replace(/[^A-Za-z0-9_-]+/g, '_')}.txt`);

export function saveReplay(key: string, text: string): void {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(fileFor(key), text, 'utf8');
  } catch {
    /* 只读盘/配额:终端无损,静默 */
  }
}

export function loadReplay(key: string): string | undefined {
  try {
    return fs.readFileSync(fileFor(key), 'utf8');
  } catch {
    return undefined;
  }
}

export function clearReplay(key: string): void {
  try {
    fs.unlinkSync(fileFor(key));
  } catch {
    /* 缺档即已清 */
  }
}

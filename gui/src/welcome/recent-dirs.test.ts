import { describe, it, expect, beforeEach } from 'vitest';
import { pruneRecentDirs, readRecentDirs, rememberDir } from './recent-dirs';

/** 浏览目录历史（2026-11-21 用户需求：浏览过的目录持久化进下拉框，切会话/重启后仍可选） */
describe('recent-dirs', () => {
  beforeEach(() => localStorage.clear());

  it('MRU 置顶 + 大小写去重 + 封顶 8 + 跳过空串/default', () => {
    expect(readRecentDirs()).toEqual([]);
    rememberDir('D:/a');
    expect(rememberDir('D:/b')).toEqual(['D:/b', 'D:/a']);
    expect(rememberDir('d:/A')).toEqual(['d:/A', 'D:/b']); // 大小写归一命中旧条，移到首位
    rememberDir('');
    rememberDir('default');
    expect(readRecentDirs()).toEqual(['d:/A', 'D:/b']);
    for (let i = 0; i < 10; i += 1) rememberDir(`D:/x${i}`);
    expect(readRecentDirs()).toHaveLength(8);
    expect(readRecentDirs()[0]).toBe('D:/x9');
  });

  it('坏档宽容：非法 JSON/非数组 → 空列不抛', () => {
    localStorage.setItem('sunshinex.recent-dirs', '{oops');
    expect(readRecentDirs()).toEqual([]);
    localStorage.setItem('sunshinex.recent-dirs', '{"a":1}');
    expect(readRecentDirs()).toEqual([]);
  });
});

describe('recent-dirs 存在性剪枝(2026-11-21 用户补充:文件夹被删除时打开即剔除)', () => {
  beforeEach(() => localStorage.clear());

  it('不存在的条目被剔除并落盘;存活项保序', () => {
    rememberDir('D:/keep');
    rememberDir('D:/gone');
    const next = pruneRecentDirs((p) => p === 'D:/keep');
    expect(next).toEqual(['D:/keep']);
    expect(readRecentDirs()).toEqual(['D:/keep']);
  });
});

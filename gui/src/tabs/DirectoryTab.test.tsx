/**
 * DirectoryTab 组件级测试(自 App.test G8b 目录标签簇下沉——2026-10-27 目录页签退役,树挪入
 * 左菜单 dirview 后,App 级「+菜单开目录」入口不存在;树惰拉/截断/重试/会话切换重置行为在
 * 组件面 verbatim 承接。文件行开标签经 openTab 回调断言,不再经 App 标签条)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DirectoryTab } from './DirectoryTab';
import type { Connection, TreeResp } from '../connection';
// 语言由 test-setup 钉 en(断言面以 en 书写)

/** 目录树桩:treeByPath(会话无关)/treeBySession(会话维)/treeReject(错误注入);调用记录 */
interface TreeStub {
  treeCalls: Array<[string, string]>;
  openTabCalls: Array<[string, { path?: string } | undefined]>;
  treeByPath: Record<string, TreeResp>;
  treeBySession: Record<string, Record<string, TreeResp>>;
  treeReject: Error | null;
  tree(sessionId: string, path?: string): Promise<TreeResp>;
}

function stubConn(): { conn: Connection & TreeStub; treeCalls: Array<[string, string]>; openTabCalls: Array<[string, { path?: string } | undefined]> } {
  const treeCalls: Array<[string, string]> = [];
  const openTabCalls: Array<[string, { path?: string } | undefined]> = [];
  const conn = {
    treeCalls,
    openTabCalls,
    treeByPath: {} as Record<string, TreeResp>,
    treeBySession: {} as Record<string, Record<string, TreeResp>>,
    treeReject: null as Error | null,
    tree(sessionId: string, path?: string): Promise<TreeResp> {
      treeCalls.push([sessionId, path ?? '']);
      if (this.treeReject !== null) return Promise.reject(this.treeReject);
      const p = path ?? '';
      const bySession = this.treeBySession[sessionId]?.[p];
      if (bySession !== undefined) return Promise.resolve(bySession);
      return Promise.resolve(this.treeByPath[p] ?? { entries: [] });
    },
  };
  return { conn: conn as Connection & TreeStub, treeCalls, openTabCalls };
}

function mountTab(conn: Connection, sessionId: string, openTabCalls: Array<[string, { path?: string } | undefined]>): void {
  render(
    <DirectoryTab
      conn={conn}
      sessionId={sessionId}
      root="/w/root-a"
      openTab={(type, params) => openTabCalls.push([type, params])}
    />,
  );
}

const click = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};

beforeEach(cleanup);

describe('DirectoryTab(左菜单 dirview 承载的目录树;原 G8b 目录标签簇)', () => {
  it('mount 拉 root → 展开 dirA 惰拉单层 → 点文件行走 openTab(file);收起保留缓存零重拉', async () => {
    const { conn, treeCalls, openTabCalls } = stubConn();
    conn.treeByPath = {
      '': { entries: [{ name: 'dirA', kind: 'dir' }, { name: 'fileB.ts', kind: 'file' }] },
      dirA: { entries: [{ name: 'fileA.ts', kind: 'file' }] },
    };
    mountTab(conn, 's1', openTabCalls);
    // mount 拉 root:tree(s1, '') 一笔;根级行列表在场(目录行+文件行)
    await waitFor(() => expect(treeCalls).toEqual([['s1', '']]));
    expect(screen.getByRole('button', { name: 'dirA' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'fileB.ts' })).toBeDefined();
    // 展开 dirA:惰拉单层(path 拼合 = name)→ 子文件行在场
    click('dirA');
    await waitFor(() => expect(treeCalls).toEqual([['s1', ''], ['s1', 'dirA']]));
    expect(screen.getByRole('button', { name: 'fileA.ts' })).toBeDefined();
    // 收起:子层退场但缓存保留——再展开不再拉(treeCalls 仍两笔)
    click('dirA');
    expect(screen.queryByRole('button', { name: 'fileA.ts' })).toBeNull();
    click('dirA');
    expect(screen.getByRole('button', { name: 'fileA.ts' })).toBeDefined();
    expect(treeCalls).toHaveLength(2);
    // 点文件行:openTab('file', { path: 'dirA/fileA.ts' })
    click('fileA.ts');
    expect(openTabCalls).toEqual([['file', { path: 'dirA/fileA.ts' }]]);
  });

  it('truncated 标记:桩返 truncated:true → 行尾「…已截断」;子层拉失败 → 行内错误消息', async () => {
    const { conn, openTabCalls } = stubConn();
    conn.treeByPath = { '': { entries: [{ name: 'dirA', kind: 'dir' }], truncated: true } };
    mountTab(conn, 's1', openTabCalls);
    await waitFor(() => expect(screen.getByText(/已截断|truncated/)).toBeDefined()); // root 级截断标记
    conn.treeReject = new Error('/session/s1/tree?path=dirA -> 404');
    click('dirA');
    await waitFor(() => expect(screen.getByText('/session/s1/tree?path=dirA -> 404')).toBeDefined()); // 行内错误态
  });

  it('错误层重试:展开失败 → 收起再展开重拉(错误态缓存不命中跳过)→ 第二笔成功行在场', async () => {
    const { conn, treeCalls, openTabCalls } = stubConn();
    conn.treeByPath = {
      '': { entries: [{ name: 'dirA', kind: 'dir' }] },
      dirA: { entries: [{ name: 'fileA.ts', kind: 'file' }] },
    };
    mountTab(conn, 's1', openTabCalls);
    await waitFor(() => expect(screen.getByRole('button', { name: 'dirA' })).toBeDefined());
    // 首拉 dirA 失败:层落 error 行内态
    conn.treeReject = new Error('/session/s1/tree?path=dirA -> 500');
    click('dirA');
    await waitFor(() => expect(screen.getByText('/session/s1/tree?path=dirA -> 500')).toBeDefined());
    // 收起再展开:错误层清除重拉(而非 nodes.has 命中跳过)→ 第二笔 dirA 成功 → 子文件行在场
    conn.treeReject = null;
    click('dirA'); // 收起
    click('dirA'); // 再展开 → 重拉
    await waitFor(() => expect(screen.getByRole('button', { name: 'fileA.ts' })).toBeDefined());
    expect(treeCalls).toEqual([['s1', ''], ['s1', 'dirA'], ['s1', 'dirA']]); // dirA 两笔(重试面)
  });

  it('会话切换:层缓存+展开集随 sessionId 整体重置 + root 重拉——前会话陈旧子层根除', async () => {
    const { conn, treeCalls, openTabCalls } = stubConn();
    // 两会话同名目录 dirA 而子层各异(s1 层=fileA.ts / s2 层=fileB.ts)——陈旧层缓存唯一可观测形
    conn.treeBySession = {
      s1: {
        '': { entries: [{ name: 'dirA', kind: 'dir' }] },
        dirA: { entries: [{ name: 'fileA.ts', kind: 'file' }] },
      },
      s2: {
        '': { entries: [{ name: 'dirA', kind: 'dir' }] },
        dirA: { entries: [{ name: 'fileB.ts', kind: 'file' }] },
      },
    };
    const { rerender } = render(
      <DirectoryTab conn={conn} sessionId="s1" root="/w/root-a" openTab={(type, params) => openTabCalls.push([type, params])} />,
    );
    await waitFor(() => expect(treeCalls).toEqual([['s1', '']]));
    click('dirA');
    await waitFor(() => expect(treeCalls).toEqual([['s1', ''], ['s1', 'dirA']]));
    expect(screen.getByRole('button', { name: 'fileA.ts' })).toBeDefined();
    // 直切 s2:重挂面(key 变更)由父层保证;本契约断言 sessionId prop 变更即整体重置
    rerender(
      <DirectoryTab conn={conn} sessionId="s2" root="/w/root-a" openTab={(type, params) => openTabCalls.push([type, params])} />,
    );
    await waitFor(() => expect(treeCalls).toEqual([['s1', ''], ['s1', 'dirA'], ['s2', '']]));
    expect(screen.queryByRole('button', { name: 'fileA.ts' })).toBeNull(); // 展开集已清:未展开不渲染
    click('dirA');
    await waitFor(() => expect(treeCalls).toEqual([['s1', ''], ['s1', 'dirA'], ['s2', ''], ['s2', 'dirA']]));
    expect(screen.getByRole('button', { name: 'fileB.ts' })).toBeDefined(); // s2 层(非陈旧 s1 层)
    expect(screen.queryByRole('button', { name: 'fileA.ts' })).toBeNull();
    // 文件行以当前会话寻址开档(openTab 面;readFile 寻址由 App 侧标签体承接)
    click('fileB.ts');
    expect(openTabCalls).toEqual([['file', { path: 'dirA/fileB.ts' }]]);
  });
});

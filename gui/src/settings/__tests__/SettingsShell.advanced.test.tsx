import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsShell } from '../SettingsShell';
import { applyDeveloperMode } from '../../developer-mode';

/**
 * Task 3 设置导航分层:高级组(含 MCP)仅在开发者模式开启时渲染;
 * 普通态(默认关)导航不出现高级项。conn 桩按 SettingsShellConn 成员结构完整
 * (壳挂载即调 workspaces()/onConfigChanged;缺名会运行期炸),写面零消费形即可。
 */
const EMPTY_PERMISSIONS = { merged: { deny: [], allow: [], additionalDirs: [] }, project: { deny: [], allow: [], additionalDirs: [] }, global: { deny: [], allow: [], additionalDirs: [] } };
const EMPTY_SETTINGS = { keys: [], permissions: EMPTY_PERMISSIONS, providers: { choices: [], apiKeyPresent: {}, warnings: [] } };

const conn = {
  settings: () => Promise.resolve(EMPTY_SETTINGS),
  putSettings: () => Promise.resolve(),
  memoryStats: () => Promise.resolve({ entries: 0, lastWriteAt: null }),
  settingsRaw: () => Promise.resolve({ content: null }),
  putSettingsRaw: () => Promise.resolve(),
  mcpServers: () => Promise.resolve({ servers: [] }),
  mcpProbe: () => Promise.resolve({ ok: true, tools: [] }),
  putMcpOp: () => Promise.resolve(),
  plugins: () => Promise.resolve({ plugins: [] }),
  putPlugin: () => Promise.resolve(),
  agentsView: () => Promise.resolve({ builtins: [], view: { agents: [] } }),
  putAgentOp: () => Promise.resolve(),
  agentBody: () => Promise.resolve({ body: '' }),
  teamsView: () => Promise.resolve({ view: { teams: [] } }),
  putTeamOp: () => Promise.resolve(),
  teamBody: () => Promise.resolve({ body: '' }),
  skillsGroups: () => Promise.resolve({ groups: [] }),
  putProviderOp: () => Promise.resolve(),
  putPermissionOp: () => Promise.resolve(),
  sunshineGet: () => Promise.resolve({ content: '', path: '', exists: false }),
  sunshinePut: () => Promise.resolve(),
  onConfigChanged: () => () => undefined,
  workspaces: () => Promise.resolve([]),
} as unknown as Parameters<typeof SettingsShell>[0]['conn'];

describe('设置导航高级组分层', () => {
  it('普通态不渲染高级导航项;开启开发者模式后渲染', async () => {
    applyDeveloperMode(false);
    const first = render(<SettingsShell conn={conn} root="" onBack={vi.fn()} />);
    expect(await screen.findByText('Developer mode')).toBeDefined(); // 等设置面板落定(act 窗口内)
    expect(screen.queryByText('MCP')).toBeNull();
    first.unmount();
    applyDeveloperMode(true);
    const second = render(<SettingsShell conn={conn} root="" onBack={vi.fn()} />);
    expect(await screen.findByText('MCP')).toBeDefined();
    second.unmount();
    applyDeveloperMode(false);
  });
});

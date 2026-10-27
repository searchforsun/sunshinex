import { describe, expect, it } from 'vitest';
// 真 manifest 直接导入(vite 原生 JSON 装载,相对模块文件解析——vitest jsdom 下 import.meta.url
// 非 file 协议,fs+URL 拼路径不可用);跨包读取仅测试面,生产零依赖
import manifest from '../../../../plugins/computer-use/plugin.json';
import { COMPUTER_USE_ACT_TOOLS, COMPUTER_USE_PREFIX, COMPUTER_USE_SERVER, isComputerUseControlTool } from './computer-use-contract';

/** 电脑控制徽标判定面(2026-10-27):server 名+动作集与 plugins/computer-use/plugin.json 的
 *  safety.act 声明同源——观察(screenshot/uia_snapshot/window_list)、被动(wait/wait_for)、
 *  他 server 工具、缺名不点亮;控制类六动作全点亮 */
describe('isComputerUseControlTool(顶栏「正在控制」判定)', () => {
  it('computer-use 控制类动作点亮(act 六件)', () => {
    for (const tool of ['click', 'type', 'key', 'scroll', 'drag', 'app']) {
      expect(isComputerUseControlTool(`mcp__computer-use__${tool}`)).toBe(true);
    }
  });
  it('观察/被动工具不点亮(confirm/observe/未声明)', () => {
    expect(isComputerUseControlTool('mcp__computer-use__screenshot')).toBe(false);
    expect(isComputerUseControlTool('mcp__computer-use__uia_snapshot')).toBe(false);
    expect(isComputerUseControlTool('mcp__computer-use__window_list')).toBe(false);
    expect(isComputerUseControlTool('mcp__computer-use__wait')).toBe(false);
    expect(isComputerUseControlTool('mcp__computer-use__wait_for')).toBe(false);
  });
  it('他 server/裸名/前缀近似/缺名不点亮', () => {
    expect(isComputerUseControlTool('mcp__browser-use__browser_click')).toBe(false);
    expect(isComputerUseControlTool('mcp__computer-use__click_extra')).toBe(false);
    expect(isComputerUseControlTool('mcp__computer-use-x__click')).toBe(false);
    expect(isComputerUseControlTool('exec')).toBe(false);
    expect(isComputerUseControlTool(undefined)).toBe(false);
  });
});

/** G3/G4 双源锁(2026-10-27 技术债轮):契约镜像字面量 × 真 manifest 对拍——插件侧 id/safety.act
 *  变更不更新 computer-use-contract 即测红,徽标/工具行图标不再可能静默失明(跨包无构建期生成,
 *  测试对拍是唯一锁)。safety 声明挂在 mcpServers['computer-use'] 条目上(manifest 形态) */
describe('computer-use-contract × plugin.json 镜像对拍', () => {
  const cu = (manifest as { id: string; mcpServers: Record<string, { safety: { act: string[] } }> }).mcpServers['computer-use'];

  it('server 名 = manifest id;前缀由 server 名派生', () => {
    expect(COMPUTER_USE_SERVER).toBe((manifest as { id: string }).id);
    expect(COMPUTER_USE_PREFIX).toBe(`mcp__${(manifest as { id: string }).id}__`);
  });
  it('动作集 = manifest mcpServers[computer-use].safety.act(集合相等,顺序不锁)', () => {
    expect([...COMPUTER_USE_ACT_TOOLS].sort()).toEqual([...cu.safety.act].sort());
  });
});

import { describe, expect, it } from 'vitest';
import { isComputerUseControlTool } from './use-chat-derived';

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

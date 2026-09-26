import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { ChatRequest, ChatResult } from '../../types';
import { ModelAdapter } from '../../model/adapter';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 可控挂起模型桩：chatStream 先流式出正文再挂起（status 停在 running、phase=responding），release 后以 done 收束。
 *  onEventForTest 直发事件不翻 status（恒为 idle），活动行渲染条件 status==='running' 需真实提交通道驱动。
 *  release 闩锁语义：释放先于模型调用到达（✻ 上屏早于 chatStream 挂钩）也生效——闩住标记，挂钩时立即 resolve。 */
function gatedModel(): { adapter: ModelAdapter; release: () => void } {
  let released = false;
  let releaseFn: (() => void) | undefined;
  const finish: ChatResult = { finish: 'stop', content: '终稿', toolCalls: [] };
  const arm = (resolve: (r: ChatResult) => void): void => {
    if (released) resolve(finish);
    else releaseFn = () => resolve(finish);
  };
  const adapter: ModelAdapter = {
    provider: 'gated-spinner-stub',
    chat(_req: ChatRequest): Promise<ChatResult> {
      return new Promise(arm);
    },
    chatStream(_req: ChatRequest, onDelta: (t: string) => void): Promise<ChatResult> {
      onDelta('第一段正文');
      return new Promise(arm);
    },
  };
  return { adapter, release: () => { released = true; releaseFn?.(); } };
}

// 恒显活动行（2026-09-27 用户裁决 A 形态，对标 CC）：任务运行全程动态区常驻 ✻ 计时·tokens 跳动行，
// 正文流式（responding）期与 reasoning 长静默期均有「活着」信号，消除「疑似卡死」观感。
// 旧条件 phase!=='responding' 曾把流式期活动行整段排除、静默期动态区零跳动。
test('App：responding 期活动行常驻（恒显，正文与活动行同屏）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-alwaysspinner-'));
  try {
    const { adapter, release } = gatedModel();
    const ctrl = new SessionController({ root: tmp, model: adapter });
    const term = render(<App controller={ctrl} />);
    void ctrl.submit('跑一个长思考任务').catch(() => {});
    for (let i = 0; i < 40 && !(term.lastFrame() ?? '').includes('✻'); i++) await sleep(25);
    assert.match(term.lastFrame() ?? '', /✻/, '运行中活动行在场（thinking/responding 均常驻）');
    for (let i = 0; i < 40 && !(term.lastFrame() ?? '').includes('第一段正文'); i++) await sleep(25);
    const frame = term.lastFrame() ?? '';
    assert.match(frame, /第一段正文/, '流式正文在帧内（responding 期）');
    assert.match(frame, /✻/, 'responding 期活动行仍常驻（不再被 phase 条件排除）');
    release();
    await ctrl.waitIdle();
    term.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：done 后活动行退场（idle 无跳动行）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-alwaysspinner2-'));
  try {
    const { adapter, release } = gatedModel();
    const ctrl = new SessionController({ root: tmp, model: adapter });
    const term = render(<App controller={ctrl} />);
    void ctrl.submit('任务').catch(() => {});
    for (let i = 0; i < 40 && !(term.lastFrame() ?? '').includes('✻'); i++) await sleep(25);
    assert.match(term.lastFrame() ?? '', /✻/, '运行中活动行在场');
    release();
    await ctrl.waitIdle();
    await sleep(80);
    assert.ok(!(term.lastFrame() ?? '').includes('✻'), '终态后活动行退场');
    term.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

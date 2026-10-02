import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { runTuiLoop, InkLikeInstance } from '../tui-loop';
import { App } from './App';
import { SessionController } from '../session';
import { render } from '../test-ink';

/**
 * 生产编排级钉（2026-10-02 真机「已归档的进入要先 Enter」）：真实 runTuiLoop 卸载→清屏→重挂路径 +
 * 真实 App + 真实 SessionController。病根：setInspectRetained 的 setState 在注定卸载的旧树上同步提交
 * 一次整帧渲染且 ink 写进 stdout——归档转录（一次性最大帧）双重倾泻（旧实例一帧 + 清屏 + 重挂重放一帧），
 * conpty 冻结 + 半秒级空窗，用户补按的 Enter 被 inspect 分支静默吞掉。钉：进入前实例的 stdout 不得
 * 含归档转录（转录只在重挂后的新实例出现一次）。
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('生产编排：browse-Enter 进归档视图——转录单次倾泻（旧实例不写注定废弃的巨帧）+ inspect 态跨重挂保留', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-archrepro-'));
  try {
    // 已归档 spawn 行：子代理事件流建 ChildLiveState（转录带独占标记串）→ spawn 调用/结果配对归档
    // （detail=subagentMeta+transcript 折入调用行，browseRows archived 过滤条件）
    const DETAIL_MARK = 'ARCHIVED-TRANSCRIPT-MARK';
    const ctrl = new SessionController({ root: tmp });
    ctrl.onEventForTest({ type: 'token', text: `${DETAIL_MARK}\n`, payload: { subagent: 'Research' } } as never);
    ctrl.onEventForTest({ type: 'tool-call', text: 'SPAWN Research', payload: { input: { prompt: '调研' }, callId: 'c1' } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'done', payload: { ok: true, subagent: 'Research', callId: 'c1' } } as never);

    const resizeSource = new EventEmitter() as never;
    const terms: ReturnType<typeof render>[] = [];
    // ink 实例适配（FakeInstance 同款语义）：unmount 即 resolve waitUntilExit——循环据此重挂
    const adapt = (term: ReturnType<typeof render>): InkLikeInstance => {
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => (resolveExit = resolve));
      return {
        waitUntilExit: () => exited,
        unmount: () => { term.unmount(); resolveExit(); },
      };
    };
    // 生产同构：requestRepaint 通道在首挂前注入（runTuiLoop 装配序），App 经通道触发卸载→重挂
    let repaint: ((mode?: 'full' | 'tail') => void) | undefined;
    const loop = runTuiLoop({
      stdout: resizeSource,
      clearScreen: () => {},
      onRequestRepaint: (req) => { repaint = req; },
      renderOnce: (r) => {
        const term = render(<App controller={ctrl} retain={r} onRequestRepaint={repaint} />);
        terms.push(term);
        return adapt(term);
      },
    });
    void loop;
    await sleep(80);
    const before = terms.length;
    // Ctrl+B → Enter（唯一行=归档行，光标缺省在）→ 进归档视图 → 卸载→清屏→重挂
    terms[terms.length - 1]!.write('\u0002');
    await sleep(60);
    terms[terms.length - 1]!.write('\r');
    await sleep(250); // 重挂窗口
    // 重挂后 inspect 保留：屏上是归档全屏视图
    const cur = terms[terms.length - 1]!;
    const f1 = cur.lastFrame() ?? '';
    assert.ok(f1.includes('子代理视图') || f1.includes('subagent view'), '重挂后屏上是归档全屏视图');
    // 双重倾泻钉：进入前实例（含同步废弃渲染窗口）的 stdout 不得含转录标记——只允许重挂后新实例写一次
    for (let i = 0; i < before; i++) {
      assert.ok(!terms[i]!.allOutput().includes(DETAIL_MARK), `旧实例 #${i} 不得写归档转录（注定废弃的 setState 巨帧）`);
    }
    assert.ok(cur.allOutput().includes(DETAIL_MARK), '重挂后的新实例呈现转录（唯一一次倾泻）');
    // inspect 分支接管验证：Esc 退出归档视图
    cur.write('\u001B');
    await sleep(120);
    const f2 = terms[terms.length - 1]!.lastFrame() ?? '';
    assert.ok(!(f2.includes('子代理视图') || f2.includes('subagent view')), 'Esc 从归档视图退出（inspect 分支在接管）');
    terms[terms.length - 1]!.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

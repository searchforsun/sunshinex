import * as React from 'react';
import { SessionController, TuiState } from '../session';
import { RetainedUiState } from '../ui-state';
import type { RepaintMode } from '../tui-loop';
import { keyTrace } from './use-input';
import type { RawKey } from './use-input';

/** 全屏查看目标（规格 §3.3，与 RetainedUiState.inspect 同构）：live=运行中子代理（实时流式）、
 *  archived=已归档 spawn 调用行（detail 回看） */
export type InspectTarget = { kind: 'live'; label: string } | { kind: 'archived'; seq: number };

/** inspect 模态键分发 hook（D17-H2 拆自 App useInput 第 1 层，行为零变化）：
 *  收编全屏查看态的整段按键分支及其专属状态（inspect / inspectExpanded / setInspectRetained）。
 *  在场时整页让位、**恒吞键**（纯只读视图，其余键不落输入缓冲）；共享的会话状态经 stateRef 传入不复制 */
export function useInspectKeys({
  controller,
  stateRef,
  store,
  onRequestRepaint,
}: {
  controller: SessionController;
  /** 键分发 ref 真值（App 持有）：子面板更新走 notifyThrottled 节流，处理器闭包的 state 可能滞后节流一拍 */
  stateRef: React.MutableRefObject<TuiState>;
  store: RetainedUiState;
  onRequestRepaint?: (mode?: RepaintMode) => void;
}): {
  /** 当前查看目标（渲染：MessageList 让位 + ChildInspector 数据源） */
  inspect: InspectTarget | undefined;
  /** 全屏查看 Tab 两态（完整时间线缺省 / Tab 收起为正文形态） */
  inspectExpanded: boolean;
  inspectRef: React.MutableRefObject<InspectTarget | undefined>;
  setInspectRetained: (v: InspectTarget | undefined) => void;
  /** 模态接管（判定序第 1 位）：在场恒 true（吞键），不在场 false 交下一位 */
  handleKey: (input: string, key: RawKey) => boolean;
} {
  // 全屏查看模式（规格 §3.3）：live=运行中子代理（实时流式）、archived=已归档 spawn 调用行（detail 回看）；
  // ref 真值同 browse 先例（useInput 处理器闭包滞后），在场时整页让位（MessageList 保持挂载 live 让位零 Static 重放）
  const [inspect, setInspect] = React.useState<InspectTarget | undefined>(store.inspect);
  // 全屏查看 Tab 两态（2026-09-28 用户裁决：完整时间线缺省，Tab 收起为正文形态）——经 retain 跨重挂保留，
  // 与 browseMode 同款「动态区自绘零重挂」承载，inspect 进入时复位为完整时间线
  const [inspectExpanded, setInspectExpanded] = React.useState<boolean>(store.inspectExpanded ?? false);
  const inspectExpandedRef = React.useRef(inspectExpanded);
  inspectExpandedRef.current = inspectExpanded;
  const inspectRef = React.useRef(inspect);
  inspectRef.current = inspect;
  const setInspectRetained = (v: InspectTarget | undefined): void => {
    keyTrace(`setInspect ${JSON.stringify(v)}`);
    inspectRef.current = v;
    store.inspect = v;
    // 生产路径（有 repaint 通道）：跳过 setState——本调用紧随 onRequestRepaint 同步卸载，setState
    // 会在注定废弃的旧树上同步提交一次整帧渲染（归档视图=一次性最大帧，真机 280ms+）且 ink 把这帧
    // **写进 stdout**，随后 clearScreen 重挂又整份重放——同一转录双重倾泻（conpty 冻结+闪屏，真机
    // 「归档进入要先 Enter」病根：半秒级空窗内用户补按的 Enter 被 inspect 分支静默吞掉）。状态由重挂
    // 从 store 读（store 先写不变式的终点形态）。无通道（部分测试直挂）：原地 setState 维持旧语义
    if (onRequestRepaint) {
      setInspectExpanded(false);
      store.inspectExpanded = false;
      onRequestRepaint();
      return;
    }
    setInspect(v);
    setInspectExpanded(false); // 每次进入复位折叠态（缺省态，对标主 agent 折叠位；store 同步防重挂回旧值）
    store.inspectExpanded = false;
  };
  // 全屏查看模式（规格 §3.3）：最前置接管——Esc 退出恢复主界面，Tab 切「折叠 ↔ 完整时间线」两态
  //（2026-09-29 Static 时间线化后经生产 repaint 整屏重放，对标主 agent Tab；store 持久化跨重挂保留），
  // 其余键吞掉不落输入缓冲（纯只读视图，不支持再次会话）
  const handleKey = (input: string, key: RawKey): boolean => {
    if (!inspectRef.current) return false;
    // Ctrl+C 作用域=本视图（2026-10-02 用户裁决「子agent暂停导致主agent也中断了」）：live 视图两次
    // Ctrl+C=停【此子代理】（账本单点停，主链零影响、TASK_WAIT 收 stopped 终态自判续跑）——不再走
    // 主任务 interrupt（旧口径「主链连带子代理」把收尾中的主链一并杀死：真机 4 子代理全完成后主链被杀）。
    // 归档回看无在跑目标：有卡撤卡防死键、无卡不挂（只读视图口径）
    if (key.ctrl && input === 'c') {
      const liveLabel = inspectRef.current.kind === 'live' ? inspectRef.current.label : undefined;
      if (liveLabel !== undefined) {
        if (stateRef.current.pauseConfirm) { keyTrace(`inspect child-stop ${liveLabel}`); controller.stopChild(liveLabel); controller.cancelPause(); return true; }
        keyTrace('inspect pause-hang (child)');
        controller.hangPauseCard();
        return true;
      }
      if (stateRef.current.pauseConfirm) { keyTrace('inspect pause-cancel (archived)'); controller.cancelPause(); }
      return true;
    }
    // Esc 撤卡优先（对齐主视图 Esc 分层与提示条「Esc 继续运行」承诺）：卡在场先撤卡、视图不动；
    // 无卡才退出全屏。旧实现无条件退出——pauseConfirm 悬空带回主视图，其后任一 Ctrl+C 都被当
    // 「第二次确认」直接中断（2026-10-02 真机日志实锤：挂卡 52 秒跨两次视图进出后主视图一按即杀任务）
    if (key.escape) {
      if (stateRef.current.pauseConfirm) { keyTrace('inspect pause-cancel'); controller.cancelPause(); return true; }
      keyTrace('inspect esc-exit'); setInspectRetained(undefined); return true;
    }
    if (key.tab) {
      keyTrace(`inspect tab-toggle -> ${!inspectExpandedRef.current}`);
      const next = !inspectExpandedRef.current;
      inspectExpandedRef.current = next;
      store.inspectExpanded = next;
      setInspectExpanded(next);
      onRequestRepaint?.();
      return true;
    }
    return true;
  };
  return { inspect, inspectExpanded, inspectRef, setInspectRetained, handleKey };
}

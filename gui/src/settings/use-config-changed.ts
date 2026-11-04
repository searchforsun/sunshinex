import { useEffect, useState } from 'react';
import type { ResourceKind } from '../../../src/catalog/types';
import type { ConfigChangedInfo } from '../connection-types';

/** 帧载荷类型再出口(hook 单一消费面——pane 侧不必探 connection-types) */
export type { ConfigChangedInfo };

/**
 * Task 21 config-changed 订阅 hook(双向实时同步 GUI 侧收口,daemon 下行帧见 src/serve/
 * daemon-wire.ts ConfigChangedFrame——T14 交付):WS `config-changed` 帧按 resource 合并 200ms
 * 后递增对应计数,返回 `Record<ResourceKind, number>`——pane 以自身 resource 的 tick 变化为
 * 外部改动信号触发重拉(useEffect 依赖该数字即可,零轮询)。
 *
 * connection 挂钩面(热区最小接触):`Connection.onConfigChanged(cb): () => void` 注册点
 * (connection.ts 单点,transport 帧分发处一个可选回调分支,不动帧主流程)。本 hook 挂载期
 * 注册、卸载期退订并撤销在途合帧窗。
 *
 * 契约注意:
 * - 合并语义=同 resource 200ms 窗内多帧只递增一次(尾帧起算);异 resource 各自独立窗。
 * - 未知 resource 帧(旧/新 daemon 增量资源)静默忽略——gui 未建模的资源不产生 tick。
 * - `conn.onConfigChanged` 运行期缺名(旧测试桩/降级面)不订阅、恒零 tick——守卫让既有
 *   App.test FakeConn 等桩零改动续跑(设置壳挂载 useConfigChanged 不炸)。
 */

/** 合并窗(毫秒):同 resource 帧到达间隔小于此值合并为单次 tick 递增 */
export const CONFIG_CHANGED_DEBOUNCE_MS = 200;

/** 订阅源窄面(Connection 结构满足即收;pane conn 面未含时经 SettingsShellConn 并入) */
export interface ConfigChangedSource {
  onConfigChanged(cb: (f: ConfigChangedInfo) => void): () => void;
}

/** 全零 tick 初值(useState 惰性初始化单点;键序=ResourceKind 全集) */
function zeroTicks(): Record<ResourceKind, number> {
  // 2026-11-04 teams 键随并行 teams-catalog ResourceKind 扩档补零(临时解堵:该 WIP 未落此面)
  return { mcp: 0, agents: 0, teams: 0, plugins: 0, skills: 0, providers: 0, permissions: 0, settings: 0 };
}

/** 资源种类全集(守卫面零分配——帧热路径不建对象) */
const RESOURCE_KEYS: ReadonlyArray<ResourceKind> = ['mcp', 'agents', 'teams', 'plugins', 'skills', 'providers', 'permissions', 'settings'];

/** 资源种类守卫:gui 建模外的 resource 字符串归 null(帧静默忽略) */
function asResourceKind(v: string): ResourceKind | null {
  return (RESOURCE_KEYS as readonly string[]).includes(v) ? (v as ResourceKind) : null;
}

/** 订阅 WS config-changed → 按 resource 合并 200ms 的 tick 计数(pane 重拉信号源)。
 *  conn 对象身份恒定(App 侧单例连接)——effect 只随挂载/卸载跑一次 */
export function useConfigChanged(conn: ConfigChangedSource): Record<ResourceKind, number> {
  const [ticks, setTicks] = useState<Record<ResourceKind, number>>(zeroTicks);
  useEffect(() => {
    if (typeof conn.onConfigChanged !== 'function') return; // 旧桩/降级面:不订阅(恒零 tick)
    const pending = new Map<ResourceKind, ReturnType<typeof setTimeout>>();
    const off = conn.onConfigChanged((f) => {
      const kind = asResourceKind(f.resource);
      if (kind === null) return; // 未知资源忽略
      // 真尾随防抖(与 SearchBar 同语义,尾帧起算):窗内新帧重起 200ms 表——文档契约即此,
      // 首帧起算(leading-edge)会让突发首帧独自提前定tick,窗外尾帧反被漏并
      const old = pending.get(kind);
      if (old !== undefined) clearTimeout(old);
      pending.set(
        kind,
        setTimeout(() => {
          pending.delete(kind);
          setTicks((prev) => ({ ...prev, [kind]: prev[kind] + 1 }));
        }, CONFIG_CHANGED_DEBOUNCE_MS),
      );
    });
    return () => {
      off();
      for (const tm of pending.values()) clearTimeout(tm);
      pending.clear();
    };
  }, [conn]);
  return ticks;
}

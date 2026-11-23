/**
 * 布尔偏好工厂单点（D84 收敛，2026-11-23 续轮）：原 usage-stats/artifact-cards/concise-mode/
 * change-cards/session-info-cards/dark-surfaces 六件「LS_KEY + 根 data 属性 + listeners Set +
 * useSyncExternalStore + notifyUiPref 双写 + try/catch 静默持久化」手写克隆（~370 行）收敛为
 * 七实例参数表。语义轴：缺省值 / 属性极性（presence '1' vs 反极性 '0'）/ 开发者模式派生
 * （普通态恒缺省值，存储值仅开发者模式生效；attr 若在按有效值落）/ 属性缺席（纯 store 形）。
 * 依赖方向：本模块 ← ui-pref-sync（单向，notifyUiPref 经 bindBooleanPrefNotify 模块装载回填
 * ——反向 import 即成环，appliers 注入同款先例）。新增布尔偏好=本文件一份 spec（PREFS+
 * BOOLEAN_PREF_KEYS 两处同文件登记），ui-pref-sync/use-appearance-sync 零新增。
 * developer-mode=门源头本身、ui-mode=枚举变体，各留守原模块。
 */
import { useSyncExternalStore } from 'react';

export type BooleanPrefKey =
  | 'usageStats'
  | 'artifactCards'
  | 'conciseMode'
  | 'changeCards'
  | 'sessionInfoCards'
  | 'darkBubbles'
  | 'darkCode';

export interface BooleanPref {
  readonly key: BooleanPrefKey;
  /** 公共档/localStorage 键（ui-pref-sync LOCAL_KEYS 布尔段自此生成） */
  readonly lsKey: string;
  /** 有效值（读侧权威：devGated 走派生，其余=存储值） */
  readEffective(): boolean;
  /** 存储值（useSyncExternalStore 服务端快照/原始读面） */
  readStored(): boolean;
  /** 写面：LS 双值落盘 +（有 attr 时）落根属性 + notify 上抛 + 重渲订阅面 */
  apply(on: boolean): void;
  /** 远程值应答（'1'|'0'，ui-pref-sync/use-appearance-sync 经此落地） */
  applyRemote(v: string): void;
  /** 订阅钩子（HTML 渲染环境快照=attr 面，无 attr=有效值） */
  usePref(): boolean;
}

/** notifyUiPref 注入（ui-pref-sync 模块装载时回填；未回填前 apply 不可能发生——UI 事件晚于
 *  模块图求值） */
let notify: ((key: BooleanPrefKey, value: string) => void) | null = null;
export function bindBooleanPrefNotify(fn: (key: BooleanPrefKey, value: string) => void): void {
  notify = fn;
}

/** 开发者模式派生源注入（developer-mode 模块装载末回填）。本模块不反向 import developer-mode：
 *  sync→factory→dev→sync 为环且 ESM 求值序下工厂体先于 dev 完成逃逸（ui-derivations 首跑实证
 *  「onDeveloperModeChange is not a function」），依赖方向翻转后 dev→sync→factory 成 DAG。
 *  回填前 apply/readEffective 不可能发生（UI 事件晚于全图求值）。 */
let devRead: (() => boolean) | null = null;
const devGatedReapplies: Array<() => void> = [];
export function bindBooleanPrefDevSource(source: { read: () => boolean; onChange: (fn: () => void) => void }): void {
  devRead = source.read;
  for (const reapply of devGatedReapplies) source.onChange(reapply);
}

function createBooleanPref(spec: {
  key: BooleanPrefKey;
  lsKey: string;
  /** 缺席=不落根属性（change-cards/session-info-cards 纯 store 形） */
  dataAttr?: string;
  /** 属性极性：'1'=on 写 '1'/off 删（presence 形，缺省）；'0'=off 写 '0'/on 删（usage-stats/artifact-cards 反极性形） */
  attrPresence?: '1' | '0';
  defaultOn: boolean;
  /** 开发者模式派生：普通态恒 normalValue（**与 defaultOn 独立**——改动卡/会话信息卡缺省开但
   *  普通态恒关；简洁模式两者同 true；用量统计两者同 false）。翻转时重落属性（若在）并重渲订阅面 */
  devGated?: { normalValue: boolean };
}): BooleanPref {
  const listeners = new Set<() => void>();
  const attrPresence = spec.attrPresence ?? '1';

  // 存储读面两形逐字保真（垃圾值语义随形：'1' 形垃圾=false，'0' 形垃圾=true）
  const readStored = (): boolean => {
    try {
      return spec.defaultOn ? localStorage.getItem(spec.lsKey) !== '0' : localStorage.getItem(spec.lsKey) === '1';
    } catch {
      return spec.defaultOn; // 隐私模式等读失败：缺省值
    }
  };
  const readEffective = (): boolean => (spec.devGated !== undefined ? ((devRead !== null && devRead()) ? readStored() : spec.devGated.normalValue) : readStored());
  const readAttr = (): boolean => {
    const v = document.documentElement.dataset[spec.dataAttr!];
    return attrPresence === '1' ? v === '1' : v !== '0';
  };
  const setAttr = (): void => {
    if (spec.dataAttr === undefined) return;
    const root = document.documentElement;
    // 落根属性在写档之后（本函读存储值定值源，先落会读到上一值——concise-mode 在案判例）；
    // 值源：devGated 按有效值（concise/usage 普通态强制形），否则按存储值=入场值（artifact/dark）
    const v = spec.devGated !== undefined ? readEffective() : readStored();
    if (attrPresence === '1') {
      if (v) root.dataset[spec.dataAttr] = '1';
      else delete root.dataset[spec.dataAttr];
    } else {
      if (v) delete root.dataset[spec.dataAttr];
      else root.dataset[spec.dataAttr] = '0';
    }
  };
  const notifyListeners = (): void => {
    for (const fn of listeners) fn();
  };

  if (spec.devGated !== undefined) {
    // 开发者模式翻转：有效值随之变化——重落属性（存储值不动）并重渲订阅面。派生源晚于本模块
    // 装载（dev-mode 在 DAG 下游）：闭包入列，bind 回填时统一接线
    const reapply = (): void => {
      setAttr();
      notifyListeners();
    };
    devGatedReapplies.push(reapply);
  }

  const apply = (on: boolean): void => {
    try {
      localStorage.setItem(spec.lsKey, on ? '1' : '0');
    } catch {
      /* 隐私模式等持久化失败：仅内存态生效，不阻断 */
    }
    setAttr();
    notify?.(spec.key, on ? '1' : '0');
    notifyListeners();
  };

  const subscribe = (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  return {
    key: spec.key,
    lsKey: spec.lsKey,
    readEffective,
    readStored,
    apply,
    applyRemote: (v: string) => apply(v === '1'),
    usePref: (): boolean =>
      useSyncExternalStore(subscribe, spec.dataAttr !== undefined ? readAttr : readEffective, spec.dataAttr !== undefined ? readStored : readEffective),
  };
}

/** 布尔族实例表（六模块七实例；语义注释详见各原模块头） */
const PREFS: Record<BooleanPrefKey, BooleanPref> = {
  // 用量统计显隐（2026-11-14 裁定）：反极性 '0'；普通态恒关（2026-11-17 裁定），attr 按有效值落
  usageStats: createBooleanPref({ key: 'usageStats', lsKey: 'sunshinex.usage-stats', dataAttr: 'usageStats', attrPresence: '0', defaultOn: false, devGated: { normalValue: false } }),
  // 产物卡显隐（2026-11-16 裁定）：反极性 '0'，缺省开，无模式派生
  artifactCards: createBooleanPref({ key: 'artifactCards', lsKey: 'sunshinex.artifact-cards', dataAttr: 'artifactCards', attrPresence: '0', defaultOn: true }),
  // 简洁模式（2026-11-14 裁定）：presence '1'；普通态恒开（2026-11-17 裁定），attr 按有效值落
  conciseMode: createBooleanPref({ key: 'conciseMode', lsKey: 'sunshinex.concise-mode', dataAttr: 'conciseMode', defaultOn: true, devGated: { normalValue: true } }),
  // 改动卡显隐（2026-11-17 裁定）：纯 store 形（无 attr）；普通态恒关
  changeCards: createBooleanPref({ key: 'changeCards', lsKey: 'sunshinex.change-cards', defaultOn: true, devGated: { normalValue: false } }),
  // 会话信息卡显隐（2026-11-17 裁定）：纯 store 形；普通态恒关
  sessionInfoCards: createBooleanPref({ key: 'sessionInfoCards', lsKey: 'sunshinex.session-info-cards', defaultOn: true, devGated: { normalValue: false } }),
  // 暗色气泡/暗色代码（2026-11-12 裁定，双键双实例）：presence '1'，缺省关，无模式派生
  darkBubbles: createBooleanPref({ key: 'darkBubbles', lsKey: 'sunshinex.dark-bubbles', dataAttr: 'bubbleDark', defaultOn: false }),
  darkCode: createBooleanPref({ key: 'darkCode', lsKey: 'sunshinex.dark-code', dataAttr: 'codeDark', defaultOn: false }),
};

export const BOOLEAN_PREF_KEYS: ReadonlyArray<BooleanPrefKey> = Object.keys(PREFS) as BooleanPrefKey[];

/** 模块壳取实例（各偏好模块薄壳经此再导出既有具名 API，read/apply 签名零变化） */
export function booleanPref(key: BooleanPrefKey): BooleanPref {
  return PREFS[key];
}

/** LOCAL_KEYS 布尔段（ui-pref-sync 生成用） */
export function booleanLocalKeys(): Record<BooleanPrefKey, string> {
  return Object.fromEntries(BOOLEAN_PREF_KEYS.map((k) => [k, PREFS[k].lsKey])) as Record<BooleanPrefKey, string>;
}

/** 远程应答分发布尔段（ui-pref-sync APPLY_REMOTE 生成用；宿主 appliers 契约由同步侧定型） */
export function booleanRemoteDispatch(): Record<BooleanPrefKey, (a: Record<BooleanPrefKey, (v: string) => void>, v: string) => void> {
  return Object.fromEntries(BOOLEAN_PREF_KEYS.map((k) => [k, (a: Record<BooleanPrefKey, (v: string) => void>, v: string) => a[k](v)])) as Record<
    BooleanPrefKey,
    (a: Record<BooleanPrefKey, (v: string) => void>, v: string) => void
  >;
}

/** 宿主 appliers 布尔段（use-appearance-sync initUiPrefSync 展开用） */
export function booleanPrefAppliers(): Record<BooleanPrefKey, (v: string) => void> {
  return Object.fromEntries(BOOLEAN_PREF_KEYS.map((k) => [k, (v: string) => PREFS[k].applyRemote(v)])) as Record<BooleanPrefKey, (v: string) => void>;
}

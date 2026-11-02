/** vite 专属资源形态声明（tsconfig 无 vite/client——就地声明用到的） */
declare module '*?worker' {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}

/** 桌面壳桥（D33 单点声明：shell main 经 contextBridge 注入；浏览器态缺席） */
interface Window {
  sunshinex?: {
    pickFolder?: () => Promise<string | null>;
  };
}

/** 桌面窗控/宿主桥单点（shell/src/preload.ts exposeInMainWorld('sunshinexWindow') 为权威形态；
 *  浏览器态与旧壳缺席——消费面一律 ?. 容忍：focusMain/openExternal/dragStart/dragEnd=旧壳可缺，
 *  openDevtools/onOpenUrl=2026-10-31 后新面） */
interface Window {
  sunshinexWindow?: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    /** 通知点击唤起主窗（win:focus-main → show+restore+focus；旧壳缺省=window.focus 兜底） */
    focusMain?: () => void;
    /** 抽屉程序化拖窗：旧壳无此方法 ?. 静默跳过 */
    dragStart?: () => void;
    dragEnd?: () => void;
    /** Web 标签「在系统浏览器打开」——shell.openExternal，OS 默认浏览器承接 */
    openExternal?: (url: string) => Promise<{ ok: boolean }>;
    /** 内置浏览器调试（⋯菜单→打开调试工具，主窗 detach 独立 DevTools 窗，toggle 语义） */
    openDevtools?: () => void;
    /** M2 融合：guest 弹窗 URL 由主进程转发（main setWindowOpenHandler → builtin:open-url），
     *  GUI 开新侧栏 web 页签；退订返回卸载用 */
    onOpenUrl?: (cb: (url: string) => void) => () => void;
    /** 模型关 Web 页签：主进程下发 guest webContents id，页签自判非即忽略；退订返回卸载用 */
    onCloseWebContents?: (cb: (id: number) => void) => () => void;
    onCloseWebContents?: (cb: (webContentsId: number) => void) => () => void;
    onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
  };
  /** 开机画面收尾（index.html 内联控制脚本定义；reload 跳过演时已 remove——可选调用静默无副作用） */
  __sxBootDone?: () => void;
}

/** unified 类型面(react-markdown 传递依赖,gui 未直连——MD_* 插件常量类型锚点) */
declare module 'unified' {
  export type Pluggable = unknown;
  export type PluggableList = Pluggable[];
}

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

/** unified 类型面(react-markdown 传递依赖,gui 未直连——MD_* 插件常量类型锚点) */
declare module 'unified' {
  export type Pluggable = unknown;
  export type PluggableList = Pluggable[];
}

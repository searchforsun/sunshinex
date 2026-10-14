/** vite 专属资源形态声明（tsconfig 无 vite/client——就地声明用到的） */
declare module '*?worker' {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}

/** 图标集 JSON 的模块声明（结构校验交运行时） */
declare module '@iconify-json/vscode-icons/icons.json' {
  const value: Record<string, unknown>;
  export default value;
}

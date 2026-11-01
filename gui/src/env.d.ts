/** vite 专属资源形态声明（tsconfig 无 vite/client——就地声明用到的） */

/** Electron webview 标签(M1 内置浏览器融合:真实嵌入页面替代截屏画布)——事件(did-navigate/
 *  page-title-updated 等)经 ref addEventListener 挂,方法(loadURL/goBack/reload/setZoomFactor)
 *  消费面持 ref 自取(壳 BrowserWindow 需 webviewTag:true)。
 *  本文件为模块上下文(export {}):declare module 'react' 在模块文件里才是「合并增强」——
 *  无导入的全局脚本里该语法会新建 ambient 模块把 react 真类型整个遮蔽(实测全 GUI 类型崩,
 *  全局面声明已拆至 env-global.d.ts) */
export {};

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & {
        src?: string;
        partition?: string;
        allowpopups?: boolean;
      }, HTMLElement>;
    }
  }
}

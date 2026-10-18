import { setLanguage } from './i18n';

/** G14.104 测试基准语言钉 en：语言缺省翻 zh（主用户群中文）后，断言面（按钮名/文案）
 *  以 en 书写的既有测试需钉语言——zh 文案由 i18n.test 与专项用例覆盖 */
setLanguage('en');

// React Flow(@xyflow/react,任务板 DAG 渲染)在 jsdom 缺的浏览器面:最小桩
// (官方 testing 指南同款;observe 即回调令节点实测尺寸即时可得——jsdom 尺寸恒 0,
// 布局正确性由 TaskDag 的 layoutTaskDag 纯函数单测覆盖,此处只保组件面可渲不炸)
class ResizeObserverStub {
  private readonly callback: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
  }
  observe(target: Element): void {
    const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 } as DOMRectReadOnly;
    this.callback([{ target, contentRect: rect } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}
const g = globalThis as Record<string, unknown>;
if (typeof g.ResizeObserver === 'undefined') g.ResizeObserver = ResizeObserverStub;
if (typeof g.DOMMatrixReadOnly === 'undefined') {
  g.DOMMatrixReadOnly = class {
    m22: number;
    constructor(transform?: string) {
      const scale = /scale\(([0-9.]+)\)/.exec(transform ?? '')?.[1];
      this.m22 = scale !== undefined ? +scale : 1;
    }
  };
}

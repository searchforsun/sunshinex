import { useSyncExternalStore } from 'react';
import { getLanguage, subscribeLanguage } from '../../src/i18n';
import type { Language } from '../../src/i18n';

/** GUI 外观双语(G10-C3c):复用主仓 t(en,zh)/setLanguage 单点(§15 外观双语纪律)。
 *  语言源 = daemon settings `language` 键(App 装配后拉取;设置保存语言即热切换)。 */
export { t, setLanguage, parseLanguage, getLanguage } from '../../src/i18n';

/**
 * 语言订阅面(2026-11-16 用户实测「区块头英文×快捷区中文混排」根修):memo 化组件
 * (SunxSection/ProjectsSection/RecentsSection/PinnedSection/ArchiveSection 五区块)的 props
 * 不随语言变,memo bail 把启动期 en→zh settings 同步前的标签永钉英文(t() 无 React 响应面,
 * setLanguage 只是模块变量赋值)。语言可变面消费组件在渲染期调本 hook——语言同步即强制重
 * 渲染,标签随 t() 调用时求值归位。非 memo 组件无需调用(父链重渲染自然带到)。
 */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}

/**
 * 界面语言（i18n）基座：
 * - Language = 'en' | 'zh'；进程级缺省 en（zh 经 CLI --language=zh/daemon settings 链或测试 setLanguage 显式切换）
 * - t(en, zh)：语言键 → 当前语言文案；调用点内联双语字面量，零词典文件、改文案即改调用点
 * - 仅用于**界面外观**（chrome/帮助/回执/系统消息）。提示词与写链文案恒英文单语，不走 t()（CLAUDE.md §15）
 * - 硬约束：所有 t() 必须调用时求值，禁止模块加载期常量冻结（语言在 CLI main 里先于任何装配设置；
 *   STATUS_LABEL/SLASH_HELP 类曾为模块级常量的，一律改函数或就地调用）
 */
export type Language = 'en' | 'zh';

let current: Language = 'en'; // 进程缺省 en(CLI main 先于装配显式 setLanguage——parseLanguage 未设置→zh;
// GUI settings language 键显式设置时经 use-appearance-sync 覆写。勿留探针初值:2026-11-11 实测改 zh
// 会翻转 dist 侧 daemon 的 t() 缺省,e2e.rewind 服务端 toast 断言随之翻车)

export function getLanguage(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  current = lang;
  for (const fn of languageListeners) fn();
}

/** 语言变更订阅(GUI useLanguage 响应面,2026-11-16):memo 化组件(SunxSection/ProjectsSection 等
 *  五区块)的 props 不随语言变,memo bail 会把启动期 en→zh 同步前的标签永钉英文——订阅面让
 *  useSyncExternalStore 在语言同步时强制重渲染。主仓 TUI 无消费方,通知空转零开销 */
const languageListeners = new Set<() => void>();
export function subscribeLanguage(fn: () => void): () => void {
  languageListeners.add(fn);
  return () => {
    languageListeners.delete(fn);
  };
}

/** 语言键：en/zh 双字面量就地成对（调用时求值） */
export function t(en: string, zh: string): string {
  return current === 'zh' ? zh : en;
}

/** 从 CLI flag/settings 值解析语言（G14.104 缺省 zh）：未设置(undefined)→zh（产品主用户群中文，
 *  杜绝骨架英文×数据中文的混排观感）；显式 'en'→en；显式 'zh'/其他→zh。settings 语言键可显式切换 */
export function parseLanguage(raw: string | boolean | undefined): Language {
  return raw === 'en' ? 'en' : 'zh';
}

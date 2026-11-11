/**
 * 界面语言（i18n）基座：
 * - Language = 'en' | 'zh'；进程级缺省 zh（en 经 CLI --language=en 或测试 setLanguage 显式切换）
 * - t(en, zh)：语言键 → 当前语言文案；调用点内联双语字面量，零词典文件、改文案即改调用点
 * - 仅用于**界面外观**（chrome/帮助/回执/系统消息）。提示词与写链文案恒英文单语，不走 t()（CLAUDE.md §15）
 * - 硬约束：所有 t() 必须调用时求值，禁止模块加载期常量冻结（语言在 CLI main 里先于任何装配设置；
 *   STATUS_LABEL/SLASH_HELP 类曾为模块级常量的，一律改函数或就地调用）
 * - pick 为模型侧文案（提示词/观察）专用别名：语义上标记「这份双语串会进入模型上下文」，
 *   便于审计提示词组装面的语言来源；行为与 t 完全一致
 */
type Language = 'en' | 'zh';

let current: Language = 'zh'; // 缺省 zh(2026-11-11 用户实测「+ / 弹窗混排 COMMANDS×中文描述」根修:此前
// 残留 G14.104 rollback-probe 的 en 初值,GUI language 键未显式设置时 t 走 en=骨架英文×数据中文混排;
// parseLanguage「未设置→zh」同口径。后端 CLI main 先于装配显式 setLanguage,测试经 SUNSHINEX_LANGUAGE=en 钉 en)

export function getLanguage(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  current = lang;
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

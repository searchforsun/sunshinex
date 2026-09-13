/**
 * 界面语言（i18n）基座：
 * - Language = 'en' | 'zh'；进程级缺省 en（英文版为产品缺省，zh 经 CLI --language=zh 或测试 setLanguage 显式切换）
 * - t(en, zh) / pick(en, zh)：语言键 → 当前语言文案；调用点内联双语字面量，零词典文件、改文案即改调用点
 * - 硬约束：所有 t() 必须调用时求值，禁止模块加载期常量冻结（语言在 CLI main 里先于任何装配设置；
 *   STATUS_LABEL/SLASH_HELP 类曾为模块级常量的，一律改函数或就地调用）
 * - pick 为模型侧文案（提示词/观察）专用别名：语义上标记「这份双语串会进入模型上下文」，
 *   便于审计提示词组装面的语言来源；行为与 t 完全一致
 */
export type Language = 'en' | 'zh';

let current: Language = 'en';

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

/** 模型侧文案别名（提示词/观察/角色框定）：行为同 t，标记语言敏感的模型上下文产出点 */
export const pick = t;

/** 从 CLI flag 解析语言：仅字符串 'zh' 生效，其余（含缺省/裸 flag 的 false/非法值）一律 en */
export function parseLanguage(raw: string | boolean | undefined): Language {
  return raw === 'zh' ? 'zh' : 'en';
}

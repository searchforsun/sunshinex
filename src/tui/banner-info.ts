export interface BannerInfo {
  version: string;
  model: string;
  root: string;
}

export const FALLBACK_VERSION = '0.1.0';

/** 横幅信息（纯函数）：version 由装配层 entry.ts 读取 package.json 注入（空回退）；model 读 OPENAI_MODEL；root 缺省 cwd */
export function buildBannerInfo(input: { version?: string; model?: string; root?: string } = {}): BannerInfo {
  return {
    version: input.version && input.version.length > 0 ? input.version : FALLBACK_VERSION,
    model: input.model && input.model.length > 0 ? input.model : (process.env.OPENAI_MODEL ?? '未配置'),
    root: input.root ?? process.cwd(),
  };
}

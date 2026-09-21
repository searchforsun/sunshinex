import * as os from 'os';
import * as path from 'path';

/** 用户级全局配置目录（对标 Claude Code 的 ~/.claude / Codex 的 ~/.codex 惯例）：跨项目共享一份配置 */
export function userConfigDir(): string {
  return path.join(os.homedir(), '.sunshinex');
}

/**
 * 解析知识库/embedding 环境配置：
 * - SUNSHINEX_KB_BACKEND 缺省 'local-json'（零依赖路径缺省，未注册后端由装配层 fail-fast）
 * - SUNSHINEX_EMBEDDING_BASE_URL / SUNSHINEX_EMBEDDING_API_KEY / SUNSHINEX_EMBEDDING_MODEL 未显式配置时回退同名 SUNSHINEX_* 主模型键（远端供给允许复用通用网关凭据）
 * 注入式解析（禁止读进程环境）：由调用方（装配层）把 settings.json 落槽后的合并视图传入。
 */
export function resolveKbEnv(
  env: Record<string, string | undefined>,
): { backend: string; embeddingBaseUrl?: string; embeddingApiKey?: string; embeddingModel?: string } {
  /** 环境变量回退取值（本地函数） */
  const pickEnv = (key: string, fallbackKey: string): string | undefined => {
    const v = env[key] ?? env[fallbackKey];
    return v !== undefined && v.length > 0 ? v : undefined;
  };
  const embeddingBaseUrl = pickEnv('SUNSHINEX_EMBEDDING_BASE_URL', 'SUNSHINEX_BASE_URL');
  const embeddingApiKey = pickEnv('SUNSHINEX_EMBEDDING_API_KEY', 'SUNSHINEX_API_KEY');
  const embeddingModel = pickEnv('SUNSHINEX_EMBEDDING_MODEL', 'SUNSHINEX_MODEL');
  const backend = env['SUNSHINEX_KB_BACKEND'];
  return {
    backend: backend !== undefined && backend.length > 0 ? backend : 'local-json',
    ...(embeddingBaseUrl !== undefined && { embeddingBaseUrl }),
    ...(embeddingApiKey !== undefined && { embeddingApiKey }),
    ...(embeddingModel !== undefined && { embeddingModel }),
  };
}

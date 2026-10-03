import * as os from 'os';
import * as path from 'path';

/**
 * 用户家目录单点：HOME 显式设置时优先（测试夹具与部署重定向口），缺省回退 os.homedir()。
 * 为何不能直接用 os.homedir()：Windows 上 Node 优先读 USERPROFILE，对 HOME 视而不见——
 * 所有「HOME 重定向」测试夹具与可移植部署在 Windows 整体失效（判界与配置目录统一单点，§14）。
 */
export function homeDir(): string {
  const home = process.env.HOME;
  return home !== undefined && home !== '' ? home : os.homedir();
}

/** 用户级全局配置目录（对标 Claude Code 的 ~/.claude / Codex 的 ~/.codex 惯例）：跨项目共享一份配置 */
export function userConfigDir(): string {
  return path.join(homeDir(), '.sunshinex');
}

/** resolveKbEnv 产物：KB 装配的完整环境面（assembleKnowledgeBase 入参形态，装配落点见 harness/knowledge） */
export interface KbEnv {
  /** 向量后端名（注册表键）：缺省 'local-json'；'sqlite-vec' 须显式声明（禁静默切换） */
  backend: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
  /** KB 数据目录显式覆盖（SUNSHINEX_KB_DATA_DIR ≡ settings 语义键 kbDataDir）：缺省由装配层按 resolveDataDir(root)/kb 落位 */
  kbDataDir?: string;
}

/**
 * 解析知识库/embedding 环境配置：
 * - SUNSHINEX_KB_BACKEND 缺省 'local-json'（零依赖路径缺省，未注册后端由装配层 fail-fast）
 * - SUNSHINEX_EMBEDDING_BASE_URL / SUNSHINEX_EMBEDDING_API_KEY / SUNSHINEX_EMBEDDING_MODEL 未显式配置时回退同名 SUNSHINEX_* 主模型键（远端供给允许复用通用网关凭据）
 * - SUNSHINEX_KB_DATA_DIR 显式数据目录覆盖（等价未配置 = 空串）
 * 注入式解析（禁止读进程环境）：由调用方（装配层）把 settings.json 落槽后的合并视图传入。
 */
export function resolveKbEnv(env: Record<string, string | undefined>): KbEnv {
  /** 环境变量回退取值（本地函数） */
  const pickEnv = (key: string, fallbackKey: string): string | undefined => {
    const v = env[key] ?? env[fallbackKey];
    return v !== undefined && v.length > 0 ? v : undefined;
  };
  const embeddingBaseUrl = pickEnv('SUNSHINEX_EMBEDDING_BASE_URL', 'SUNSHINEX_BASE_URL');
  const embeddingApiKey = pickEnv('SUNSHINEX_EMBEDDING_API_KEY', 'SUNSHINEX_API_KEY');
  const embeddingModel = pickEnv('SUNSHINEX_EMBEDDING_MODEL', 'SUNSHINEX_MODEL');
  const backend = env['SUNSHINEX_KB_BACKEND'];
  const kbDataDirRaw = env['SUNSHINEX_KB_DATA_DIR'];
  const kbDataDir = kbDataDirRaw !== undefined && kbDataDirRaw.length > 0 ? kbDataDirRaw : undefined;
  return {
    backend: backend !== undefined && backend.length > 0 ? backend : 'local-json',
    ...(embeddingBaseUrl !== undefined && { embeddingBaseUrl }),
    ...(embeddingApiKey !== undefined && { embeddingApiKey }),
    ...(embeddingModel !== undefined && { embeddingModel }),
    ...(kbDataDir !== undefined && { kbDataDir }),
  };
}

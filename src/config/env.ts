import * as fs from 'fs';
import * as path from 'path';

/** 解析 .env 文本：仅 KEY=VALUE 行，去成对引号，忽略注释/空行/非法键名；键名冲突时后行覆盖前行 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 装载 dir/.env 到 process.env：已导出的环境变量优先（不被文件覆盖）；幂等，文件缺失静默返回 0 */
export function loadEnv(dir: string = process.cwd()): number {
  const p = path.join(dir, '.env');
  if (!fs.existsSync(p)) return 0;
  const kv = parseDotenv(fs.readFileSync(p, 'utf8'));
  let loaded = 0;
  for (const [k, v] of Object.entries(kv)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      loaded += 1;
    }
  }
  return loaded;
}

/**
 * 解析知识库/embedding 环境配置：
 * - KB_BACKEND 缺省 'local-json'（零依赖路径缺省，未注册后端由装配层 fail-fast）
 * - EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL 未显式配置时回退同名 OPENAI_* 键（远端供给允许复用通用网关凭据）
 * 注入式解析（禁止读真实 .env / process.env）：由调用方（Task 4 装配层）自行合并 .env 文本与进程环境后传入。
 */
export function resolveKbEnv(
  env: Record<string, string | undefined>,
): { backend: string; embeddingBaseUrl?: string; embeddingApiKey?: string; embeddingModel?: string } {
  const pick = (key: string, fallbackKey: string): string | undefined => {
    const v = env[key] ?? env[fallbackKey];
    return v !== undefined && v.length > 0 ? v : undefined;
  };
  const embeddingBaseUrl = pick('EMBEDDING_BASE_URL', 'OPENAI_BASE_URL');
  const embeddingApiKey = pick('EMBEDDING_API_KEY', 'OPENAI_API_KEY');
  const embeddingModel = pick('EMBEDDING_MODEL', 'OPENAI_MODEL');
  const backend = env['KB_BACKEND'];
  return {
    backend: backend !== undefined && backend.length > 0 ? backend : 'local-json',
    ...(embeddingBaseUrl !== undefined && { embeddingBaseUrl }),
    ...(embeddingApiKey !== undefined && { embeddingApiKey }),
    ...(embeddingModel !== undefined && { embeddingModel }),
  };
}

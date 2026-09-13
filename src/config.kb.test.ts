import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotenv, resolveKbEnv } from './config/env';

test('parseDotenv：注入文本解析（引号剥离/注释与非法行忽略），供 env 回退链输入', () => {
  const kv = parseDotenv([
    '# comment',
    'SUNSHINEX_API_KEY="sk-test"',
    "SUNSHINEX_EMBEDDING_MODEL='text-embedding-3-small'",
    'SUNSHINEX_KB_BACKEND=local-json',
    '',
    'bad line',
  ].join('\n'));
  assert.deepEqual(kv, {
    SUNSHINEX_API_KEY: 'sk-test',
    SUNSHINEX_EMBEDDING_MODEL: 'text-embedding-3-small',
    SUNSHINEX_KB_BACKEND: 'local-json',
  });
});

test('resolveKbEnv：SUNSHINEX_KB_BACKEND 缺省 local-json；SUNSHINEX_EMBEDDING_* 未配置回退同名 SUNSHINEX_* 主模型键；均未配置则字段缺省', () => {
  assert.deepEqual(resolveKbEnv({}), { backend: 'local-json' });
  assert.deepEqual(
    resolveKbEnv({
      SUNSHINEX_BASE_URL: 'https://api.openai.com/v1',
      SUNSHINEX_API_KEY: 'sk-x',
      SUNSHINEX_MODEL: 'text-embedding-3-small',
    }),
    {
      backend: 'local-json',
      embeddingBaseUrl: 'https://api.openai.com/v1',
      embeddingApiKey: 'sk-x',
      embeddingModel: 'text-embedding-3-small',
    },
  );
  assert.deepEqual(
    resolveKbEnv({ SUNSHINEX_KB_BACKEND: 'sqlite-vec', SUNSHINEX_EMBEDDING_BASE_URL: 'https://eb.local/v1', SUNSHINEX_API_KEY: 'fallback-key' }),
    { backend: 'sqlite-vec', embeddingBaseUrl: 'https://eb.local/v1', embeddingApiKey: 'fallback-key' },
  );
});

test('resolveKbEnv：SUNSHINEX_EMBEDDING_* 显式配置优先于 SUNSHINEX_* 主模型回退', () => {
  assert.deepEqual(
    resolveKbEnv({ SUNSHINEX_EMBEDDING_API_KEY: 'emb-key', SUNSHINEX_API_KEY: 'oa-key' }),
    { backend: 'local-json', embeddingApiKey: 'emb-key' },
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotenv, resolveKbEnv } from './config/env';

test('parseDotenv：注入文本解析（引号剥离/注释与非法行忽略），供 env 回退链输入', () => {
  const kv = parseDotenv([
    '# comment',
    'OPENAI_API_KEY="sk-test"',
    "EMBEDDING_MODEL='text-embedding-3-small'",
    'KB_BACKEND=local-json',
    '',
    'bad line',
  ].join('\n'));
  assert.deepEqual(kv, {
    OPENAI_API_KEY: 'sk-test',
    EMBEDDING_MODEL: 'text-embedding-3-small',
    KB_BACKEND: 'local-json',
  });
});

test('resolveKbEnv：KB_BACKEND 缺省 local-json；EMBEDDING_* 未配置回退同名 OPENAI_*；均未配置则字段缺省', () => {
  assert.deepEqual(resolveKbEnv({}), { backend: 'local-json' });
  assert.deepEqual(
    resolveKbEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'text-embedding-3-small',
    }),
    {
      backend: 'local-json',
      embeddingBaseUrl: 'https://api.openai.com/v1',
      embeddingApiKey: 'sk-x',
      embeddingModel: 'text-embedding-3-small',
    },
  );
  assert.deepEqual(
    resolveKbEnv({ KB_BACKEND: 'sqlite-vec', EMBEDDING_BASE_URL: 'https://eb.local/v1', OPENAI_API_KEY: 'fallback-key' }),
    { backend: 'sqlite-vec', embeddingBaseUrl: 'https://eb.local/v1', embeddingApiKey: 'fallback-key' },
  );
});

test('resolveKbEnv：EMBEDDING_* 显式配置优先于 OPENAI_* 回退', () => {
  assert.deepEqual(
    resolveKbEnv({ EMBEDDING_API_KEY: 'emb-key', OPENAI_API_KEY: 'oa-key' }),
    { backend: 'local-json', embeddingApiKey: 'emb-key' },
  );
});

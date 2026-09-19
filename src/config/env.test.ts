import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as env from './env';

test('userConfigDir：指向用户家目录 .sunshinex（对标 ~/.claude 惯例）', () => {
  assert.equal(env.userConfigDir(), path.join(os.homedir(), '.sunshinex'));
});

test('渠道退役钉子：env.ts 不再提供 .env 文件装载面（parseDotenv / loadEnv 零导出）', () => {
  assert.equal('parseDotenv' in env, false, '.env 解析器不得回归');
  assert.equal('loadEnv' in env, false, '.env 装载器不得回归');
});

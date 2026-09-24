import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as env from './env';

test('userConfigDir：指向用户家目录 .sunshinex（对标 ~/.claude 惯例）', () => {
  assert.equal(env.userConfigDir(), path.join(env.homeDir(), '.sunshinex'));
});

test('homeDir：HOME 显式设置优先（夹具/部署重定向口），缺省回退 os.homedir()——Windows 上 os.homedir() 读 USERPROFILE 无视 HOME，测试重定向由此单点生效', () => {
  const prev = process.env.HOME;
  try {
    process.env.HOME = path.join(os.tmpdir(), 'sunshinex-home-override');
    assert.equal(env.homeDir(), process.env.HOME);
    delete process.env.HOME;
    assert.equal(env.homeDir(), os.homedir());
    process.env.HOME = '';
    assert.equal(env.homeDir(), os.homedir(), '空串视为未设置，同样回退');
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
});

test('渠道退役钉子：env.ts 不再提供 .env 文件装载面（parseDotenv / loadEnv 零导出）', () => {
  assert.equal('parseDotenv' in env, false, '.env 解析器不得回归');
  assert.equal('loadEnv' in env, false, '.env 装载器不得回归');
});

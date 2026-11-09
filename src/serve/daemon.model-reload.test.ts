/** 模型层配置热重载钉（2026-11-09 用户实测：欢迎页读到 providers，发送后「SUNSHINEX_API_KEY is not configured」、
 *  药丸「默认模型」）：切换器在 daemon 启动时冻结 choices 与各源密钥，配置变更只刷 env/前端，模型层不跟。
 *  两条变更通路都须刷新：①设置页写入（reloadSettingsChain 收尾）②外部编辑器直改 settings.json（watcher）。
 *  夹具形态沿 daemon.test withSettingsDaemon：SUNSHINEX_* 面清空重钉、HOME 改道临时目录、结束全量复位。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GuiDaemon } from './daemon';
import { ModelSwitcher, choiceAdapterConfig } from '../model/catalog';
import { StubAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { ModelChoice } from '../config/providers';
import { resetSelfFilledSlots } from '../config/settings';

const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' } as Record<string, string>;

/** 内芯构造探针：记录每次建芯时解析到的密钥（免真实网络，instanceof ModelSwitcher 仍成立——daemon 注入闸可过） */
class SpySwitcher extends ModelSwitcher {
  readonly keys: Array<{ id: string; apiKey: string }> = [];
  protected buildAdapter(choice: ModelChoice): ModelAdapter {
    this.keys.push({ id: choice.id, apiKey: choiceAdapterConfig(choice, {}).apiKey ?? '' });
    return new StubAdapter();
  }
}

const SETTINGS = JSON.stringify({
  version: 1,
  env: { SUNSHINEX_API_KEY_A: 'k-after-start' },
  providers: [{ name: 'a', baseUrl: 'https://a/v1', models: [{ model: 'm1' }] }],
});

async function withEmptyDaemon(fn: (ctx: { sw: SpySwitcher; base: string; home: string; proj: string }) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-model-reload-'));
  const home = path.join(tmp, 'home');
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(home, '.sunshinex'), { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const prev = { home: process.env.HOME, userProfile: process.env.USERPROFILE };
  const envSnap = new Map<string, string>();
  for (const k of Object.keys(process.env)) if (k.startsWith('SUNSHINEX_')) envSnap.set(k, process.env[k]!);
  try {
    for (const k of [...envSnap.keys()]) delete process.env[k];
    process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    // 启动期配置为空：切换器零 choices、回落缺省内芯（复现「启动后才配置」的现场）
    const sw = new SpySwitcher({ choices: [], default: new StubAdapter() });
    const daemon = new GuiDaemon({ model: sw, providerRoot: proj });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    try {
      await fn({ sw, base: `http://127.0.0.1:${s.port}`, home, proj });
    } finally {
      await s.close();
    }
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith('SUNSHINEX_') && !envSnap.has(k)) delete process.env[k];
    for (const [k, v] of envSnap) process.env[k] = v;
    resetSelfFilledSlots();
    if (prev.home === undefined) delete process.env.HOME; else process.env.HOME = prev.home;
    if (prev.userProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.userProfile;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('设置页写入后模型层随之刷新：choices 切到新源首项，内芯按新密钥重建（不再回落缺省内芯报密钥未配置）', async () => {
  await withEmptyDaemon(async ({ sw, base, proj }) => {
    assert.equal(sw.currentId(), undefined, '前置：启动期无 providers');
    const r = await fetch(`${base}/settings/raw`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({ scope: 'global', root: proj, file: 'settings', content: SETTINGS }),
    });
    assert.equal(r.status, 200);
    assert.equal(sw.currentId(), 'a/m1', '写入即切新源首项');
    assert.deepEqual(sw.keys.at(-1), { id: 'a/m1', apiKey: 'k-after-start' }, '内芯按重载时刻的密钥构造');
  });
});

test('外部编辑器直改全局 settings.json：watcher 触发重装链+刷新模型层', async () => {
  await withEmptyDaemon(async ({ sw, home }) => {
    fs.writeFileSync(path.join(home, '.sunshinex', 'settings.json'), SETTINGS, 'utf8');
    const deadline = Date.now() + 5000;
    while (sw.currentId() === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(sw.currentId(), 'a/m1', '外部编辑经 watcher 刷新模型层');
    assert.deepEqual(sw.keys.at(-1), { id: 'a/m1', apiKey: 'k-after-start' });
  });
});

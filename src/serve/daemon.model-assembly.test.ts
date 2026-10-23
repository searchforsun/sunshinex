/** assembleGuiModel 装配钉（2026-10-23 桌面「默认模型/无法选模型」根因件）：
 *  providers 展开进切换器 + 未显式缺省切首源（防陷阱）+ SUNSHINEX_MODEL 显式档不自动切；
 *  产物必须过同束 instanceof ModelSwitcher——壳/serve 分装面曾因跨束类拷贝致注入闸恒假
 *  （modelSwitcher 恒 null,/model 恒 {choices:[]}），此钉即该回归的断言面。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assembleGuiModel } from './daemon';
import { ModelSwitcher } from '../model/catalog';
import { StubAdapter } from '../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeGlobalProviders(home: string, providers: unknown): void {
  const dir = path.join(home, '.sunshinex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, providers }), 'utf8');
}

test('assembleGuiModel：providers 展开 + 未显式缺省自动切首源；产物过同束 instanceof', () => {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevModel = process.env.SUNSHINEX_MODEL;
  const home = tmpdir('assemble-model-home-');
  const proj = tmpdir('assemble-model-proj-');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.SUNSHINEX_MODEL;
  try {
    writeGlobalProviders(home, [
      { name: 'a', baseUrl: 'https://a/v1', models: ['m1', 'm2'] },
      { name: 'b', baseUrl: 'https://b/v1', models: ['m3'] },
    ]);
    const { model, warnings } = assembleGuiModel(new StubAdapter(), proj);
    assert.deepEqual(warnings, []);
    assert.ok(model instanceof ModelSwitcher, '产物必须是本束 ModelSwitcher（跨束 instanceof 注入闸的回归钉）');
    assert.deepEqual(model.choices().map((c) => c.id), ['a/m1', 'a/m2', 'b/m3']);
    assert.equal(model.currentId(), 'a/m1', '未显式缺省：自动切首个源模型（防陷阱缺省）');
    assert.equal(model.hasExplicitDefault(), false);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevModel === undefined) delete process.env.SUNSHINEX_MODEL; else process.env.SUNSHINEX_MODEL = prevModel;
  }
});

test('assembleGuiModel：SUNSHINEX_MODEL 显式档不自动切源（default 选项露出,GUI 回显 env 模型）', () => {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevModel = process.env.SUNSHINEX_MODEL;
  const home = tmpdir('assemble-model-explicit-');
  const proj = tmpdir('assemble-model-explicit-proj-');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.SUNSHINEX_MODEL = 'glm-5.3-flash';
  try {
    writeGlobalProviders(home, [{ name: 'a', baseUrl: 'https://a/v1', models: ['m1'] }]);
    const { model } = assembleGuiModel(new StubAdapter(), proj);
    assert.ok(model instanceof ModelSwitcher);
    assert.equal(model.currentId(), undefined, '显式档不自动切源（缺省主模型即 env 配置）');
    assert.equal(model.hasExplicitDefault(), true);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevModel === undefined) delete process.env.SUNSHINEX_MODEL; else process.env.SUNSHINEX_MODEL = prevModel;
  }
});

test('assembleGuiModel：providers 缺场 → 空 choices 不致命（/model 回 {choices:[]} 口径不变）', () => {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevModel = process.env.SUNSHINEX_MODEL;
  const home = tmpdir('assemble-model-empty-');
  const proj = tmpdir('assemble-model-empty-proj-');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.SUNSHINEX_MODEL;
  try {
    const { model } = assembleGuiModel(new StubAdapter(), proj);
    assert.ok(model instanceof ModelSwitcher);
    assert.deepEqual(model.choices(), []);
    assert.equal(model.currentId(), undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevModel === undefined) delete process.env.SUNSHINEX_MODEL; else process.env.SUNSHINEX_MODEL = prevModel;
  }
});

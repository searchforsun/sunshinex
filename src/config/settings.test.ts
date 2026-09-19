import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applySettings,
  flattenSettings,
  loadGlobalSettings,
  loadProjectSettings,
  parseSettingsFile,
} from './settings';

test('parseSettingsFile：合法文档解析语义键与 env 块；version 缺省视为 1 可载', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-ok-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      model: 'glm-5.3-flash',
      tier: 'medium',
      env: { SUNSHINEX_API_KEY: 'sk-test', SUNSHINEX_SHELL: '/bin/zsh' },
    }));
    const doc = parseSettingsFile(file);
    assert.ok(doc, '合法文档应解析出结果');
    assert.equal(doc.semantic['model'], 'glm-5.3-flash');
    assert.equal(doc.semantic['tier'], 'medium');
    assert.equal(doc.env['SUNSHINEX_API_KEY'], 'sk-test', '密钥走 env 块透传（D6）');
    assert.equal(doc.env['SUNSHINEX_SHELL'], '/bin/zsh', '平台逃生口键走 env 块');

    const noVersion = path.join(dir, 'settings-noversion.json');
    fs.writeFileSync(noVersion, JSON.stringify({ model: 'glm-5.3-flash' }));
    const docNoVersion = parseSettingsFile(noVersion);
    assert.ok(docNoVersion, 'version 字段缺省视为 1，可载（D8）');
    assert.equal(docNoVersion.semantic['model'], 'glm-5.3-flash');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseSettingsFile：文件缺失返回 null 不抛错（D7 静默跳过，对齐 loadEnv）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-missing-'));
  try {
    assert.equal(parseSettingsFile(path.join(dir, 'settings.json')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseSettingsFile：畸形 JSON 抛错且 message 同时含文件路径与解析错误原文（D7 fail-fast）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-badjson-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{"model": "x",}');
    assert.throws(() => parseSettingsFile(file), (err: unknown) => {
      assert.ok(err instanceof Error, '抛出 Error');
      assert.ok(err.message.includes(file), 'message 含文件路径');
      assert.ok(err.message.includes('JSON'), 'message 含解析错误原文');
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseSettingsFile：根非对象 / version 非 1 拒载抛错且 message 含路径（D7/D8）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-shape-'));
  try {
    const arrFile = path.join(dir, 'settings-array.json');
    fs.writeFileSync(arrFile, '[1, 2, 3]');
    assert.throws(() => parseSettingsFile(arrFile), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(arrFile), 'message 含文件路径');
      return true;
    });

    const strFile = path.join(dir, 'settings-string.json');
    fs.writeFileSync(strFile, '"just-a-string"');
    assert.throws(() => parseSettingsFile(strFile), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(strFile), 'message 含文件路径');
      return true;
    });

    const verFile = path.join(dir, 'settings-v.json');
    fs.writeFileSync(verFile, JSON.stringify({ version: 2, model: 'x' }));
    assert.throws(() => parseSettingsFile(verFile), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(verFile), 'message 含文件路径');
      assert.ok(err.message.includes('version'), 'message 指明版本守卫拒绝');
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('flattenSettings：语义键→SUNSHINEX_* 槽映射正确（六键抽查）', () => {
  const { slots } = flattenSettings({
    semantic: {
      model: 'glm-5.3-flash',
      baseUrl: 'https://open.example.com/api/paas/v4',
      tier: 'medium',
      language: 'zh',
      contextWindow: 1000000,
      structuredOutput: 'true',
    },
    env: {},
  });
  assert.equal(slots['SUNSHINEX_MODEL'], 'glm-5.3-flash');
  assert.equal(slots['SUNSHINEX_BASE_URL'], 'https://open.example.com/api/paas/v4');
  assert.equal(slots['SUNSHINEX_TIER'], 'medium');
  assert.equal(slots['SUNSHINEX_LANGUAGE'], 'zh', 'language 新槽（D9）');
  assert.equal(slots['SUNSHINEX_CONTEXT_WINDOW'], '1000000');
  assert.equal(slots['SUNSHINEX_STRUCTURED_OUTPUT'], 'true');
});

test('flattenSettings：同槽语义键 > env 块（D3 语义键是正名，env 块兜底）', () => {
  const { slots, warnings } = flattenSettings({
    semantic: { model: 'from-semantic' },
    env: { SUNSHINEX_MODEL: 'from-env-block', SUNSHINEX_BING_API_KEY: 'sk-bing' },
  });
  assert.equal(slots['SUNSHINEX_MODEL'], 'from-semantic');
  assert.equal(slots['SUNSHINEX_BING_API_KEY'], 'sk-bing', 'env 块独有键照常透传');
  assert.deepEqual(warnings, []);
});

test('flattenSettings：contextWindow 数字或数字字符串均 String() 归一', () => {
  const num = flattenSettings({ semantic: { contextWindow: 1000000 }, env: {} });
  assert.equal(num.slots['SUNSHINEX_CONTEXT_WINDOW'], '1000000');
  const str = flattenSettings({ semantic: { contextWindow: '128000' }, env: {} });
  assert.equal(str.slots['SUNSHINEX_CONTEXT_WINDOW'], '128000');
});

test('flattenSettings：未知语义键进告警清单且不致命', () => {
  const { slots, warnings } = flattenSettings({
    semantic: { model: 'glm-5.3-flash', noSuchKey: 'x' },
    env: {},
  });
  assert.equal(slots['SUNSHINEX_MODEL'], 'glm-5.3-flash', '未知键不影响其余键装载');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]!.includes('noSuchKey'), '告警指明未知键名');
});

test('flattenSettings：值类型非 string/number 告警并忽略', () => {
  const { slots, warnings } = flattenSettings({
    semantic: { model: 'glm-5.3-flash', tier: ['medium'] },
    env: {},
  });
  assert.equal(slots['SUNSHINEX_MODEL'], 'glm-5.3-flash', '非法值不影响其余键装载');
  assert.equal(slots['SUNSHINEX_TIER'], undefined, '非法值被忽略不落槽');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]!.includes('tier'), '告警指明非法值键名');
});

test('applySettings：只填缺省——已导出环境变量不被覆盖，返回 loaded 与 warnings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-apply-'));
  const prevModel = process.env.SUNSHINEX_MODEL;
  const prevTier = process.env.SUNSHINEX_TIER;
  const prevKbBackend = process.env.SUNSHINEX_KB_BACKEND;
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      model: 'from-settings',
      tier: 'medium',
      env: { SUNSHINEX_KB_BACKEND: 'from-env-block' },
    }));
    process.env.SUNSHINEX_MODEL = 'from-shell';
    delete process.env.SUNSHINEX_TIER;
    delete process.env.SUNSHINEX_KB_BACKEND;
    const { loaded, warnings } = applySettings(file);
    assert.equal(process.env.SUNSHINEX_MODEL, 'from-shell', '已导出环境变量不被覆盖（顺序即优先级）');
    assert.equal(process.env.SUNSHINEX_TIER, 'medium', '缺失槽由语义键填充');
    assert.equal(process.env.SUNSHINEX_KB_BACKEND, 'from-env-block', 'env 块键照常落槽');
    assert.equal(loaded, 2, 'loaded 仅计实际写入的缺失槽');
    assert.deepEqual(warnings, []);
  } finally {
    if (prevModel === undefined) delete process.env.SUNSHINEX_MODEL; else process.env.SUNSHINEX_MODEL = prevModel;
    if (prevTier === undefined) delete process.env.SUNSHINEX_TIER; else process.env.SUNSHINEX_TIER = prevTier;
    if (prevKbBackend === undefined) delete process.env.SUNSHINEX_KB_BACKEND; else process.env.SUNSHINEX_KB_BACKEND = prevKbBackend;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applySettings：settings.json 缺失静默返回 loaded=0 空告警（D7）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-apply-missing-'));
  try {
    assert.deepEqual(applySettings(path.join(dir, 'settings.json')), { loaded: 0, warnings: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadProjectSettings：项目级路径 = <root>/.sunshinex/settings.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-proj-'));
  try {
    assert.equal(loadProjectSettings(root), path.join(root, '.sunshinex', 'settings.json'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadGlobalSettings：全局路径 = userConfigDir()/settings.json（家目录重定向生效）', () => {
  // HOME 重定向到临时目录：测试不触碰真实用户家目录（os.homedir 在 POSIX 读 $HOME、Windows 读 USERPROFILE）
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-home-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    assert.equal(loadGlobalSettings(), path.join(fakeHome, '.sunshinex', 'settings.json'));
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

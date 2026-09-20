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
  RETIRED_KEYS,
  SEMANTIC_KEYS,
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

test('两级 settings 装载·三层优先级链：shell > 项目 settings > 全局 settings（只填缺省，顺序即优先级）', () => {
  // HOME/USERPROFILE 双变量重定向临时家目录：测试不触碰真实用户家目录（win32 data-dir 三失败先例）
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-chain-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-chain-proj-'));
  const prev: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    SUNSHINEX_TIER: process.env.SUNSHINEX_TIER,
    SUNSHINEX_BASE_URL: process.env.SUNSHINEX_BASE_URL,
    SUNSHINEX_KB_BACKEND: process.env.SUNSHINEX_KB_BACKEND,
  };
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  // 先清空三层相关槽：排除 shell 真实环境/前序用例残留，断言只反映本用例布置
  delete process.env.SUNSHINEX_TIER;
  delete process.env.SUNSHINEX_BASE_URL;
  delete process.env.SUNSHINEX_KB_BACKEND;
  try {
    // ① shell 层（最高）：预导出变量压过一切文件层
    process.env.SUNSHINEX_TIER = 'shell-top';
    // ② 项目 settings 层：语义键承载 baseUrl（与全局层同槽对垒）
    fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.sunshinex', 'settings.json'), JSON.stringify({
      baseUrl: 'from-project-settings',
    }));
    // ③ 全局 settings 层：同槽兜底 + env 块独有键验兜底
    fs.mkdirSync(path.join(fakeHome, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.sunshinex', 'settings.json'), JSON.stringify({
      tier: 'from-global-settings',
      env: { SUNSHINEX_BASE_URL: 'from-global-env', SUNSHINEX_KB_BACKEND: 'from-global-only' },
    }));
    // 按入口真实顺序装载（cli/index.ts 与 index.ts 同款）：只填缺省，装载顺序即优先级
    applySettings(loadProjectSettings(proj));
    applySettings(loadGlobalSettings());
    assert.equal(process.env.SUNSHINEX_TIER, 'shell-top', '① shell 预导出最高，settings 语义键不覆盖');
    assert.equal(process.env.SUNSHINEX_BASE_URL, 'from-project-settings', '② 项目 settings 胜全局 settings');
    assert.equal(process.env.SUNSHINEX_KB_BACKEND, 'from-global-only', '③ 全局 settings 兜底项目未配置槽');
  } finally {
    for (const [key, val] of Object.entries(prev)) {
      if (val === undefined) delete process.env[key]; else process.env[key] = val;
    }
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('language 槽（D9）：settings language:"zh" 填 SUNSHINEX_LANGUAGE；shell 已导出时不被覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-lang-'));
  const prevLang = process.env.SUNSHINEX_LANGUAGE;
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ language: 'zh' }));
    delete process.env.SUNSHINEX_LANGUAGE;
    applySettings(file);
    assert.equal(process.env.SUNSHINEX_LANGUAGE, 'zh', '语义键落入 language 新槽');

    process.env.SUNSHINEX_LANGUAGE = 'en';
    applySettings(file);
    assert.equal(process.env.SUNSHINEX_LANGUAGE, 'en', 'shell 已导出时保持（只填缺省语义，回退链由调用点 ?? 承载）');
  } finally {
    if (prevLang === undefined) delete process.env.SUNSHINEX_LANGUAGE; else process.env.SUNSHINEX_LANGUAGE = prevLang;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SEMANTIC_KEYS 全表钉子：26 键、槽名规范、密钥零进表（D6）', () => {
  const entries = Object.entries(SEMANTIC_KEYS);
  assert.equal(entries.length, 26, '可配置变量全量语义化：新增/删除键必须同步本表与 TUI-MANUAL 模板');
  for (const [key, slot] of entries) {
    assert.match(slot, /^SUNSHINEX_[A-Z0-9_]+$/, `${key} 槽名须为 SUNSHINEX_* 规范形态`);
    assert.ok(!slot.includes('API_KEY'), `${key} 不得映射密钥槽（D6：密钥只走 env 块或环境变量）`);
  }
  assert.equal(SEMANTIC_KEYS['shell'], 'SUNSHINEX_SHELL');
  assert.equal(SEMANTIC_KEYS['globalSunshine'], 'SUNSHINEX_GLOBAL_SUNSHINE');
  assert.equal(SEMANTIC_KEYS['autoMemory'], 'SUNSHINEX_AUTO_MEMORY');
  assert.equal(SEMANTIC_KEYS['learnedSkillLimit'], 'SUNSHINEX_LEARNED_SKILL_LIMIT');
  assert.equal(SEMANTIC_KEYS['memoryIdleKickMs'], 'SUNSHINEX_MEMORY_IDLE_KICK_MS');
  assert.equal(SEMANTIC_KEYS['stepDigestTotalChars'], 'SUNSHINEX_MEMORY_STEP_DIGEST_TOTAL_CHARS');
  assert.equal(SEMANTIC_KEYS['projectsDir'], 'SUNSHINEX_PROJECTS_DIR', '项目数据根可指定（数据不必落家目录所在盘）');
  assert.equal(SEMANTIC_KEYS['dataDir'], undefined, 'dataDir 已退役：不隔离的整目录直指口不进用户配置面（只留环境变量给测试与多实例）');
  assert.equal(RETIRED_KEYS['dataDir'] !== undefined, true, '退役键必须留定向提示，不能静默变「未知键」');
});

/**
 * 退役键与未知键必须分开处置：未知键是拼错（提示改拼即可），
 * 退役键是配置面主动收回——只提示「未知键」会把用户引向反复试错，
 * 必须说清「换成哪个键 + 为什么不能再写这里」，并确保它绝不落槽。
 */
test('flattenSettings：dataDir 走退役定向提示、不落槽，且与未知键文案可区分', () => {
  const retired = flattenSettings({ semantic: { dataDir: 'D:\\shared-data' }, env: {} });
  assert.equal(retired.slots['SUNSHINEX_DATA_DIR'], undefined, '退役键绝不落槽（否则隔离语义又被绕开）');
  assert.equal(retired.warnings.length, 1);
  assert.ok(retired.warnings[0]!.includes('projectsDir'), '提示须给出替代键');
  assert.ok(retired.warnings[0]!.includes('不按工作区隔离'), '提示须说清为何不能再写这里');
  assert.ok(!retired.warnings[0]!.includes('未知语义键'), '退役键不得被当未知键');

  const unknown = flattenSettings({ semantic: { dataDirX: 'x' }, env: {} });
  assert.equal(unknown.warnings.length, 1);
  assert.ok(unknown.warnings[0]!.includes('未知语义键'), '真拼错仍走未知键口径');
});

test('空串等价未配置：语义键与 env 块空串均不落槽（模板占位安全）', () => {
  const { slots, warnings } = flattenSettings({
    semantic: { model: '', autoMemory: '', learnedSkillLimit: '' },
    env: { SUNSHINEX_API_KEY: '', SUNSHINEX_BING_API_KEY: 'sk-bing' },
  });
  assert.equal(slots['SUNSHINEX_MODEL'], undefined, '语义键空串不落槽');
  assert.equal(slots['SUNSHINEX_AUTO_MEMORY'], undefined, '空串不得触发 on|off fail-fast');
  assert.equal(slots['SUNSHINEX_LEARNED_SKILL_LIMIT'], undefined, '空串不得触发整数 fail-fast');
  assert.equal(slots['SUNSHINEX_API_KEY'], undefined, 'env 块空串不落槽');
  assert.equal(slots['SUNSHINEX_BING_API_KEY'], 'sk-bing', '非空 env 块键照常透传');
  assert.deepEqual(warnings, []);
});

test('parseSettingsFile：JSONC 注释容忍——// 与 /* */ 注释、UTF-8 BOM（TUI-MANUAL 模板可原样照抄）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-jsonc-'));
  try {
    const file = path.join(dir, 'settings.json');
    // 与 TUI-MANUAL 模板同形态：段标题行注释 + 行尾注释 + 跨行块注释 + 字符串内 //（真实 URL）
    fs.writeFileSync(file, [
      '{',
      '  "version": 1,',
      '  // ── 模型 ──',
      '  "model": "glm-5.3-flash",        // 主模型（任意 OpenAI 协议兼容模型）',
      '  "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",  // 字符串里的 // 是普通字符，不是注释',
      '  /* 块注释',
      '     可跨行 */',
      '  "tier": "medium",',
      '  "env": {',
      '    "SUNSHINEX_API_KEY": "sk-test"',
      '  }',
      '}',
    ].join('\n'));
    const doc = parseSettingsFile(file);
    assert.ok(doc, '带注释的 JSONC 文档应可解析（模板即契约）');
    assert.equal(doc.semantic['model'], 'glm-5.3-flash', '行尾注释不得吃掉键值');
    assert.equal(
      doc.semantic['baseUrl'],
      'https://open.bigmodel.cn/api/coding/paas/v4',
      '字符串内的 // 绝不能被当注释截断（正则剥离式实现的头号事故）',
    );
    assert.equal(doc.semantic['tier'], 'medium', '块注释后的键照常取到');
    assert.equal(doc.env['SUNSHINEX_API_KEY'], 'sk-test', 'env 块在注释文档中照常解析');

    const bomFile = path.join(dir, 'settings-bom.json');
    fs.writeFileSync(bomFile, '\uFEFF' + JSON.stringify({ model: 'glm-5.3-flash' }));
    const docBom = parseSettingsFile(bomFile);
    assert.ok(docBom, '带 UTF-8 BOM 的文档（Windows 记事本存盘形态）应可解析');
    assert.equal(docBom.semantic['model'], 'glm-5.3-flash');

    const missingComma = path.join(dir, 'settings-missing-comma.json');
    fs.writeFileSync(missingComma, '{ "model": "x" "tier": "medium" }');
    assert.throws(() => parseSettingsFile(missingComma), (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.includes(missingComma) && msg.includes('畸形 JSON');
    }, '容忍注释与尾随逗号，但真缺分隔符仍须 fail-fast 并带路径');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { pushPendingMcpHint } from './commands-mcp';
import { projectSlug } from '../config/data-dir';

/**
 * Task 20（Phase E）/mcp /agents /plugins /providers TUI 面板族验收（brief 用例）：
 * ① /mcp 无参两级列表卡（名称/scope/启停状态点/待确认徽标/approval/遮蔽标注）
 * ② /mcp approve|deny 子命令写全局 settings 批准阀
 * ③ /mcp enable 落 mcp.json（项目/全局两作用域），disable 翻转
 * ④ /agents /plugins /providers 面板与启停
 * ⑤ 项目 MCP 未批准提示（pushPendingMcpHint：pending 一行、零 pending 静默）
 * 沿 commands-skills 族测试先例（SessionController + ScriptedAdapter 桩 + pushMsg 断言）；
 * HOME 钉 tmp 整体隔离全局 settings/mcp.json（catalog/approvals.test 同款纪律）。
 */

interface Fixture {
  home: string;
  root: string;
  ctrl: SessionController;
}

/** 双 tmp 夹具：home 钉全局面（settings/mcp.json），root 为项目面；env 全量钉 + finally 还原 */
async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t20-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t20-root-'));
  const prevHome = process.env.HOME;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  const prevSkills = process.env.SUNSHINEX_USER_SKILLS_DIR;
  const prevSunshine = process.env.SUNSHINEX_GLOBAL_SUNSHINE;
  process.env.HOME = home;
  process.env.SUNSHINEX_DATA_DIR = path.join(home, 'data');
  process.env.SUNSHINEX_USER_SKILLS_DIR = path.join(home, 'user-skills');
  process.env.SUNSHINEX_GLOBAL_SUNSHINE = home;
  let ctrl: SessionController | undefined;
  try {
    ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    await fn({ home, root, ctrl });
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR; else process.env.SUNSHINEX_DATA_DIR = prevData;
    if (prevSkills === undefined) delete process.env.SUNSHINEX_USER_SKILLS_DIR; else process.env.SUNSHINEX_USER_SKILLS_DIR = prevSkills;
    if (prevSunshine === undefined) delete process.env.SUNSHINEX_GLOBAL_SUNSHINE; else process.env.SUNSHINEX_GLOBAL_SUNSHINE = prevSunshine;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 项目 mcp.json 夹具：fs（启用）+ web（整机停用 enabled:false） */
function writeProjectMcp(root: string): void {
  fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sunshinex', 'mcp.json'), JSON.stringify({
    mcpServers: {
      fs: { command: 'npx' },
      web: { command: 'node', enabled: false },
    },
  }));
}

/** 全局 mcp.json 夹具（$HOME/.sunshinex/mcp.json）：gsrv 一台（全局条目恒不过批准阀） */
function writeGlobalMcp(home: string): void {
  fs.mkdirSync(path.join(home, '.sunshinex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.sunshinex', 'mcp.json'), JSON.stringify({
    mcpServers: { gsrv: { command: 'node' } },
  }));
}

const sysTexts = (ctrl: SessionController): string[] =>
  ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text);

/** 项目 mcp.json 回读（enable/disable 落盘断言面） */
function readProjMcp(root: string): { mcpServers: Record<string, { enabled?: boolean }> } {
  return JSON.parse(fs.readFileSync(path.join(root, '.sunshinex', 'mcp.json'), 'utf8'));
}

/** 全局 settings.json 回读（approve/deny 批准阀断言面） */
function readGlobalSettings(home: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(home, '.sunshinex', 'settings.json'), 'utf8'));
}

test('/mcp 无参：两级列表卡含名称/scope/启停状态点/待确认徽标/approval/遮蔽与用法行', async () => {
  await withFixture(async ({ root, ctrl }) => {
    writeProjectMcp(root);
    writeGlobalMcp(process.env.HOME!);
    await ctrl.submit('/mcp');
    const text = sysTexts(ctrl).join('\n');
    // fs：项目条目、启用（状态点 on）、未审（pending 待确认徽标 + approve 指引）
    assert.ok(/fs \[project\] on/.test(text), `fs 行应含 [project] on：${JSON.stringify(text)}`);
    assert.ok(/approval:\s*pending|待确认/.test(text), 'fs 应带 pending 审批态/待确认徽标');
    assert.ok(/\/mcp approve fs/.test(text), 'pending 行应附 approve 指引');
    // web：整机停用（状态点 off）
    assert.ok(/web \[project\] off/.test(text), `web 行应含 off：${JSON.stringify(text)}`);
    // gsrv：全局条目（approval none——全局恒不过阀）
    assert.ok(/gsrv \[global\] on/.test(text), 'gsrv 行应含 [global]');
    // 用法行
    assert.ok(/Usage: \/mcp|用法：\/mcp/.test(text), '列表卡尾应附用法行');
  });
});

test('/mcp approve|deny：写全局 settings 批准阀（mcpApprovals/mcpDenied 按 slug 记账），回执后重绘含 approved', async () => {
  await withFixture(async ({ home, root, ctrl }) => {
    writeProjectMcp(root);
    await ctrl.submit('/mcp approve fs');
    const doc = readGlobalSettings(home);
    const slug = projectSlug(root);
    assert.deepEqual((doc['mcpApprovals'] as Record<string, unknown>)[slug], ['fs'], 'approve 应写 mcpApprovals.<slug>');
    const text = sysTexts(ctrl).join('\n');
    assert.ok(/approval:\s*approved|已批准/.test(text), '回执重绘应含 approved：' + JSON.stringify(text));
    // deny 互斥：撤批准入拒绝
    await ctrl.submit('/mcp deny fs');
    const doc2 = readGlobalSettings(home);
    assert.deepEqual((doc2['mcpDenied'] as Record<string, unknown>)[slug], ['fs'], 'deny 应写 mcpDenied.<slug>');
    assert.deepEqual((doc2['mcpApprovals'] as Record<string, unknown>)[slug], [], 'deny 应对批准侧除名');
  });
});

test('/mcp enable|disable：落 mcp.json（项目 enabled 键翻转），全局条目写全局 mcp.json；回执后重绘', async () => {
  await withFixture(async ({ home, root, ctrl }) => {
    writeProjectMcp(root);
    writeGlobalMcp(home);
    // web 起始 enabled:false → enable 翻 true（brief：enable 落 mcp.json）
    await ctrl.submit('/mcp enable web');
    assert.equal(readProjMcp(root).mcpServers['web']!.enabled, true, 'enable 应写项目 mcp.json enabled:true');
    assert.ok(/web \[project\] on/.test(sysTexts(ctrl).join('\n')), '回执重绘应含 web on');
    // fs 起始缺省启用 → disable 落 enabled:false
    await ctrl.submit('/mcp disable fs');
    assert.equal(readProjMcp(root).mcpServers['fs']!.enabled, false, 'disable 应写项目 mcp.json enabled:false');
    // 全局条目启停写全局文件
    await ctrl.submit('/mcp disable gsrv');
    const gdoc = JSON.parse(fs.readFileSync(path.join(home, '.sunshinex', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, { enabled?: boolean }> };
    assert.equal(gdoc.mcpServers['gsrv']!.enabled, false, '全局条目 disable 应写全局 mcp.json');
  });
});

test('/mcp 带参守卫：未知动作/未知名称给用法或错误行（不落任务流）', async () => {
  await withFixture(async ({ root, ctrl }) => {
    writeProjectMcp(root);
    await ctrl.submit('/mcp frobnicate fs');
    assert.ok(sysTexts(ctrl).some((x) => /Usage: \/mcp|用法：\/mcp/.test(x)), '未知动作应回用法行');
    await ctrl.submit('/mcp enable nosuch');
    assert.ok(sysTexts(ctrl).some((x) => /nosuch/.test(x) && /not found|找不到/.test(x)), '未知名称应回错误行');
    assert.ok(sysTexts(ctrl).every((x) => !/error:|错误：/.test(x) || /nosuch/.test(x)), '错误行仅未知名称一条');
  });
});

test('/mcp approve 全局条目：批准阀只适用项目作用域（提示不写盘）', async () => {
  await withFixture(async ({ home, ctrl }) => {
    writeGlobalMcp(home);
    await ctrl.submit('/mcp approve gsrv');
    assert.ok(
      sysTexts(ctrl).some((x) => /project|项目/.test(x)),
      '全局条目 approve 应提示批准阀仅项目作用域',
    );
    assert.ok(!fs.existsSync(path.join(home, '.sunshinex', 'settings.json')), '全局条目 approve 不得写批准阀');
  });
});

test('pushPendingMcpHint：项目有 pending 条目 push 一行提示；全部批准后零新增（非阻塞）', async () => {
  await withFixture(async ({ root, ctrl }) => {
    writeProjectMcp(root);
    const hintCount = (): number => sysTexts(ctrl).filter((x) => /awaiting approval \(|待确认服务器（/.test(x)).length;
    pushPendingMcpHint(ctrl);
    assert.equal(hintCount(), 1, 'pending 时恰一行提示');
    assert.ok(
      sysTexts(ctrl).some((x) => /awaiting approval \(fs, web\)|待确认服务器（fs, web）/.test(x) && /\/mcp/.test(x)),
      '提示应含数量/名单与 /mcp 入口',
    );
    // 全部批准后零新增提示（静默）
    await ctrl.submit('/mcp approve fs');
    await ctrl.submit('/mcp approve web');
    pushPendingMcpHint(ctrl);
    assert.equal(hintCount(), 1, '全部批准后零新增提示');
  });
});

/* ---------- /agents /plugins /providers ---------- */

test('T20 评审修补：畸形全局 settings 下读面遏制——/mcp /plugins 不 throw 出 warn 行，不杀会话', async () => {
  await withFixture(async ({ home, root, ctrl }) => {
    writeProjectMcp(root);
    // 触发窗：approvalState → parseSettingsFile 对畸形全局 settings fail-fast throw（装载链纪律）——
    // 回归即 submit 拒绝（生产 fire-and-forget 下即未处理拒绝杀进程），本用例整体失败
    fs.mkdirSync(path.join(home, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.sunshinex', 'settings.json'), '{ broken');
    await ctrl.submit('/mcp');
    assert.ok(
      sysTexts(ctrl).some((x) => /MCP listing failed|MCP 清单读取失败/.test(x)),
      `读面失败应出 warn 错误行：${JSON.stringify(sysTexts(ctrl))}`,
    );
    // 带参查找同读面：遏制后短路——不落写、不误报 not-found、不二次 throw
    await ctrl.submit('/mcp enable fs');
    assert.ok(
      sysTexts(ctrl).filter((x) => /MCP listing failed|MCP 清单读取失败/.test(x)).length >= 2,
      '带参查找路径同遏制（重绘/写路径不触达）',
    );
    assert.equal(readProjMcp(root).mcpServers['fs']!.enabled, undefined, '读面失败不落写');
    // /plugins 读面（loadEffectivePlugins → parseSettingsFile 同 fail-fast）
    await ctrl.submit('/plugins');
    assert.ok(
      sysTexts(ctrl).some((x) => /Plugin listing failed|插件清单读取失败/.test(x)),
      '插件读面同遏制',
    );
  });
});

test('T20 评审修补：pushPendingMcpHint 读面失败降级 console.warn——不 throw、零消息入档、不炸启动', async () => {
  await withFixture(async ({ home, root, ctrl }) => {
    writeProjectMcp(root); // 项目 pending 条目在场——读面走 approvalState 才会触雷
    fs.mkdirSync(path.join(home, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.sunshinex', 'settings.json'), '{ broken');
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: unknown): void => { warns.push(String(m)); };
    try {
      pushPendingMcpHint(ctrl); // 回归即 throw 杀启动——本行不抛即降级生效
    } finally {
      console.warn = orig;
    }
    assert.equal(sysTexts(ctrl).length, 0, '启动提示失败不 push 消息（App 未挂载）');
    assert.equal(warns.length, 1, '失败降级 console.warn 诊断面');
    assert.ok(/pending MCP hint|未批准提示/.test(warns[0]!), 'warn 应点明跳过原因');
  });
});

test('/agents：面板列 id/scope/启停/描述；enable|disable 写所在作用域 agent.md', async () => {
  await withFixture(async ({ root, ctrl }) => {
    const dir = path.join(root, '.sunshinex', 'agents', 'reviewer');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.md'), '---\nname: Reviewer\ndescription: reviews code\nversion: 1.0.0\n---\n\nBody.');
    await ctrl.submit('/agents');
    const text = sysTexts(ctrl).join('\n');
    assert.ok(/reviewer \[project\] on/.test(text), `面板应列 reviewer [project] on：${JSON.stringify(text)}`);
    assert.ok(/Reviewer|reviews code/.test(text), '面板行应带 name/description');
    // agents-teams P1（Task 5）：列表卡附 $<agent-id> 点名用法提示行（$ 软引用与 /teams 的 # 对偶）
    assert.ok(
      /Usage: name a single agent in your message as \$<agent-id>|用法：.*\$<agent-id>/.test(text),
      `列表卡应附 $<agent-id> 用法行：${JSON.stringify(text)}`,
    );
    await ctrl.submit('/agents disable reviewer');
    const md = fs.readFileSync(path.join(dir, 'agent.md'), 'utf8');
    assert.ok(/^enabled: false$/m.test(md), 'disable 应写 agent.md enabled:false 行');
    assert.ok(/reviewer \[project\] off/.test(sysTexts(ctrl).join('\n')), '回执重绘应含 reviewer off');
    await ctrl.submit('/agents enable reviewer');
    assert.ok(/^enabled: true$/m.test(fs.readFileSync(path.join(dir, 'agent.md'), 'utf8')), 'enable 翻回 true');
  });
});

test('/plugins：面板列内置插件（id/启停/平台可用）；enable 写项目 settings plugins.<id>.enabled', async () => {
  await withFixture(async ({ root, ctrl }) => {
    await ctrl.submit('/plugins');
    const text = sysTexts(ctrl).join('\n');
    assert.ok(/browser-use/.test(text), `面板应列内置插件 browser-use：${JSON.stringify(text)}`);
    await ctrl.submit('/plugins enable browser-use');
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.sunshinex', 'settings.json'), 'utf8')) as { plugins?: Record<string, { enabled?: boolean }> };
    assert.equal(settings.plugins?.['browser-use']?.enabled, true, 'enable 应写项目 settings plugins.<id>.enabled');
  });
});

test('/providers：清单卡含源名/模型数/密钥槽状态/默认标记 + 编辑引导行；未配置给指引', async () => {
  await withFixture(async ({ root, ctrl }) => {
    // 未配置 providers → 配置指引（与 /model 无卡同款引导）
    await ctrl.submit('/providers');
    assert.ok(
      sysTexts(ctrl).some((x) => /providers|提供方/.test(x)),
      '未配置应给 providers 配置指引',
    );
    // 两源夹具：alpha 2 模型（缺省源=choices[0] 所属）、beta 1 模型
    fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sunshinex', 'settings.json'), JSON.stringify({
      version: 1,
      providers: [
        { name: 'alpha', baseUrl: 'https://a.example', models: [{ model: 'm1' }, { model: 'm2' }] },
        { name: 'beta', baseUrl: 'https://b.example', models: [{ model: 'm3' }] },
      ],
    }));
    const ctrl2 = new SessionController({ root, model: new ScriptedAdapter([]) });
    await ctrl2.submit('/providers');
    const text = sysTexts(ctrl2).join('\n');
    assert.ok(/alpha.*2/.test(text), `alpha 行应含模型数 2：${JSON.stringify(text)}`);
    assert.ok(/beta.*1/.test(text), 'beta 行应含模型数 1');
    assert.ok(/SUNSHINEX_API_KEY_ALPHA/.test(text), '密钥槽名应上屏');
    assert.ok(/default|默认/.test(text), 'choices[0] 所属源应带默认标记');
    assert.ok(/sunshinex providers|\$EDITOR/.test(text), '编辑引导行（CLI/$EDITOR，TUI 不做表单）');
  });
});

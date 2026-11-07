import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';

/**
 * agents-teams P1（Task 5）/teams TUI 面板验收（brief 5a 用例）：
 * ① /teams 无参两级清单卡（source/启停状态点/members 展示/遮蔽标注/missing 成员警示）+ 用法行
 * ② /teams 空清单给落位与管理引导行
 * ③ /teams 带参一律写引导行（spec §6.3：TUI 面板只读，零写盘）
 * ④ 读面失败遏制（目录损坏 → warn 错误行不抛死，镜像 commands-mcp readListing 遏制用例）
 * 沿 commands-mcp.test.ts 先例（SessionController + ScriptedAdapter 桩 + pushMsg 断言）；
 * HOME 钉 tmp 整体隔离全局 teams 目录（catalog/teams.test 同款纪律）。
 */

interface Fixture {
  home: string;
  root: string;
  ctrl: SessionController;
}

/** 双 tmp 夹具：home 钉全局面（teams 全局目录），root 为项目面；env 全量钉 + finally 还原 */
async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t5-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t5-root-'));
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

/** 项目/全局 team.md 夹具（catalog 视图几何：<teams 目录>/<id>/team.md）；返回 team.md 路径。
 *  dir 显式传参写全局（home）；缺省写项目（root）。members 逐项空格 join 单行（解析面词法） */
function writeTeam(base: string, id: string, opts: { name: string; description: string; members: string[]; enabled?: boolean }): string {
  const dir = path.join(base, '.sunshinex', 'teams', id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `name: ${opts.name}`, `description: ${opts.description}`, 'version: 1.0.0', `members: ${opts.members.join(' ')}`];
  if (opts.enabled === false) lines.push('enabled: false');
  const file = path.join(dir, 'team.md');
  fs.writeFileSync(file, [...lines, '---', '', `Body of ${opts.name}.`].join('\n'));
  return file;
}

const sysTexts = (ctrl: SessionController): string[] =>
  ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text);

test('/teams 无参：两级清单卡（source/启停状态点/members/遮蔽标注/missing 警示）+ 用法行', async () => {
  await withFixture(async ({ home, root, ctrl }) => {
    // planner/reviewer 是内建四角色（在册不算 missing）；ghost 非在册 → fix-crew missing 警示
    writeTeam(root, 'fix-crew', { name: 'Fix Crew', description: 'fixes bugs', members: ['planner', 'ghost'] });
    writeTeam(root, 'solo', { name: 'Solo', description: 'one agent', members: ['planner'], enabled: false });
    writeTeam(home, 'gcrew', { name: 'G Crew', description: 'global crew', members: ['reviewer'] });
    // 同 id 两级：全局行保留 + shadowed 标注，项目行生效
    writeTeam(root, 'dup', { name: 'Dup', description: 'project copy', members: ['planner'] });
    writeTeam(home, 'dup', { name: 'Dup', description: 'global copy', members: ['planner'] });
    await ctrl.submit('/teams');
    const text = sysTexts(ctrl).join('\n');
    assert.ok(/fix-crew \[project\] on/.test(text), `fix-crew 应列 [project] on：${JSON.stringify(text)}`);
    assert.ok(/gcrew \[global\] on/.test(text), 'gcrew 应列 [global]');
    assert.ok(/solo \[project\] off/.test(text), 'enabled:false 团队应列 off');
    assert.ok(/dup \[global\] on · shadowed/.test(text), '被遮蔽全局行应保留 + shadowed 标注');
    assert.ok(/dup \[project\] on/.test(text), '生效项目行照列');
    assert.ok(/Fix Crew: fixes bugs/.test(text), '行应带 name: description');
    assert.ok(/\(members: planner, ghost\)/.test(text), '行应附 members 展示');
    assert.ok(/missing agents: ghost|缺失智能体：ghost/.test(text), 'missing>0 团队应附警示行');
    assert.ok(/Usage: reference a team in your message as #<team-id>.*GUI settings \(Agent Teams\)|用法：.*#<team-id>.*Agent Teams/.test(text), '列表卡尾应附 #<team-id> 用法行');
  });
});

test('/teams 空清单：零团队给落位/管理引导行（不报错）', async () => {
  await withFixture(async ({ ctrl }) => {
    await ctrl.submit('/teams');
    const text = sysTexts(ctrl).join('\n');
    assert.ok(/Teams \(0\):|团队（0 个）/.test(text), `头行应计零：${JSON.stringify(text)}`);
    assert.ok(/No teams defined|未定义团队/.test(text), '空清单应给落位引导行');
  });
});

test('/teams 带参：写引导行（TUI 面板只读，不执行任何写）', async () => {
  await withFixture(async ({ root, ctrl }) => {
    const file = writeTeam(root, 'fix-crew', { name: 'Fix Crew', description: 'fixes bugs', members: ['planner'] });
    await ctrl.submit('/teams enable fix-crew');
    const text = sysTexts(ctrl).join('\n');
    assert.ok(/GUI settings \(Agent Teams\)|GUI 设置（Agent Teams）/.test(text), `带参应回写引导行：${JSON.stringify(text)}`);
    assert.ok(!/^enabled:/m.test(fs.readFileSync(file, 'utf8')), '带参不得落任何写（team.md 零触碰）');
    assert.ok(!sysTexts(ctrl).some((x) => /ok:/.test(x)), '无执行回执（未执行写）');
  });
});

test('T5 读面遏制：teams 目录损坏（文件占位）→ /teams 出 warn 错误行，不抛死会话', async () => {
  await withFixture(async ({ root, ctrl }) => {
    // 触发窗：listTeams 项目目录扫描 readdirSync 对文件占位 throw（ENOTDIR）——回归即 submit
    // 拒绝（生产 fire-and-forget 下即未处理拒绝杀进程），本用例整体失败
    fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sunshinex', 'teams'), 'not a dir');
    await ctrl.submit('/teams');
    assert.ok(
      sysTexts(ctrl).some((x) => /Teams listing failed|团队清单读取失败/.test(x)),
      `读面失败应出 warn 错误行：${JSON.stringify(sysTexts(ctrl))}`,
    );
    // 带参路径不触读面（只读面板带参直接回引导行）——不再二次报错
    await ctrl.submit('/teams enable x');
    assert.ok(
      sysTexts(ctrl).filter((x) => /Teams listing failed|团队清单读取失败/.test(x)).length === 1,
      '带参写引导不触读面（遏制只此一条）',
    );
  });
});

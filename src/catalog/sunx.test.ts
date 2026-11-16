// src/catalog/sunx.test.ts —— catalog/sunx 读面（品性模板两级视图 + 遮蔽标注 + 坏档宽容）钉行为。
// 纪律：HOME 一律 mkdtempSync(tmpdir()) 桩钉（沿 teams.test.ts withFixture 先例：桩保密闭全局面，
// 绝不触真实用户配置目录——listSunxTemplates 全局分支经 sunxDir('global') 落 HOME/.sunshinex/sunx）。
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { listSunxTemplates, sunxDir } from './sunx';

/** HOME 钉桩 + 夹具：<root>/uhome 充 userConfigDir（HOME=<root>/uhome → 全局 sunx 目录=
 *  <uhome>/.sunshinex/sunx）；收尾还原 HOME，跨用例零状态泄漏。 */
function withFixture(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-sunx-'));
  const uhome = path.join(root, 'uhome');
  const prev = process.env.HOME;
  process.env.HOME = uhome;
  try {
    fn(root);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

/** 在 <sunxBase>/<id>/sunx.md 写一个模板档（sunxBase=所在 sunx 目录） */
function writeTpl(sunxBase: string, id: string, md: string): void {
  fs.mkdirSync(path.join(sunxBase, id), { recursive: true });
  fs.writeFileSync(path.join(sunxBase, id, 'sunx.md'), md, 'utf8');
}

test('listSunxTemplates: 两级列出（层序 global→project，各层内 id 字典序）+ 同 id 全局行 shadowed:true 保留', () => {
  withFixture((root) => {
    const globalBase = sunxDir('global', root); // HOME 钉桩下 = <uhome>/.sunshinex/sunx
    const projectBase = sunxDir('project', root); // <root>/.sunshinex/sunx
    writeTpl(globalBase, 'steward', '---\nname: 仓库管家\n---\n全局章程');
    writeTpl(globalBase, 'shared', '---\nname: Shared G\n---\n全局版章程');
    writeTpl(projectBase, 'reviewer', '---\nname: 评审官\n---\n项目章程');
    writeTpl(projectBase, 'shared', '---\nname: Shared P\n---\n项目版章程');
    const listing = listSunxTemplates(root);
    assert.deepEqual(
      listing.entries.map((e) => [e.id, e.source, e.shadowed]),
      [
        ['shared', 'global', true], // 项目撞全局：被撞全局行保留在列标 shadowed（视图口径）
        ['steward', 'global', false],
        ['reviewer', 'project', false],
        ['shared', 'project', false],
      ],
      '层序=装载序 global→project（各层内 id 字典序）；同 id 全局行 shadowed:true、项目行生效',
    );
  });
});

test('listSunxTemplates: 行形状 {id,name,description?,charter 全文,source,shadowed}——description 空省键、charter 多行全量不截断', () => {
  withFixture((root) => {
    const projectBase = sunxDir('project', root);
    writeTpl(projectBase, 'with-desc', '---\nname: 有描述\ndescription: 一行简介\n---\n章程正文');
    writeTpl(projectBase, 'no-desc', '---\nname: 无描述\n---\n第一段章程\n\n第二段章程');
    const listing = listSunxTemplates(root);
    assert.deepEqual(listing.entries.find((e) => e.id === 'with-desc'), {
      id: 'with-desc', name: '有描述', description: '一行简介', charter: '章程正文', source: 'project', shadowed: false,
    }, 'description 非空透出（可选键按需）');
    assert.deepEqual(listing.entries.find((e) => e.id === 'no-desc'), {
      id: 'no-desc', name: '无描述', charter: '第一段章程\n\n第二段章程', source: 'project', shadowed: false,
    }, 'description 空省键；charter=frontmatter 后正文全量（多行保留、无预览帽——弹窗回填全文）');
    assert.ok(!('description' in listing.entries.find((e) => e.id === 'no-desc')!), 'description 键不落（省键非空串）');
  });
});

test('listSunxTemplates: 坏档宽容——畸形档进 warnings 跳过不抛死（全程宽容口径，弹窗挑选面零 fail-fast）', () => {
  withFixture((root) => {
    const globalBase = sunxDir('global', root);
    writeTpl(globalBase, 'ok', '---\nname: Ok\n---\n章程');
    writeTpl(globalBase, 'no-fm', '没有 frontmatter 的纯文本\n'); // 缺 frontmatter 块
    writeTpl(globalBase, 'no-name', '---\ndescription: 缺 name\n---\n章程'); // 块在但缺 name
    const listing = listSunxTemplates(root);
    assert.deepEqual(listing.entries.map((e) => e.id), ['ok'], '坏档不入列、好档照列');
    assert.equal(listing.warnings.length, 2, '两坏档各一行 warning');
    assert.ok(listing.warnings.every((w) => w.includes('sunx.md')), 'warning 指名坏档路径');
    assert.ok(listing.warnings.every((w) => !w.includes('agent.md')), 'warning 文案以实际文件名落地（agent.md 语料不透传——终审修复波 Fix 4）');
    assert.ok(listing.warnings.some((w) => w.includes('sunx.md missing frontmatter')), '缺 frontmatter 文案指名 sunx.md（Fix 4：parseAgentFrontmatter 原生文案硬编码 agent.md）');
    assert.ok(listing.warnings.some((w) => w.includes('no-fm')), 'warning 含缺 frontmatter 档');
    assert.ok(listing.warnings.some((w) => w.includes('no-name')), 'warning 含缺 name 档');
  });
});

test('listSunxTemplates: 目录缺/空 = 空注册零 warnings；非目录条目与缺 sunx.md 的目录跳过', () => {
  withFixture((root) => {
    assert.deepEqual(listSunxTemplates(root), { entries: [], warnings: [] }, '两级目录全缺=空清单零告警');
    const globalBase = sunxDir('global', root);
    fs.mkdirSync(globalBase, { recursive: true });
    fs.writeFileSync(path.join(globalBase, 'loose-file.txt'), '散文件不入列', 'utf8'); // 非目录条目
    fs.mkdirSync(path.join(globalBase, 'empty-dir'), { recursive: true }); // 目录但缺 sunx.md
    const listing = listSunxTemplates(root);
    assert.deepEqual(listing, { entries: [], warnings: [] }, '几何不合（非目录/缺 sunx.md）静默跳过，非坏档零告警');
  });
});

test('listSunxTemplates: root:null 项目级整体跳过（只列全局，沿 listAgents 口径——无项目上下文不落 cwd 伪扫）', () => {
  withFixture((root) => {
    writeTpl(sunxDir('global', root), 'g-tpl', '---\nname: G Tpl\n---\n章程');
    writeTpl(sunxDir('project', root), 'p-tpl', '---\nname: P Tpl\n---\n章程');
    const listing = listSunxTemplates(null);
    assert.deepEqual(
      listing.entries.map((e) => [e.id, e.source]),
      [['g-tpl', 'global']],
      'root:null 只列全局（项目级整体跳过）',
    );
    assert.deepEqual(listing.warnings, []);
  });
});

test('sunxDir: 落位单点——project=<root>/.sunshinex/sunx、global=域容器根（sunxContainerDir 单点,2026-11-16 补审 G1 同源）；globalDir 显式传参=测试/重定向口', () => {
  withFixture((root) => {
    assert.equal(sunxDir('project', root), path.join(root, '.sunshinex', 'sunx'));
    assert.equal(sunxDir('global', root), path.join(root, 'uhome', '.sunshinex', 'sunx'));
    // SUNSHINEX_SUNX_DIR 覆盖（≡settings 语义键 sunxDir）直指容器根——模板全局层与持久化域同迁（G1 同源语义）
    const prevEnv = process.env.SUNSHINEX_SUNX_DIR;
    process.env.SUNSHINEX_SUNX_DIR = path.join(root, 'container');
    try {
      assert.equal(sunxDir('global', root), path.join(root, 'container'));
    } finally {
      if (prevEnv === undefined) delete process.env.SUNSHINEX_SUNX_DIR;
      else process.env.SUNSHINEX_SUNX_DIR = prevEnv;
    }
    // 显式 globalDir 全路径直指（测试/重定向口,不再追 /sunx 后缀——2026-11-16 补审 G1 起与容器同形）
    assert.equal(sunxDir('global', root, path.join(root, 'explicit')), path.join(root, 'explicit'));
    writeTpl(path.join(root, 'explicit'), 'x', '---\nname: X\n---\n章程');
    assert.deepEqual(
      listSunxTemplates(root, path.join(root, 'explicit')).entries.map((e) => e.id),
      ['x'],
      'globalDir 显式传参重定向读面（不触 HOME 派生位）',
    );
  });
});

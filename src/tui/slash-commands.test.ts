import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SLASH_COMMANDS } from './slash-commands';

/** MANUAL 会话命令表 × SLASH_COMMANDS 双向对账钉（D39 家族·文档面兜底）：
 *  命令清单两大消费面 = 菜单/补全（代码，SlashMenu.test 已单源推导）与 MANUAL 命令表（文档）——
 *  历史上清单两次扩容（G14.29 补登 /btw·/side、归档特性补登 /archive·/delete）都漏了文档行，
 *  靠人工对账捞起；本钉把「每个命令有行、行内斜杠 token 是命令」变成机器闸门，清单演进即红。 */

const MANUAL_PATH = path.resolve(__dirname, '../../MANUAL.md');

/** 会话命令表区段（**会话命令** 起、「任务形态」节前）的表格行——区外（CLI 命令总表/正文提及其它命令）不采集 */
function manualSlashRows(): string[] {
  const md = fs.readFileSync(MANUAL_PATH, 'utf8');
  const start = md.indexOf('**会话命令**');
  const end = md.indexOf('**任务形态与专项能力**');
  assert.ok(start >= 0 && end > start, 'MANUAL 会话命令区段定位（表结构漂移即红，先修锚点）');
  return md
    .slice(start, end)
    .split('\n')
    .filter((l) => l.startsWith('| `'));
}

/** 行内斜杠 token（`/小写标识符` 形态）：lookbehind 排除词中缀斜杠（如「md/txt」扩展名对）；
 *  `/<技能id>` 参数化行、`--flag`、纯 `/` 与「task / reply」类文字分隔斜杠因后随字符不匹配
 *  小写标识符而自然排除 */
function slashTokens(row: string): string[] {
  return row.match(/(?<![a-zA-Z0-9_])\/[a-z0-9][a-z0-9-]*/g) ?? [];
}

test('MANUAL 会话命令表 × SLASH_COMMANDS 双向对账：每个命令有行（前向），行内 token 皆命令（反向）', () => {
  const documented = new Set(manualSlashRows().flatMap(slashTokens));
  const missing = SLASH_COMMANDS.filter((c) => !documented.has(c));
  assert.deepEqual(
    missing,
    [],
    `SLASH_COMMANDS 每条都须有 MANUAL 会话命令表行——缺行即文档漂移（本次缺：${missing.join(' ') || '无'}）`,
  );
  const unknown = [...documented].filter((t) => !SLASH_COMMANDS.includes(t));
  assert.deepEqual(
    unknown,
    [],
    `命令表行内 token 须都在 SLASH_COMMANDS 清单内——改名/删命令未清行即红（未知：${unknown.join(' ') || '无'}）`,
  );
  assert.equal(SLASH_COMMANDS.length, new Set(SLASH_COMMANDS).size, '清单自身无重复条目');
});

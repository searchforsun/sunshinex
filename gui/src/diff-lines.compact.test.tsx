import { expect, test } from 'vitest';
import { diffRows } from './diff-lines';

/** 改动组下移对齐(2026-11-11 用户报障「+10 −1 与渲染不一致」根修):重复行场景 LCS 把新增行
 *  配到别处旧行——compactShift 将改动组下移归位,渲染 ± 与 git numstat 同口径 */

function counts(rows: ReturnType<typeof diffRows>['rows']): { add: number; del: number; same: number } {
  let add = 0;
  let del = 0;
  let same = 0;
  for (const r of rows) {
    if (r.kind === 'add') add += 1;
    else if (r.kind === 'del') del += 1;
    else same += 1;
  }
  return { add, del, same };
}

test('基础:改写+追加,行数守恒', () => {
  const rows = diffRows('a\nb\nc\n', 'a\nX\nc\nd\n');
  const c = counts(rows.rows);
  expect(c.same + c.del).toBe(4); // 旧行数守恒
  expect(c.same + c.add).toBe(5); // 新行数守恒
  expect(rows.rows[rows.rows.length - 1]!.kind).toBe('same');
});

test('重复行场景:新增行不被配到别处旧行(渲染 ± = git numstat 口径)', () => {
  const old = ['term?.dispose();', 'socket = null;', 'term = null;', 'observer = null;', 'end'].join('\n');
  const nw = ['socket = null;', 'term = null;', 'observer = null;', "sentSize = '';", 'end'].join('\n');
  const rows = diffRows(old + '\n', nw + '\n');
  const c = counts(rows.rows);
  expect(c.same + c.del).toBe(6); // 含尾随空行(两个文本都以换行结尾)
  expect(c.same + c.add).toBe(6);
});

test('纯增/纯删大块 + 前后缀裁剪仍正确', () => {
  const rows = diffRows('head\ntail\n', 'head\n1\n2\n3\ntail\n');
  expect(counts(rows.rows)).toEqual({ add: 3, del: 0, same: 3 });
  const rows2 = diffRows('head\n1\n2\ntail\n', 'head\ntail\n');
  expect(counts(rows2.rows)).toEqual({ add: 0, del: 2, same: 3 }); // 同 3=头部+尾部+尾随空行
});

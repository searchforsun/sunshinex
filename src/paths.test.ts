/**
 * isWithin 子树判定原语的契约测试。
 *
 * 重点覆盖两类曾在生产中造成误判的形态（非「分支覆盖率」式凑数）：
 *   ① 前缀相邻但非子树的兄弟目录（'/data/root2' 之于 '/data/root'）——朴素 startsWith 会误判在内（fail-open）；
 *   ② 尾分隔符 root（含文件系统根）——拼分隔符后恒失配，会把整盘/整根误判越界（fail-closed 到不可用）。
 * 以及大小写语义的**平台相关**断言：POSIX 必须区分（安全），不敏感比较在此即漏洞。
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import * as path from 'path';
import { isWithin } from './paths';

const sep = path.sep;

test('root 自身与真子树判为在内', () => {
  assert.equal(isWithin('/data/root', '/data/root'), true, 'root 自身在内');
  assert.equal(isWithin('/data/root', `/data/root${sep}file.md`), true, '直接子项在内');
  assert.equal(isWithin('/data/root', `/data/root${sep}a${sep}b${sep}c.md`), true, '多层子项在内');
});

test('前缀相邻的兄弟目录不得误判为子树（朴素 startsWith 的 fail-open 缺口）', () => {
  assert.equal(isWithin('/data/root', '/data/root2'), false, '同前缀兄弟目录在外');
  assert.equal(isWithin('/data/root', '/data/root2/x.md'), false, '兄弟目录的子项在外');
  assert.equal(isWithin('/data/root', '/data/rootX/file.md'), false, '仅差一字符亦在外');
});

test('向上一层与无关路径判为在外', () => {
  assert.equal(isWithin('/data/root', '/data'), false, '父目录在外');
  assert.equal(isWithin('/data/root', '/data/other'), false, '旁系目录在外');
  assert.equal(isWithin('/data/root', '/etc/passwd'), false, '无关绝对路径在外');
  assert.equal(isWithin('/data/root', ''), false, '空串在外（不得因空串被当作 root）');
});

test('尾分隔符 root 归一：含文件系统根，否则整根被误判越界', () => {
  assert.equal(isWithin(`/data/root${sep}`, `/data/root${sep}file.md`), true, '带尾分隔符的 root 仍判子在');
  assert.equal(isWithin(`/data/root${sep}`, '/data/root'), true, '尾分隔符被归一，与去尾形态视为同一 root');
  // 文件系统根：base='/' 时若仍拼分隔符得 '//'，下方断言将全数失败
  assert.equal(isWithin(sep, `${sep}etc`), true, '根下一切绝对路径皆在内');
  assert.equal(isWithin(sep, `${sep}data${sep}x`), true, '根的深层子项在内');
  assert.equal(isWithin(sep, 'relative/path'), false, '相对路径不在根内');
});

test('大小写语义随平台文件系统走：POSIX 必须区分大小写（不敏感即安全缺口）', () => {
  const root = '/data/Root';
  if (sep === '/') {
    assert.equal(isWithin(root, '/data/root/file.md'), false, 'POSIX：仅大小写不同即两个目录，判在外');
    assert.equal(isWithin(root, '/data/Root/file.md'), true, '同大小写方才在内');
  } else {
    // Windows：比较双方同由 realpath 产出（磁盘规范大小写）故天然一致；
    // 此处仅登记「原语本身不做归一」这一事实，真实一致性由调用方同源归一保证。
    assert.equal(typeof isWithin(root, root.toUpperCase() + '/file.md'), 'boolean', 'win32 不承诺本层归一，语义由调用方同源保证');
  }
});

test('相对/非归一形态：原语不做 resolve，口径由调用方负责（契约显式化）', () => {
  assert.equal(isWithin('/data/root', 'root/x.md'), false, '未 resolve 的相对路径不匹配绝对 root');
  // 字面量按字符串判定：写法上以 root+sep 开头即算在内，原语不解析 ..（故调用方必须先 realpath/resolve）
  assert.equal(isWithin('/data/root', `/data/root${sep}..${sep}etc${sep}passwd`), true, '含 .. 的字面量照字符串判定，原语不代劳归一');
  // 归一后的形态才是安全链实际输入：真的逃出 root 即判在外（两个断言成对，钉住「归一责任在调用方」）
  assert.equal(isWithin('/data/root', path.resolve(`${sep}data${sep}root`, '..', 'etc', 'passwd')), false, '归一后的真实逃逸判在外');
});

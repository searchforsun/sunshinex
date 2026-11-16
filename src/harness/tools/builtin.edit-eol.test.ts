import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SafetyChain } from '../security/chain';
import { ProcessSandbox } from '../security/sandbox';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { builtinTools } from './builtin';
import { createReadGuard } from './read-guard';

/** edit 行尾自适应匹配(2026-11-14 使用者 issue:autocrlf=true 工作树文件 CRLF、模型串 LF,
 *  字面匹配必然失配且重读无解):LF 文件零行为变化 / CRLF 命中且行尾保持 / 混合行尾逐行保真 /
 *  归一后多义按 replaceAll 规则 / 字面与归一双失配照常报错 */

function makeTools(root: string) {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), root);
  return builtinTools(safety, root, { readGuard: createReadGuard() });
}

async function editOf(root: string) {
  const tools = makeTools(root);
  const read = tools.find((t) => t.name === 'read')!;
  const edit = tools.find((t) => t.name === 'edit')!;
  return { read, edit };
}

test('edit CRLF 工作树:模型 LF 多行串命中且文件行尾保持 CRLF', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-edit-crlf-'));
  try {
    const file = path.join(root, 'App.java');
    fs.writeFileSync(file, 'public class App {\r\n    void a() {\r\n        int x = 1;\r\n    }\r\n}\r\n');
    const { read, edit } = await editOf(root);
    await read.executor({ path: 'App.java' }); // 先读守卫
    const r = await edit.executor({ path: 'App.java', oldString: 'void a() {\n        int x = 1;\n    }', newString: 'void a() {\n        int x = 2;\n    }' });
    assert.ok(r);
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.includes('int x = 2;'), '替换生效');
    assert.ok(after.includes('\r\n'), '文件行尾保持 CRLF');
    assert.ok(!after.replace(/\r\n/g, '').includes('\n'), '无裸 LF(行尾无混杂)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('edit LF 文件:多行字面匹配行为零变化(恒等归一)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-edit-lf-'));
  try {
    const file = path.join(root, 'a.ts');
    fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\n');
    const { read, edit } = await editOf(root);
    await read.executor({ path: 'a.ts' });
    await edit.executor({ path: 'a.ts', oldString: 'const a = 1;', newString: 'const a = 3;' });
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, 'const a = 3;\nconst b = 2;\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('edit 混合行尾:命中区外字节不动,插入段随区间行尾', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-edit-mixed-'));
  try {
    const file = path.join(root, 'mixed.txt');
    fs.writeFileSync(file, 'line1\nline2\r\nline3\r\nline4\n');
    const { read, edit } = await editOf(root);
    await read.executor({ path: 'mixed.txt' });
    // old_string 跨 line2/line3(CRLF 区),插入两行新内容 → 插入段随区间用 CRLF;line1/line4 的 LF 不动
    await edit.executor({ path: 'mixed.txt', oldString: 'line2\nline3', newString: 'line2x\nline3x' });
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, 'line1\nline2x\r\nline3x\r\nline4\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('edit 归一后多义:无 replaceAll 报多命中,replaceAll 全换且行尾保持', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-edit-multi-'));
  try {
    const file = path.join(root, 'm.txt');
    fs.writeFileSync(file, 'x\r\ny\r\nx\r\ny\r\n');
    const { read, edit } = await editOf(root);
    await read.executor({ path: 'm.txt' });
    await assert.rejects(
      edit.executor({ path: 'm.txt', oldString: 'x\r\ny', newString: 'z' }),
      /matches 2 locations/,
    );
    await edit.executor({ path: 'm.txt', oldString: 'x\ny', newString: 'z', replaceAll: true });
    assert.equal(fs.readFileSync(file, 'utf8'), 'z\r\nz\r\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('edit 字面与归一双失配:照常 INVALID_ARG(不误报成功)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-edit-miss-'));
  try {
    const file = path.join(root, 'f.txt');
    fs.writeFileSync(file, 'hello\r\nworld\r\n');
    const { read, edit } = await editOf(root);
    await read.executor({ path: 'f.txt' });
    await assert.rejects(
      edit.executor({ path: 'f.txt', oldString: 'nope\nnever', newString: 'z' }),
      /old_string not found/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('edit 未先读:NOT_READ 硬闸先行(行尾自适应不绕过守卫)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-edit-guard-'));
  try {
    const file = path.join(root, 'g.txt');
    fs.writeFileSync(file, 'a\r\nb\r\n');
    const { edit } = await editOf(root);
    await assert.rejects(
      edit.executor({ path: 'g.txt', oldString: 'a\nb', newString: 'c' }),
      /NOT_READ|not been read/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

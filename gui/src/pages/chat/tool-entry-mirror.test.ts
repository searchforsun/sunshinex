import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PURPOSE_SERVERS } from './tool-entry-data';

/** 跨包对拍钉（2026-11-07 增量审计，D55 镜像先例）：GUI 侧宿主插件名单 ↔ 宿主单点 HOSTED 键。
 *  purpose 判别的 server 知识两侧各存一份（GUI 不引 harness 源），漂移即红——新增宿主插件须两侧同步。 */
describe('purpose 宿主名单对拍', () => {
  test('PURPOSE_SERVERS = src/harness/plugin-host HOSTED 键', () => {
    // cwd=vitest 启动目录(gui)——jsdom 环境 import.meta.url 非 file scheme,走 cwd 相对定位
    const src = readFileSync(resolve(process.cwd(), '../src/harness/plugin-host.ts'), 'utf8');
    const m = /const HOSTED[\s\S]*?= \{([\s\S]*?)\n\};/.exec(src);
    expect(m, 'plugin-host HOSTED 表形态变化时本钉须同步').not.toBeNull();
    const body = m![1];
    const lit = [...body.matchAll(/^\s*'([^']+)':/gm)].map((x) => x[1]);
    // 动态键(BROWSER_SERVER_NAME 等导出常量)取其同文件字面量赋值
    const dynVals = [...body.matchAll(/^\s*\[([A-Za-z_][A-Za-z0-9_]*)\]:/gm)].map((x) => {
      const d = new RegExp(`const ${x[1]} = '([^']+)'`).exec(src);
      expect(d, `HOSTED 动态键 ${x[1]} 的字面量须可在同文件解析`).not.toBeNull();
      return d![1];
    });
    const keys = [...lit, ...dynVals];
    expect(keys.length, 'HOSTED 键解析非空').toBeGreaterThan(0);
    expect([...PURPOSE_SERVERS].sort()).toEqual(keys.sort());
  });
});

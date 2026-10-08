import { describe, expect, it } from 'vitest';
import { parseSmokeArgv } from './smoke';

describe('parseSmokeArgv', () => {
  it('含旗标 --shell-smoke → true（单独出现或混在参数中间）', () => {
    expect(parseSmokeArgv(['--shell-smoke'])).toEqual({ smoke: true });
    expect(parseSmokeArgv(['--foo', '--shell-smoke', 'bar'])).toEqual({
      smoke: true,
    });
  });

  it('不含旗标 → false（空数组/普通参数）', () => {
    expect(parseSmokeArgv([])).toEqual({ smoke: false });
    expect(parseSmokeArgv(['--foo', 'bar'])).toEqual({ smoke: false });
  });

  it('近似旗标不算命中：精确匹配，--shell-smoke=x 与 --smoke 均为 false', () => {
    expect(parseSmokeArgv(['--shell-smoke=1'])).toEqual({ smoke: false });
    expect(parseSmokeArgv(['--shell-smoke='])).toEqual({ smoke: false });
    expect(parseSmokeArgv(['--smoke'])).toEqual({ smoke: false });
    expect(parseSmokeArgv(['shell-smoke'])).toEqual({ smoke: false });
  });
});

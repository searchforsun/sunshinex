import { describe, it, expect } from 'vitest';
import { atomicRange, tokenDeleteRange, tokenGuardVerdict, tokenSpanAt } from './pages/Chat';

// G14.212 token 原子性纯函数:atomicRange(区间扩整)/tokenGuardVerdict(beforeinput 判定)/
// tokenDeleteRange(整删区间)。样本:文件 token + 命令 token + 带行锚的全路径 token。
const TEXT = '@app.css /memory @gui/src/connection.ts:L25-L29';
// 区间: '@app.css'=[0,8) ' '=[8,9) '/memory'=[9,16) ' '=[16,17) '@gui/...:L25-L29'=[17,47)

describe('atomicRange G14.212 token 原子区间', () => {
  it('token 内部光标 → 扩为整 token', () => {
    expect(atomicRange(TEXT, 3, 3)).toEqual([0, 8]);
  });
  it('部分选中(token 一段)→ 扩整', () => {
    expect(atomicRange(TEXT, 2, 5)).toEqual([0, 8]);
  });
  it('整段覆盖(token 全在区间内)→ 放行(有意整替)', () => {
    expect(atomicRange(TEXT, 0, 8)).toEqual([0, 8]);
  });
  it('区间含 token 外延 → 覆盖成立,放行', () => {
    expect(atomicRange(TEXT, 0, 9)).toEqual([0, 9]);
  });
  it('跨 token 部分命中 → 扩为并集', () => {
    expect(atomicRange(TEXT, 5, 12)).toEqual([0, 16]);
  });
  it('token 尾边界光标 → 放行(:L 行锚续写落点)', () => {
    expect(atomicRange(TEXT, 8, 8)).toEqual([8, 8]);
  });
  it('明文区 → 放行', () => {
    expect(atomicRange(TEXT, 8, 9)).toEqual([8, 9]);
  });
});

describe('tokenGuardVerdict G14.212 beforeinput 判定', () => {
  it('insertText 部分命中 → redirectEnd 到 token 尾', () => {
    expect(tokenGuardVerdict('@app.css x', 3, 3, 'insertText')).toEqual({ action: 'redirectEnd', to: 8 });
  });
  it('IME insertCompositionText 部分命中 → redirectEnd', () => {
    expect(tokenGuardVerdict('@app.css x', 4, 4, 'insertCompositionText')).toEqual({ action: 'redirectEnd', to: 8 });
  });
  it('insertText 整段覆盖 → allow(有意整替)', () => {
    expect(tokenGuardVerdict('@app.css x', 0, 8, 'insertText')).toEqual({ action: 'allow' });
  });
  it('insertText 边界 → allow', () => {
    expect(tokenGuardVerdict('@app.css x', 8, 8, 'insertText')).toEqual({ action: 'allow' });
  });
  it('deleteContentBackward 部分命中 → splice 整删', () => {
    expect(tokenGuardVerdict('@app.css x', 3, 3, 'deleteContentBackward')).toEqual({ action: 'splice', s: 0, e: 8 });
  });
  it('deleteByCut 部分选中 → splice 整删', () => {
    expect(tokenGuardVerdict('@app.css x', 2, 6, 'deleteByCut')).toEqual({ action: 'splice', s: 0, e: 8 });
  });
  it('无关 inputType → allow', () => {
    expect(tokenGuardVerdict('@app.css x', 3, 3, 'historyUndo')).toEqual({ action: 'allow' });
  });
});

describe('tokenSpanAt G14.213 光标不落中间', () => {
  it('token 内部 → 返回整 span', () => {
    expect(tokenSpanAt('@app.css x', 3)).toEqual([0, 8]);
  });
  it('首尾边界 → null(边界可停)', () => {
    expect(tokenSpanAt('@app.css x', 0)).toBeNull();
    expect(tokenSpanAt('@app.css x', 8)).toBeNull();
  });
  it('明文区 → null', () => {
    expect(tokenSpanAt('@app.css x', 9)).toBeNull();
  });
  it('带行锚 token 内部 → 整 span', () => {
    expect(tokenSpanAt('@gui/a.ts:L3-L5 x', 12)).toEqual([0, 15]);
  });
});

describe('tokenDeleteRange G14.156 整删区间(原子性删除面)', () => {
  it('token 内 Backspace → 整删区间', () => {
    expect(tokenDeleteRange('@app.css x', 5, 'Backspace')).toEqual([0, 8]);
  });
  it('token 尾 Backspace → 整删区间', () => {
    expect(tokenDeleteRange('@app.css x', 8, 'Backspace')).toEqual([0, 8]);
  });
  it('token 首 Delete → 整删区间', () => {
    expect(tokenDeleteRange('@app.css x', 0, 'Delete')).toEqual([0, 8]);
  });
  it('明文区 → null(逐字符)', () => {
    expect(tokenDeleteRange('@app.css x', 9, 'Backspace')).toBeNull();
  });
});

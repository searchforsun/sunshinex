import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { CharterDialog } from './CharterDialog';
import type { CharterConn } from './CharterDialog';

/**
 * 品性编辑弹窗(sunx P2 Task 7):打开拉当前品性预填(GET /session/:id/charter 读面)→
 * textarea 编辑→保存 editCharter(POST /session/:id/charter 全文替换)→成功提示新 rev
 * (行内小字)→自动关闭;装载失败(409/404 等)静默禁保存;提交中 busy 锁+三关闭路径拒关
 * (NewSunxDialog 同款弹层惯例:portal/ESC/点外/✕)。
 */

/** 双语容忍正解(D37 家族,NewSunxDialog.test 同款):产品面 t() 化后,测试环境钉 en,单语钉必脆 */
const bi = (en: string, zh: string): RegExp =>
  new RegExp(`^(?:${[en, zh].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

type GetFn = CharterConn['sessionCharter'];
type EditFn = CharterConn['editCharter'];
function makeConn(
  getImpl?: GetFn,
  editImpl?: EditFn,
): CharterConn & { sessionCharter: ReturnType<typeof vi.fn<GetFn>>; editCharter: ReturnType<typeof vi.fn<EditFn>> } {
  return {
    sessionCharter: getImpl !== undefined ? vi.fn(getImpl) : vi.fn(async (..._: Parameters<GetFn>) => ({ text: 'BIRTH CHARTER', charterRev: 1 })),
    editCharter: editImpl !== undefined ? vi.fn(editImpl) : vi.fn(async (..._: Parameters<EditFn>) => ({ ok: true as const, charterRev: 2 })),
  };
}

/** 受控开合宿主:open 态内持,onClose 翻 false(母体裁定 open prop + onClose) */
function Harness(props: { conn: CharterConn; sessionId?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <CharterDialog
      open={open}
      onClose={() => setOpen(false)}
      conn={props.conn}
      sessionId={props.sessionId ?? 's-sunx-1'}
    />
  );
}

describe('CharterDialog(品性编辑弹窗)', () => {
  it('受控开合:open=false 零渲染;open=true 打开即拉当前品性预填(GET 载荷=sessionId)', async () => {
    const conn = makeConn();
    const closed = render(<CharterDialog open={false} onClose={() => {}} conn={conn} sessionId="s1" />);
    expect(screen.queryByRole('dialog', { name: bi('Edit charter', '编辑品性') })).toBeNull();
    closed.unmount();
    render(<Harness conn={conn} sessionId="s-sunx-9" />);
    expect(screen.getByRole('dialog', { name: bi('Edit charter', '编辑品性') })).toBeDefined();
    await waitFor(() => expect(conn.sessionCharter).toHaveBeenCalledWith('s-sunx-9'));
    await waitFor(() =>
      expect((screen.getByLabelText(bi('Charter', '品性')) as HTMLTextAreaElement).value).toBe('BIRTH CHARTER'),
    );
  });

  it('保存载荷:编辑后 editCharter(id, 改后全文);成功提示新 rev(行内小字)后自动关弹窗', async () => {
    vi.useFakeTimers(); // 成功提示停留为真实定时面——假钟推进,断言确定性(不睡真实 1.4s)
    try {
      const conn = makeConn();
      render(<Harness conn={conn} />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); }); // 预填沉降
      const area = screen.getByLabelText(bi('Charter', '品性')) as HTMLTextAreaElement;
      expect(area.value).toBe('BIRTH CHARTER');
      fireEvent.change(area, { target: { value: 'REPLACED CHARTER TEXT' } });
      fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(conn.editCharter).toHaveBeenCalledWith('s-sunx-1', 'REPLACED CHARTER TEXT');
      // 成功提示新 rev(行内小字,role=status)
      expect(screen.getByRole('status').textContent).toMatch(/2/);
      // 停留一拍后自动关闭
      act(() => { vi.advanceTimersByTime(1500); });
      expect(screen.queryByRole('dialog', { name: bi('Edit charter', '编辑品性') })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('装载失败(409/404 等)静默禁保存:零 alert、textarea 空,保存钮 disabled', async () => {
    const conn = makeConn(() => Promise.reject(new Error('/session/x/charter -> 409')));
    render(<Harness conn={conn} />);
    await waitFor(() => expect(conn.sessionCharter).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0)); // 拒绝沉降
    expect(screen.queryByRole('alert')).toBeNull(); // 静默
    expect((screen.getByLabelText(bi('Charter', '品性')) as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByRole('button', { name: bi('Save', '保存') }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(bi('Charter', '品性')) as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('空白文本禁保存(替换语义=全文替换,空 400 面:钮 disabled);失败示错(alert)停留可改再提交', async () => {
    const conn = makeConn(undefined, () => Promise.reject(new Error('/session/x/charter -> 500')));
    render(<Harness conn={conn} />);
    const area = await waitFor(() => {
      const el = screen.getByLabelText(bi('Charter', '品性')) as HTMLTextAreaElement;
      expect(el.value).toBe('BIRTH CHARTER');
      return el;
    });
    fireEvent.change(area, { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: bi('Save', '保存') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(area, { target: { value: 'OK TEXT' } });
    expect((screen.getByRole('button', { name: bi('Save', '保存') }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('dialog', { name: bi('Edit charter', '编辑品性') })).toBeDefined(); // 停留
  });

  it('busy 锁:保存在途钮 disabled+再点不双发;三条关闭路径拒关(ESC/点外/✕ disabled);resolve 后提示+关', async () => {
    vi.useFakeTimers(); // 同上:成功提示停留假钟推进
    let release: ((v: { ok: true; charterRev: number }) => void) | null = null;
    const conn = makeConn(
      undefined,
      () =>
        new Promise<{ ok: true; charterRev: number }>((resolve) => {
          release = resolve;
        }),
    );
    try {
      render(<Harness conn={conn} />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); }); // 预填沉降
      const area = screen.getByLabelText(bi('Charter', '品性')) as HTMLTextAreaElement;
      expect(area.value).toBe('BIRTH CHARTER');
      fireEvent.change(area, { target: { value: 'IN FLIGHT TEXT' } });
      const save = screen.getByRole('button', { name: bi('Save', '保存') }) as HTMLButtonElement;
      fireEvent.click(save);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); }); // busy 态沉降
      expect(save.disabled).toBe(true);
      fireEvent.click(save); // 在途再点
      expect(conn.editCharter).toHaveBeenCalledTimes(1); // 不双发
      // busy 中 ESC / 点外(遮罩) / ✕(disabled):一律拒关
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(document.querySelector('.modal-overlay')!);
      expect((screen.getByRole('button', { name: 'close charter dialog' }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'close charter dialog' }));
      expect(screen.getByRole('dialog', { name: bi('Edit charter', '编辑品性') })).toBeDefined();
      await act(async () => {
        release!({ ok: true, charterRev: 3 });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole('status').textContent).toMatch(/3/);
      act(() => { vi.advanceTimersByTime(1500); });
      expect(screen.queryByRole('dialog', { name: bi('Edit charter', '编辑品性') })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ESC 关;点外(遮罩)关(空闲态即关,无草稿保留语义——重开即重拉预填)', () => {
    const conn = makeConn();
    const { unmount } = render(<Harness conn={conn} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: bi('Edit charter', '编辑品性') })).toBeNull();
    unmount();
    render(<Harness conn={conn} />);
    fireEvent.click(document.querySelector('.modal-overlay')!);
    expect(screen.queryByRole('dialog', { name: bi('Edit charter', '编辑品性') })).toBeNull();
  });
});

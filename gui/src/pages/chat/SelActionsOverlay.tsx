import { useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import { t } from '../../i18n';

/**
 * 正文圈选悬浮动作条(2026-11-04 用户裁定「主对话正文与子智能体正文圈选后显示 添加到主对话/
 * 辅助对话」):容器内文本选区非空即浮出(fixed 锚选区矩形上方),双动作:
 * - 添加到当前任务:选中文本(截 2000 字)经全局 insert-ref 事件落主对话 composer——
 *   跨页签可达(子智能体转录页圈选也能送主对话);
 * - 辅助会话提问:onSideAsk 注入通道(宿主注入,缺席不渲染该钮)。
 * 显隐:mouseup 读选区(锚点须在容器内)/容器滚动即隐;Esc 显式关闭。条上 mousedown 保选区。
 */
export function SelActionsOverlay(props: {
  readonly containerRef: MutableRefObject<HTMLElement | null>;
  readonly enabled?: boolean;
  readonly onInsert: (text: string) => void;
  readonly onSideAsk?: (text: string) => void;
}): JSX.Element | null {
  const { containerRef, enabled = true, onInsert, onSideAsk } = props;
  const [sel, setSel] = useState<{ top: number; left: number; text: string } | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (enabled === false || el === null) {
      setSel(null);
      return;
    }
    const read = (): void => {
      const s = window.getSelection();
      const text = s?.toString() ?? '';
      if (s === null || s.isCollapsed || text.trim() === '') {
        setSel(null);
        return;
      }
      // 选区锚点须在本容器(其他面/输入框的圈选不接管)
      if (s.anchorNode === null || !el.contains(s.anchorNode)) {
        setSel(null);
        return;
      }
      const rect = s.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSel(null);
        return;
      }
      setSel({
        top: Math.max(8, rect.top - 40),
        left: Math.max(8, rect.left),
        text: text.trim().slice(0, 2000),
      });
    };
    const onMouseUp = (): void => { window.setTimeout(read, 0); };
    const onHide = (): void => setSel(null);
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSel(null);
    };
    el.addEventListener('mouseup', onMouseUp);
    el.addEventListener('scroll', onHide, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('mouseup', onMouseUp);
      el.removeEventListener('scroll', onHide);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled, containerRef]);
  if (sel === null) return null;
  return (
    <div
      className="files-selbar sel-actions-float"
      style={{ position: 'fixed', top: sel.top, left: sel.left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onClick={() => {
          onInsert(sel.text);
          setSel(null);
        }}
      >
        {t('Add to main chat', '添加到主对话')}
      </button>
      {onSideAsk !== undefined && (
        <button
          type="button"
          onClick={() => {
            onSideAsk(sel.text);
            setSel(null);
          }}
        >
          {t('Ask in side chat', '辅助会话提问')}
        </button>
      )}
    </div>
  );
}

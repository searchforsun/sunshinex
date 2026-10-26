import { useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import { t } from '../../i18n';
import type { ChatEntry } from '../../chat-reducer';

/**
 * 对话刻度导航条(2026-10-26 用户需求):主对话左侧一枚轮刻度——每个用户气泡一枚刻度,
 * hover 刻度伸长并滑出气泡文本预览(过长截断),点击滚动到对应气泡。刻度列表垂直居中、
 * 占流区高度 80%,超出即条内滚动。**显隐门=余量自适应**:仅当主对话两侧余量能完整放下
 * 刻度条时才显示(流区限宽由对称 padding 承担,余量=paddingLeft-基础 18px,RO 实测)。
 * 贴地实现:sticky+height 0 悬浮于滚动容器内,不参与内容流;pointer-events 只在刻度上。
 */

/** 气泡文本 → 刻度预览:剥 markdown 痕迹(引用前缀/链接/强调符),首行,限 90 字(CSS 省略兜底) */
function tickLabel(md: string): string {
  const flat = md
    .replace(/^>\s?/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图]')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*`_~]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')[0] ?? '';
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

export function ChatRail(props: {
  /** 可见窗内的条目(与 DOM 渲染集一致——点击按序反查 .entry-user) */
  readonly entries: readonly ChatEntry[];
  readonly chatScrollRef: MutableRefObject<HTMLElement | null>;
  readonly sideChat?: boolean;
}): JSX.Element {
  const { entries, chatScrollRef, sideChat } = props;
  const [gutterOk, setGutterOk] = useState(false);
  // 余量实测:流区限宽=对称 padding(>18px 段即余量),余量 ≥ 64px(刻度 44+呼吸)才显示
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const pad = Number.parseFloat(getComputedStyle(el).paddingLeft);
      setGutterOk(Number.isFinite(pad) && pad - 18 >= 64);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [chatScrollRef]);

  const users = entries.filter((e) => e.kind === 'user' && e.md.trim() !== '');
  // 空会话/辅助对话/单条/余量不足:一律不渲染(挂都不挂,零布局参与)
  if (sideChat === true || !gutterOk || users.length < 2) return <></>;

  const jump = (index: number): void => {
    const el = chatScrollRef.current;
    if (el === null) return;
    const nodes = el.querySelectorAll('.entry-user');
    const node = nodes[index];
    if (node !== undefined) {
      node.scrollIntoView({ block: 'start', behavior: 'smooth' });
      // 落点高亮闪示(边界定位反馈):一次性 class,动画完自愈
      node.classList.add('sx-rail-flash');
      window.setTimeout(() => node.classList.remove('sx-rail-flash'), 1_200);
    }
  };

  return (
    <div className="sx-rail" aria-hidden="true">
      <div className="sx-rail-inner" role="navigation" aria-label={t('Conversation outline', '会话刻度导航')}>
        <div className="sx-rail-list">
        {users.map((u, i) => (
          <button
            key={u.key}
            type="button"
            className="sx-rail-tick"
            data-tip={tickLabel(u.md)}
            onClick={() => jump(i)}
          >
            <span className="sx-rail-bar" />
          </button>
        ))}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import { t } from '../../i18n';
import type { ChatEntry } from '../../chat-reducer';

/**
 * 对话刻度导航条(2026-10-26 用户需求):主对话左侧一枚轮刻度——每个用户气泡一枚刻度,
 * hover 刻度伸长并滑出气泡文本预览(过长截断),点击滚动到对应气泡。刻度列表垂直居中、
 * 占流区高度 80%,超出即条内滚动。**余量充足=常规态(缩进 10px);余量不足=tight 紧凑态**
 * (缩进收到 3px,刻度落进 18px 内边距带,hover 突出关闭)——恒显示不隐藏(五轮裁定)。
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
  // 余量实测:流区限宽=对称 padding(>18px 段即余量)。2026-10-26 五轮裁定:余量不足不再隐藏——
  // 用户主用窗口(DPI 150% 缩放,CSS 宽 ~1170)内容列占满零余量,按旧门控刻度条永久消失被当坏了
  // (CDP 实测桌面现场 chatWidth 836/padding 18)。改紧凑模式(tight):inner 右缩进收到 3px,
  // 刻度整条落进 18px 内边距带,hover 突出关闭——任何宽度都有刻度条
  const [tight, setTight] = useState(false);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const pad = Number.parseFloat(getComputedStyle(el).paddingLeft);
      setTight(!(Number.isFinite(pad) && pad - 18 >= 44));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [chatScrollRef]);

  const users = entries.filter((e) => e.kind === 'user' && e.md.trim() !== '');
  // 空会话/辅助对话:不渲染(挂都不挂,零布局参与);余量走 tight 紧凑态不再隐藏(五轮裁定)
  if (sideChat === true || users.length === 0) return <></>;

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
      <div className={`sx-rail-inner${tight ? ' tight' : ''}`} role="navigation" aria-label={t('Conversation outline', '会话刻度导航')}>
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

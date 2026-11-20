import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { t } from './i18n';

/**
 * 搜索面统一件(2026-11-21 用户裁定「各个类型的所有搜索框下边可以置顶分类,搜索出来内容
 *  可以进行合理跳转」):分类条=搜索框下常驻;分组头在结果滚动面内吸顶;键盘 ↑↓/Home/End
 *  移动、Enter 直达目标。侧栏聚合搜索/标签页搜索/目录树搜索三面同源,行为不再各写一套。
 */

/** 分类条单项(count 缺省=计数未就绪,如会话清单仍在拉取) */
export interface SearchCatDef {
  readonly id: string;
  readonly en: string;
  readonly zh: string;
  readonly count?: number;
}

/** 分类条:位于搜索框下方、结果滚动区之外——列表滚到底也恒在 */
export function SearchCatBar(props: {
  readonly cats: readonly SearchCatDef[];
  readonly active: string;
  readonly onPick: (id: string) => void;
}): JSX.Element {
  return (
    <div className="sx-search-cats" role="tablist" aria-label={t('Search categories', '搜索分类')}>
      {props.cats.map((c) => {
        const on = c.id === props.active;
        return (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={on}
            className={`sx-search-cat${on ? ' active' : ''}`}
            onClick={() => props.onPick(c.id)}
          >
            <span>{t(c.en, c.zh)}</span>
            {c.count !== undefined && <span className="sx-search-cat-count">{c.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** 置顶分组头:结果分组标题在滚动面内吸顶(sticky),右侧落条数 */
export function SearchSectionHead(props: { readonly label: string; readonly count: number }): JSX.Element {
  return (
    <div className="sx-search-sec" role="presentation">
      <span>{props.label}</span>
      <span className="sx-search-sec-count">{props.count}</span>
    </div>
  );
}

export interface SearchListNav<T extends HTMLElement> {
  /** 键盘选中下标(0 起;列表空时恒 0) */
  readonly active: number;
  readonly setActive: (index: number) => void;
  /** 挂到选中行:active 变化即滚入可视区(block:nearest,最小滚动) */
  readonly activeRef: RefObject<T | null>;
  /** 挂搜索输入框:↑↓/Home/End 移动,Enter 选中当前行 */
  readonly onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
}

/**
 * 键盘跳转单点:列表 = 当前可见结果(已分类/过滤),Enter 由宿主 onPick 决定落点。
 * resetKey(查询词+分类)变化即回第一行;结果变少时下标收敛到末行,不悬空。
 */
export function useSearchListNav<T extends HTMLElement = HTMLButtonElement>(opts: {
  readonly count: number;
  readonly onPick: (index: number) => void;
  readonly resetKey?: string;
}): SearchListNav<T> {
  const { count, onPick } = opts;
  const resetKey = opts.resetKey ?? '';
  const [active, setActive] = useState(0);
  const activeRef = useRef<T | null>(null);

  useEffect(() => {
    setActive(0);
  }, [resetKey]);

  useEffect(() => {
    setActive((a) => (count === 0 ? 0 : Math.min(a, count - 1)));
  }, [count]);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (count === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(count - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(count - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onPick(Math.min(active, count - 1));
    }
  };

  return { active, setActive, activeRef, onKeyDown };
}

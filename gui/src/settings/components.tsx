import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { SourceBadge } from './SourceBadge';
import type { SourceBadgeProps } from './SourceBadge';
import { Select } from './controls';

/**
 * Task 21 设置共享组件 kit(Phase F 六面板改版的统一消费面,T22-27 逐页verbatim消费):
 * - ScopeSelect:全局/项目作用域下拉(共享 Select 弹层控件)——资源页工具栏内联作用域选择面
 *   (2026-10-29 用户裁定:工具栏三件套入页,壳顶分段控件撤除,scope 状态仍留壳层统一下发);
 *   项目不可用时整机 disabled+提示(沿现禁用文案)。
 * - SearchBar:受控输入+内置 200ms 防抖(契约见 SearchBarProps 注)——列表过滤统一入口。
 * - ResourceCard:资源卡(icon/标题/副题/来源徽标/chips/开关/actions)——结构沿 sx-mcp-card
 *   现行卡片语言(surface-elevated 面+border 圆角+头部行),开关复用 .sx-mcp-switch 令牌;
 *   children=折叠详情(<details>,summary「Details/详情」)。
 * - EditorModal:居中模态编辑对话框(遮罩+居中;Cancel/右上 ×/Esc/遮罩点击=onClose,Save=
 *   onSubmit)——raw/JSON 类编辑面统一容器(2026-10-29 用户裁定:弹窗替换右滑抽屉;Esc 走
 *   document 捕获段并 stopPropagation——设置壳「Esc 回会话态」监听在 document 冒泡段,弹窗
 *   开着时 Esc 只关弹窗不退设置态;焦点落对话框,不做完整焦点陷阱)。
 * - EmptyState/ErrorBanner:空态/错误条(role=alert,沿 home-error 的告警语义)。
 * 样式零新依赖:全部走 app.css 既有令牌(--surface-elevated/--border/--radius 系列/--warn…),
 * 新类前缀 sx-scope-/sx-search-/sx-rc-/sx-drawer-/sx-empty-/sx-error-(Task 21 追加段)+
 * sx-editor-modal-/sx-res-toolbar(2026-10-29 追加段;旧 sx-drawer-* 容器类留置不删——app.css
 * 并行热区只加不改)。
 * 字符串一律渲染期 t(en,zh)(G14.213 设置面 i18n 纪律)。
 */

/** 设置作用域(与 src/catalog/types 的 Scope 同形——gui 侧自持别名,面板 props 统一此名) */
export type SettingsScope = 'global' | 'project';

/** ScopeSelect props:scope 受控;projectAvailable=false 时整机禁用(无项目上下文,沿禁用提示) */
export interface ScopeSelectProps {
  readonly scope: SettingsScope;
  readonly projectAvailable: boolean;
  readonly onScopeChange: (scope: SettingsScope) => void;
}

/** 全局/项目作用域下拉(2026-10-29 用户裁定:分段控件改下拉、入各资源页工具栏):
 *  沿共享 Select 弹层控件(sx-dd 同款样式);选项「具体项目」(project)/「全局」(global);
 *  projectAvailable=false → 整机 disabled+data-tip 提示(此态壳层恒已强制 global,禁用即
 *  项目侧不可选,全局当值照显) */
export function ScopeSelect({ scope, projectAvailable, onScopeChange }: ScopeSelectProps): JSX.Element {
  return (
    <Select
      ariaLabel={t('Settings scope', '配置作用域')}
      value={scope}
      disabled={!projectAvailable}
      title={projectAvailable ? undefined : t('No project open — global only', '未打开项目——仅全局')}
      options={[
        { v: 'project', l: t('This project', '具体项目') },
        { v: 'global', l: t('Global', '全局') },
      ]}
      onChange={(v) => onScopeChange(v as SettingsScope)}
    />
  );
}

/** SearchBar 防抖窗(毫秒)——键入停顿 200ms 才上抛 onChange */
export const SEARCH_DEBOUNCE_MS = 200;

/** SearchBar props(防抖契约):受控 value 是过滤真值源;键入即时回显输入框,onChange 防抖
 *  200ms(自最后一次键起算,窗内连击合并单次终值);value 外部变更(资源切换清空等)即时镜像
 *  回输入框并撤销在途未抛窗。消费方零再防抖 */
export interface SearchBarProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly onChange: (v: string) => void;
}

/** 受控防抖搜索框(列表过滤统一入口):input 沿 .sx-setting-input 令牌 */
export function SearchBar({ value, placeholder, onChange }: SearchBarProps): JSX.Element {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** onChange 经 ref 直通(effect 依赖面只留 value——回调身份变化不重挂镜像面) */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    setText(value);
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <input
      type="text"
      className="sx-setting-input sx-search-bar"
      aria-label={t('Search', '搜索')}
      placeholder={placeholder}
      value={text}
      autoComplete="off"
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          onChangeRef.current(next);
        }, SEARCH_DEBOUNCE_MS);
      }}
    />
  );
}

/** ResourceCard props:icon 任意节点(aria-hidden 装饰位);subtitle 副题行;chips 任意 chips 行
 *  (sx-chip 令牌);badge=SourceBadgeProps 直通;enabled+onToggle 同在才渲染开关(role=switch,
 *  aria-label=`Enable {title}`——沿 McpPane 惯例,enabled 缺省 true);actions=卡尾操作钮行;
 *  children=折叠详情(<details> 缺省收起,summary「Details」)。根元素 <li>——置于
 *  ul.sx-rc-list(或既有 sx-mcp-list 语言)列表内消费 */
export interface ResourceCardProps {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly subtitle?: string;
  readonly chips?: ReactNode;
  readonly badge?: SourceBadgeProps;
  readonly enabled?: boolean;
  readonly onToggle?: () => void;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}

/** 资源卡统一骨架(六面板改版共用):头部行(icon/标题/副题/徽标/开关)+chips 行+actions 行+
 *  折叠详情。开关复用 .sx-mcp-switch 令牌(on=--ok 绿) */
export function ResourceCard({ icon, title, subtitle, chips, badge, enabled, onToggle, actions, children }: ResourceCardProps): JSX.Element {
  const on = enabled !== false;
  return (
    <li className="sx-rc">
      <div className="sx-rc-head">
        {icon !== undefined && (
          <span className="sx-rc-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="sx-rc-title">{title}</span>
        {subtitle !== undefined && <span className="sx-rc-subtitle">{subtitle}</span>}
        {badge !== undefined && <SourceBadge {...badge} />}
        {onToggle !== undefined && (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={`${t('Enable', '启用')} ${title}`}
            className={`sx-mcp-switch${on ? ' on' : ''}`}
            onClick={onToggle}
          >
            <span className="knob" aria-hidden="true" />
          </button>
        )}
      </div>
      {chips !== undefined && <div className="sx-rc-chips">{chips}</div>}
      {actions !== undefined && <div className="sx-card-actions">{actions}</div>}
      {children !== undefined && (
        <details className="sx-rc-details">
          <summary>{t('Details', '详情')}</summary>
          {children}
        </details>
      )}
    </li>
  );
}

/** EditorModal props:open=false 恒 null;onClose=遮罩点击/Cancel/×/Esc 统一闭面;onSubmit=Save
 *  (form submit 路径,preventDefault 由本件承担);children=弹窗体字段面 */
export interface EditorModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly children?: ReactNode;
}

/** 居中模态编辑对话框(2026-10-29 用户裁定:弹窗替换右滑抽屉;raw/JSON 编辑统一容器):
 *  fixed 遮罩(z 120)+居中对话框(role=dialog aria-modal,宽 min(90vw,640px)/高 80vh 内滚动,
 *  体头 ×、Save/Cancel 尾栏);体内点击 stopPropagation 不冒遮罩;Esc=document 捕获段监听
 *  (stopPropagation 截断壳层 document 冒泡段「Esc 回会话态」——弹窗开着时 Esc 只关弹窗);
 *  焦点落对话框(open 挂载 ref.focus——React autoFocus 仅表单元素生效,div 走 ref;简单落焦,
 *  不做完整焦点陷阱) */
export function EditorModal({ open, title, onClose, onSubmit, children }: EditorModalProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open) dialogRef.current?.focus(); // 焦点落对话框(简单落焦;jsdom/真浏览器同径)
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sx-editor-modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="sx-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sx-editor-modal-head">
          <h3>{title}</h3>
          <button type="button" className="sx-editor-modal-close" aria-label={t('Close', '关闭')} onClick={onClose}>
            ×
          </button>
        </header>
        <form
          className="sx-editor-modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <div className="sx-editor-modal-fields">{children}</div>
          <div className="sx-card-actions sx-editor-modal-actions">
            <button type="submit">{t('Save', '保存')}</button>
            <button type="button" onClick={onClose}>
              {t('Cancel', '取消')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** 空态文本(列表空/过滤无果统一面;role=status 礼貌播报) */
export function EmptyState({ text }: { readonly text: string }): JSX.Element {
  return (
    <div className="sx-empty-state" role="status">
      {text}
    </div>
  );
}

/** 错误条(行内告警统一面;role=alert 沿 home-error 告警语义) */
export function ErrorBanner({ text }: { readonly text: string }): JSX.Element {
  return (
    <p className="sx-error-banner" role="alert">
      {text}
    </p>
  );
}

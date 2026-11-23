import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { SourceBadge } from './SourceBadge';
import type { SourceBadgeProps } from './SourceBadge';
import { Select } from './controls';

/** 统一开关(2026-11-17 用户裁定「设置页所有开关换胶囊按钮,黑白灰配色,不要绿色,稍大」):
 *  sx-switch 令牌单点——胶囊形状(corner-shape:initial 拔出全局超椭园级联,端部正圆弧不被拉椭圆);
 *  on=var(--fg) 黑白反色(原 --ok 绿退役),off=fg 20% 灰;40×22 较原 26×15 大一档。
 *  设置页布尔行(DarkSurfaceRow)与各卡片头开关(MCP/插件/技能/资源卡)共用 */
export function Switch({ on, onToggle, ariaLabel, disabled, title }: {
  readonly on: boolean;
  readonly onToggle: () => void;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  /** env 覆盖禁编提示等(data-tip 全局单例气泡面) */
  readonly title?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      className={`sx-switch${on ? ' on' : ''}`}
      onClick={onToggle}
      disabled={disabled}
      data-tip={title}
    >
      <span className="knob" aria-hidden="true" />
    </button>
  );
}

/**
 * Task 21 设置共享组件 kit(Phase F 六面板改版的统一消费面,T22-27 逐页verbatim消费):
 * - ScopeSelect:作用域目标选择器下拉(共享 Select 弹层控件)——资源页工具栏内联目标选择面
 *   (2026-10-29 用户裁定:工具栏三件套入页,壳顶分段控件撤除,目标状态留壳层统一下发;
 *   同日再裁定:两选项「具体项目|全局」退役,改**目标选择器**——选项=全局 + 全部已注册
 *   项目按项目名可选,选哪个项目五资源页就读写哪个项目的配置,不再限于当前打开的会话项目)。
 * - SearchBar:受控输入+内置 200ms 防抖(契约见 SearchBarProps 注)——列表过滤统一入口。
 * - ResourceCard:资源卡(icon/标题/副题/来源徽标/chips/开关/actions)——结构沿 sx-mcp-card
 *   现行卡片语言(surface-elevated 面+border 圆角+头部行),开关=Switch 组件(sx-switch 令牌);
 *   children=折叠详情(<details>,summary「Details/详情」)。
 * - EditorModal:居中模态编辑对话框(遮罩+居中;Cancel/右上 ×/Esc/遮罩点击=onClose,Save=
 *   onSubmit)——raw/JSON 类编辑面统一容器(2026-10-29 用户裁定:弹窗替换右滑抽屉;Esc 走
 *   document 捕获段并 stopPropagation——设置壳「Esc 回会话态」监听在 document 冒泡段,弹窗
 *   开着时 Esc 只关弹窗不退设置态;焦点落对话框,不做完整焦点陷阱)。
 * - ModalTabs:弹窗顶部 Tab 条(2026-10-29 用户裁定:MCP/Plugins 配置弹窗改「配置|源码」两 Tab
 *   替代"表单+折叠 JSON 段"堆叠;共享件,role=tablist/tab)。同轮裁定:ScopeSelect 工具栏下拉
 *   定宽(sx-dd-fixed 150px,超长项目名 ellipsis+title tip 全名)。
 * - EmptyState/ErrorBanner:空态/错误条(role=alert,沿 home-error 的告警语义)。
 * - ModalField:弹窗表单行(2026-10-30 用户裁定:弹窗内容对齐主设置面行形态)——label(+hint)
 *   行与控件行两段纵向,字级/间距对齐 .sx-setting-label/.sx-setting-desc;纯容器零逻辑
 *   (children 原样透传,受控件/aria-label 全由消费方持有)。
 * 样式零新依赖:全部走 app.css 既有令牌(--surface-elevated/--border/--radius 系列/--warn…),
 * 新类前缀 sx-scope-/sx-search-/sx-rc-/sx-drawer-field/sx-empty-/sx-error-(Task 21 追加段)+
 * sx-editor-modal-/sx-res-toolbar(2026-10-29 追加段)+ sx-modal-field-(2026-10-30 追加段,同纯加法纪律)。
 * 字符串一律渲染期 t(en,zh)(G14.213 设置面 i18n 纪律)。
 */

/** 设置作用域(与 src/catalog/types 的 Scope 同形——gui 侧自持别名,面板 props 统一此名) */
export type SettingsScope = 'global' | 'project';

/** 作用域目标选择器选项行:value=项目 root('' = 全局);label=项目名(basename) */
export interface ScopeOption {
  readonly value: string;
  readonly label: string;
}

/** root → 项目显示名(取末段 basename;win32 反斜杠/unix 斜杠双容错,纯路径段) */
export function scopeTargetLabel(root: string): string {
  const parts = root.split(/[\\/]/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? root;
}

/** 缺省选项面(壳未下发 scopeOptions 时——pane 直渲/桩测):全局 + 当前 root(非空时)。
 *  壳层真值面=GET /workspaces 注册表(全局+全部注册项目按名排序),见 SettingsShell */
export function defaultScopeOptions(root: string): ScopeOption[] {
  const opts: ScopeOption[] = [{ value: '', label: t('Global', '全局') }];
  if (root !== '') opts.push({ value: root, label: scopeTargetLabel(root) });
  return opts;
}

/** ScopeSelect props:目标选择器受控——value=当前目标项目 root('' = 全局);options=壳装配的
 *  全局+注册项目清单;onChange 上抛新目标 root 字符串('' = 全局) */
interface ScopeSelectProps {
  readonly value: string;
  readonly options: readonly ScopeOption[];
  readonly onChange: (value: string) => void;
}

/** 作用域目标选择器下拉(2026-10-29 用户裁定:两选项形态退役,改目标选择器):
 *  沿共享 Select 弹层控件(sx-dd 同款样式);选项=「全局」+ 全部已注册项目(按项目名);
 *  选哪个项目,资源页读写就锚定哪个项目(壳换发 root/scope 后 pane 重拉)——不再限于
 *  当前打开的会话项目。2026-10-29 用户裁定(下拉定宽):sx-dd-fixed 150px 固定宽不随内容
 *  伸缩,超长项目名 ellipsis 截断(.sx-dd-value 既有规则),title tip 提示全名 */
export function ScopeSelect({ value, options, onChange }: ScopeSelectProps): JSX.Element {
  const current = options.find((o) => o.value === value);
  return (
    <Select
      className="sx-dd-fixed"
      ariaLabel={t('Settings scope', '配置作用域')}
      value={value}
      options={options.map((o) => ({ v: o.value, l: o.label }))}
      title={current?.label}
      onChange={onChange}
    />
  );
}

/** ModalTabs 选项行:id=受控当值键;label=渲染期 t() 后的标签 */
interface ModalTabItem {
  readonly id: string;
  readonly label: string;
}

/** ModalTabs props:受控顶部 Tab 条(2026-10-29 用户裁定:MCP/Plugins 配置弹窗改「配置|源码」
 *  两 Tab 替代"表单+折叠 JSON 段"堆叠;切 Tab 不清内容——内容留存由弹窗宿主持有)。
 *  role=tablist/tab+aria-selected(键盘焦点沿钮原生序,无 roving tabindex——弹窗内两 Tab 小集,
 *  Tab 键遍历即可达) */
interface ModalTabsProps {
  readonly tabs: readonly ModalTabItem[];
  readonly active: string;
  readonly onChange: (id: string) => void;
  /** 无障碍名(aria-label,如弹窗标题) */
  readonly ariaLabel?: string;
}

/** 弹窗顶部 Tab 条(共享件——MCP/Plugins 配置弹窗同构消费;样式 sx-modal-tabs 追加段) */
export function ModalTabs({ tabs, active, onChange, ariaLabel }: ModalTabsProps): JSX.Element {
  return (
    <div className="sx-modal-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={`sx-modal-tab${tab.id === active ? ' active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** SearchBar 防抖窗(毫秒)——键入停顿 200ms 才上抛 onChange */
const SEARCH_DEBOUNCE_MS = 200;

/** SearchBar props(防抖契约):受控 value 是过滤真值源;键入即时回显输入框,onChange 防抖
 *  200ms(自最后一次键起算,窗内连击合并单次终值);value 外部变更(资源切换清空等)即时镜像
 *  回输入框并撤销在途未抛窗。消费方零再防抖 */
interface SearchBarProps {
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
 *  (sx-chip 令牌);badge=SourceBadgeProps 直通;enabled+onToggle 同在才渲染开关(Switch 组件,
 *  aria-label=`Enable {title}`——enabled 缺省 true);actions=卡尾操作钮行;
 *  body=直显卡身(2026-10-31 用户裁定:描述等内容不折「详情」,直接展示);children=折叠详情
 *  (<details>,summary「Details/详情」)。根元素 <li>——置于 ul.sx-rc-list(或既有 sx-mcp-list
 *  语言)列表内消费 */
interface ResourceCardProps {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly subtitle?: string;
  readonly chips?: ReactNode;
  readonly badge?: SourceBadgeProps;
  readonly enabled?: boolean;
  readonly onToggle?: () => void;
  readonly actions?: ReactNode;
  readonly body?: ReactNode;
  readonly children?: ReactNode;
}

/** 资源卡统一骨架(六面板改版共用):头部行(icon/标题/副题/徽标/开关)+chips 行+actions 行+
 *  body 直显行+折叠详情。开关=Switch 组件(sx-switch 令牌,on=黑白反色) */
export function ResourceCard({ icon, title, subtitle, chips, badge, enabled, onToggle, actions, body, children }: ResourceCardProps): JSX.Element {
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
          <Switch
            on={on}
            onToggle={onToggle}
            ariaLabel={`${t('Enable', '启用')} ${title}`}
          />
        )}
      </div>
      {chips !== undefined && <div className="sx-rc-chips">{chips}</div>}
      {actions !== undefined && <div className="sx-card-actions">{actions}</div>}
      {/* 展开面板(2026-11-17 对齐修复):操作行之后整宽块——团队章程等长内容左右与卡片内缘对称 */}
      {body !== undefined && <div className="sx-rc-body">{body}</div>}
      {children !== undefined && (
        <details className="sx-rc-details">
          {/* 2026-11-07 用户裁定:原生三角退役→胶囊开关(chevron 随开合旋转,面底语言同 ghost 钮) */}
          <summary>
            {t('Details', '详情')}
            <ChevronDown size={16} strokeWidth={2} className="sx-disc-chev" aria-hidden="true" />
          </summary>
          {children}
        </details>
      )}
    </li>
  );
}

/** ModalField props:label(+hint)标签行 + 控件行(纵向两段;hint 可选=字段说明,同主设置面
 *  desc 语义)。纯容器:children 原样透传(输入/Select/textarea 全由消费方持 aria-label 与
 *  受控态),零逻辑 */
interface ModalFieldProps {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}

/** 弹窗表单行(2026-10-30 用户裁定:弹窗内容对齐主设置面 SettingsForm 卡+行形态):每字段=
 *  标签行(label+hint,字级对齐 .sx-setting-label/.sx-setting-desc)+控件行;行距/分隔线由
 *  app.css 2026-10-30 追加段(.sx-modal-field-*)承接,四编辑弹窗(MCP/Agents/Plugins/Providers)
 *  统一消费 */
export function ModalField({ label, hint, children }: ModalFieldProps): JSX.Element {
  return (
    <div className="sx-modal-field">
      <div className="sx-modal-field-label">
        <span className="sx-modal-field-name">{label}</span>
        {hint !== undefined && <span className="sx-modal-field-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** EditorModal props:open=false 恒 null;onClose=遮罩点击/Cancel/×/Esc 统一闭面;onSubmit=Save
 *  (form submit 路径,preventDefault 由本件承担);children=弹窗体字段面 */
interface EditorModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly children?: ReactNode;
}

/** 模态壳单点（D96 收敛：EditorModal/rewind-confirm/SkillPreviewModal 三份手写壳——backdrop+
 *  role=dialog/aria-modal/tabIndex=-1+挂载落焦+document keydown 捕获 Esc→stopPropagation→onClose
 *  +header(h3) 各持一份，仅 footer/修饰类/portal/头部动作不同）。Esc 与遮罩点击恒走 onClose
 *  （busy 守卫面以守卫过的回调注入即原语义）；Esc preventDefault 随壳恒带（capture 段截断壳层
 *  「Esc 回会话态」语义不变）；挂载落焦内置（简单落焦，不做完整焦点陷阱） */
export function ModalShell(props: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children?: ReactNode;
  /** 修饰类（sx-editor-modal 后置——sx-turn-confirm/sx-skill-preview 尺寸覆写面） */
  readonly modifier?: string;
  /** createPortal 到 body（rewind 面原形态；缺省就地渲染） */
  readonly portal?: boolean;
  /** 头部动作槽（× 之前——SkillPreview 复制钮位） */
  readonly headerActions?: ReactNode;
  /** 头部 × 钮（rewind 三按钮面原无 ×）；缺省 true */
  readonly closeButton?: boolean;
}): JSX.Element {
  const { title, onClose, children, modifier, portal = false, headerActions, closeButton = true } = props;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    dialogRef.current?.focus(); // 焦点落对话框(简单落焦;jsdom/真浏览器同径)
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const shell = (
    <div className="sx-editor-modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className={`sx-editor-modal${modifier !== undefined ? ` ${modifier}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sx-editor-modal-head">
          <h3>{title}</h3>
          {headerActions}
          {closeButton && (
            <button type="button" className="sx-editor-modal-close" aria-label={t('Close', '关闭')} onClick={onClose}>
              ×
            </button>
          )}
        </header>
        {children}
      </div>
    </div>
  );
  return portal ? createPortal(shell, document.body) : shell;
}

/** 居中模态编辑对话框(2026-10-29 用户裁定:弹窗替换右滑抽屉;raw/JSON 编辑统一容器):ModalShell
 *  组合(D96)+form 体 Save/Cancel 尾栏;尺寸 2026-10-30 用户裁定加宽:min(92vw,680px)/max-height
 *  84vh 内滚动(app.css 覆写段) */
export function EditorModal({ open, title, onClose, onSubmit, children }: EditorModalProps): JSX.Element | null {
  if (!open) return null;
  return (
    <ModalShell title={title} onClose={onClose}>
      <form
        className="sx-editor-modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="sx-editor-modal-fields">{children}</div>
        <div className="sx-card-actions sx-editor-modal-actions">
          <button type="submit" className="primary">{t('Save', '保存')}</button>
          <button type="button" onClick={onClose}>
            {t('Cancel', '取消')}
          </button>
        </div>
      </form>
    </ModalShell>
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

/** 两段式删除确认钮武装时长(毫秒):超时未确认自动解除回「删除」 */
const DELETE_CONFIRM_MS = 3000;

/** ConfirmDeleteButton props:ariaLabel 恒定(两段同名——测试/读屏按资源名寻钮不因换段漂移);
 *  dataTip 直通(不可写 tip 等);onConfirm 仅在武装段二次点击时触发 */
interface ConfirmDeleteButtonProps {
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  readonly dataTip?: string;
  readonly onConfirm: () => void;
}

/** 两段式删除确认钮(2026-10-30 用户裁定「删除按钮应该有二次确认,原地显示确认红按钮」):
 *  同一按钮原地两段——首击=武装(变红显「确认删除」并落焦,Enter 同确认),DELETE_CONFIRM_MS
 *  内再击才执行 onConfirm;超时/失焦(点击他处/Tab 离开)自动解除回「删除」。确认前零副作用,
 *  无弹窗无遮罩。aria-label 恒定不变段,accessible name 稳定 */
export function ConfirmDeleteButton({ ariaLabel, disabled, dataTip, onConfirm, icon = false }: ConfirmDeleteButtonProps & { icon?: boolean }): JSX.Element {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const disarm = (): void => {
    setArmed(false);
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => () => disarm(), []); // 卸载兜底:在途计时器不泄漏(含换段/关闭弹窗)
  useEffect(() => {
    if (armed) btnRef.current?.focus(); // 武装即落焦:Enter=确认;点击他处=失焦解除
  }, [armed]);
  return (
    <button
      ref={btnRef}
      type="button"
      className={`${armed ? 'sx-del-confirm' : ''}${icon ? ' sx-del-iconbtn' : ''}`.trim() || undefined}
      aria-label={ariaLabel}
      data-tip={dataTip}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          disarm();
          onConfirm();
          return;
        }
        setArmed(true);
        timer.current = setTimeout(disarm, DELETE_CONFIRM_MS);
      }}
      onBlur={() => {
        if (armed) disarm();
      }}
    >
      {icon ? <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" /> : armed ? t('Confirm delete', '确认删除') : t('Delete', '删除')}
    </button>
  );
}

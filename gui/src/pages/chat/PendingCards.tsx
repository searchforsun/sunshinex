import { useEffect, useRef, useState } from 'react';
import { Check, Circle, MessageCircleQuestion, PenLine, ShieldCheck } from 'lucide-react';
import { t } from '../../i18n';
import type { GuiApprovalReq, GuiAskReq } from '../../connection';

/** 挂起卡渲染件（D32 批C-3 拆分自 Chat.tsx）：审批卡与问询卡(dock 形态)。纯渲染+回调 props,
 *  挂起生命周期(cards 状态/回执寻址)归 use-session-events;行为零变化(Chat.test 为锚)。 */

/** G4 审批卡:三按钮字面即 ApprovalDecision(allow/deny/always)——回执经 HTTP,寻址 pid。
 *  G14.88 dock 形态(与 ask 同容器);按钮同 ask 的 primary/次级款(去绿实心/红字花哨款);
 *  G14.90 卡头图标(ShieldCheck 标识审批面) */
export function ApprovalCard({ req, onDecision }: { req: GuiApprovalReq; onDecision: (decision: string) => void }): JSX.Element {
  return (
    <div className="pending-card approval-card">
      <div className="card-head">
        <span className="card-head-icon">
          <ShieldCheck size={15} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="card-title">{`[approval ${req.kind ?? '?'}] ${req.subject ?? '(无标题)'}`}</div>
      </div>
      {req.reason !== undefined && req.reason !== '' && <div className="card-reason">{req.reason}</div>}
      <div className="card-actions">
        <button type="button" className="primary" onClick={() => onDecision('allow')}>
          {t('Allow', '允许')}
        </button>
        <button type="button" onClick={() => onDecision('deny')}>
          {t('Deny', '拒绝')}
        </button>
        <button type="button" onClick={() => onDecision('always')}>
          {t('Always', '总是允许')}
        </button>
      </div>
    </div>
  );
}

/** 单题作答态(dock 级提交校验用):labels=勾选的选项;custom=自由输入(非空优先) */
export interface AskPick {
  labels: string[];
  custom: string;
}

export const pickAnswered = (p: AskPick | undefined): boolean => p !== undefined && (p.labels.length > 0 || p.custom.trim() !== '');

/** G4 问询卡(G14.91 受控化):选项卡片化(整卡可点,选中 accent 边+勾图标);Other=默认自由输入卡
 *  (✎+输入框合二为一,customIndex 占位项不再单列——底层 custom 答案恒可发);提交区在 dock 底部统一承载。
 *  G14.93 隐现内部化:溢出检测在卡内选项区——mask 只渐隐选项内容,外框恒完整 */
export function AskCard({ req, pick, onPick, onOpenAgent }: { req: GuiAskReq; pick: AskPick; onPick: (patch: Partial<AskPick>) => void; onOpenAgent?: (label: string, agentTitle: string, task?: string) => void }): JSX.Element {
  const multiple = req.multiple === true;
  const selected = pick.labels;
  const [customFocused, setCustomFocused] = useState(false);
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = optionsRef.current;
    if (el === null) {
      setOverflowing(false);
      return;
    }
    const sync = (): void => {
      const over = el.scrollHeight > el.clientHeight + 2;
      setOverflowing(over);
      // 2026-11-07 用户裁定「ask 要显示完最后一个输入框」:溢出即滚到卡尾——自由输入卡
      // (选项序列最后一项)恒可见,不藏在折叠面之下;聚焦输入时同规则再钉一次
      if (over) el.scrollTop = el.scrollHeight;
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [req.options.length]);

  const toggle = (label: string): void => {
    onPick({
      labels: multiple ? (selected.includes(label) ? selected.filter((l) => l !== label) : [...selected, label]) : selected.includes(label) ? [] : [label],
      // 单选互斥对称(2026-10-30 用户裁定「点输入框去掉上面的选中」的镜像):单选时选选项即清自由
      // 输入——否则「已选选项+有字输入」并存而提交优先发 custom,所选选项失真
      ...(multiple ? null : { custom: '' }),
    });
  };

  return (
    <div className="pending-card ask-card">
      <div className="card-head">
        <span className="card-head-icon">
          <MessageCircleQuestion size={15} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="card-title">{req.question}</div>
      </div>
      {/* 子智能体路由归因(2026-11-14 用户裁定「选择题卡片上加上子智能体的超链接」):fork 问询经
          父接缝路由到主对话——卡头下发起来源行,点击开该子智能体的转录页签(在飞聚焦) */}
      {req.askedBy !== undefined && (
        <div className="ask-card-source">
          <span>{t('Asked by sub-agent', '来自子智能体')}</span>
          <button
            type="button"
            className="ask-card-agent-link"
            data-tip={t('Open sub-agent transcript', '打开子智能体转录')}
            onClick={() => onOpenAgent?.(req.askedBy!.label, req.askedBy!.label)}
          >
            {req.askedBy.label}
          </button>
        </div>
      )}
      <div className={`card-options${overflowing ? ' overflowing' : ''}`} ref={optionsRef}>
        {req.options.map((o, i) => {
          if (i === req.customIndex) return null; // G14.91 Other 占位项与输入卡合二为一
          const checked = selected.includes(o.label);
          return (
            <label key={o.label} className={`card-option${checked ? ' checked' : ''}`}>
              <input type={multiple ? 'checkbox' : 'radio'} name={`ask-option-${req.question}`} checked={checked} onChange={() => toggle(o.label)} />
              <span className="card-option-icon">
                {checked ? <Check size={14} strokeWidth={2.25} aria-hidden="true" /> : <Circle size={14} strokeWidth={1.75} aria-hidden="true" />}
              </span>
              <span className="card-option-text">
                {o.label}
                {o.description !== undefined && o.description !== '' && <span className="card-option-desc">{` — ${o.description}`}</span>}
              </span>
            </label>
          );
        })}
        <div className={`card-custom-card${pick.custom.trim() !== '' ? ' filled' : ''}${!multiple && customFocused ? ' active' : ''}`}>
          <span className="card-option-icon">
            <PenLine size={14} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <input
            aria-label="custom answer"
            className="card-custom"
            value={pick.custom}
            placeholder={t('Other… free input', '其他… 自由输入')}
            onFocus={() => {
              setCustomFocused(true);
              // 单选互斥(2026-10-30 用户裁定):点自由输入=选中输入卡,上方单选去选中
              if (!multiple && selected.length > 0) onPick({ labels: [] });
              // 聚焦即滚到卡尾(2026-11-07 用户裁定「显示完最后一个输入框」)
              const el = optionsRef.current;
              if (el !== null) el.scrollTop = el.scrollHeight;
            }}
            onBlur={() => setCustomFocused(false)}
            onChange={(e) => onPick({ custom: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

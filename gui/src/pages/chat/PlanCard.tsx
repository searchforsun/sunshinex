import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ListTodo } from 'lucide-react';
import { t } from '../../i18n';
import { keepUrl, mdComponentsPlain } from './md-render';

/** 计划确认卡(task 10,spec §5.2 阶段三 plan-arm GUI 面):planFlow 裁决卡的渲染件——
 *  计划书 markdown(沿 GUI 既有 markdown 通道,mdComponentsPlain 无链接版+keepUrl,ToolEntry
 *  结果区同款)+步骤清单只读+批准/拒绝两按钮(拒绝展开反馈输入框)。纯渲染+onDecide 回调,
 *  挂起生命周期(cards 状态/回执寻址)归 use-session-events(ApprovalCard 同款分工);
 *  回执经 connection.replyPlanApproval → POST /plan-approval/:pid,决策体 PlanDecision 同构
 *  {approved, feedback?}——批准落工作区编辑自动解除,拒绝(+反馈)保持 armed 进修订轮。 */

/** 决策体(与 serve harness PlanDecision 同构;feedback 空=不带字段) */
export interface PlanCardDecision {
  approved: boolean;
  feedback?: string;
}

/** plan-approval 挂起卡:doc=计划书 markdown 全文;items=步骤清单(只读呈现,不承载勾选态)。
 *  批准即回执;拒绝切换反馈输入态,提交时非空 feedback 随决策体携带(空=纯拒绝) */
export function PlanCard({ doc, items, onDecide }: { doc: string; items: string[]; onDecide: (d: PlanCardDecision) => void }): JSX.Element {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const sendReject = (): void => {
    const text = feedback.trim();
    onDecide(text === '' ? { approved: false } : { approved: false, feedback: text });
  };
  return (
    <div className="pending-card plan-card">
      <div className="card-head">
        <span className="card-head-icon">
          <ListTodo size={15} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="card-title">{t('Plan approval', '计划确认')}</div>
      </div>
      <div className="plan-card-doc tool-md">
        <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepUrl} components={mdComponentsPlain}>
          {doc}
        </ReactMarkdown>
      </div>
      {items.length > 0 && (
        <ol className="plan-card-items">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ol>
      )}
      {rejecting ? (
        <div className="plan-card-feedback">
          <textarea
            aria-label="plan feedback"
            className="plan-card-feedback-input"
            rows={2}
            value={feedback}
            placeholder={t('What should change? (optional)', '需要调整什么？（可不填）')}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="card-actions">
            <button type="button" className="primary" onClick={sendReject}>
              {t('Send', '提交')}
            </button>
            <button type="button" onClick={() => setRejecting(false)}>
              {t('Back', '返回')}
            </button>
          </div>
        </div>
      ) : (
        <div className="card-actions">
          <button type="button" className="primary" onClick={() => onDecide({ approved: true })}>
            {t('Approve', '批准')}
          </button>
          <button type="button" onClick={() => setRejecting(true)}>
            {t('Reject', '拒绝')}
          </button>
        </div>
      )}
    </div>
  );
}

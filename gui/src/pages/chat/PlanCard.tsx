import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { NotebookPen } from 'lucide-react';
import { t } from '../../i18n';
import { keepUrl, mdComponentsPlain, MD_REHYPE_PLUGINS, MD_REMARK_PLUGINS } from './md-render';

/** 计划确认卡(2026-11-03 修订重排:滚动文档区+常驻反馈框;2026-11-04 泛化:按钮集随当前档自适应):
 *  计划书 markdown(沿 GUI 既有 markdown 通道,mdComponentsPlain 无链接版+keepUrl,ToolEntry 结果区
 *  同款)纵向滚动(max-height min(44vh,460px),修订轮换 pid remount 天然回顶);反馈框常驻
 *  (Enter=带反馈重新计划,Shift+Enter 换行——与 composer 键位同构)。按钮集按当前档:
 *  只读域(plan/read-only)三键=实施·工作区编辑(primary 缺省档)/实施·完全访问(平级非 primary,
 *  无二次确认——pill 直选 full-access 同权)/重新计划=取框内文本;可写域(acceptEdits/full-access)
 *  两键=实施(当前档,primary)/重新计划——批准即维持本档,无落档切换(档位操作走 pill,不混入计划卡)。
 *  空文本重新计划=放弃本轮流程(decision 不带 feedback,run 中断回输入态)。
 *  items 不再独立渲染 ol(Steps 节已随 doc 全文在滚动区内,双份同内容上下排即冗余;items 仍是执行
 *  权威——执行进度走会话 todo 面)。纯渲染+onDecide 回调,挂起生命周期(cards 状态/回执
 *  寻址)归 use-session-events(ApprovalCard 同款分工);回执经 connection.replyPlanApproval →
 *  POST /plan-approval/:pid,决策体 PlanDecision 同构 {approved, mode?, feedback?}——批准落所选档
 *  (可写域=当前档),重新计划(+反馈)进修订环,空反馈=放弃本轮。 */

/** 决策体(与 serve harness PlanDecision 同构;mode=批准落档档位,缺省 acceptEdits——full-access
 *  必须显式选择;feedback 空=不带字段) */
export interface PlanCardDecision {
  approved: boolean;
  mode?: 'acceptEdits' | 'full-access';
  feedback?: string;
}

/** plan-approval 挂起卡:doc=计划书 markdown 全文(滚动区渲染);items=步骤清单(执行权威,不重复上屏);
 *  name/path=计划名与计划文件绝对路径（2026-11-03 交稿协议）——卡头蓝色链接点击 onOpenFile 开侧栏原文
 *  （/session/:id/file 数据目录已放行,零新端点）;path 缺席（未落盘/旧 daemon）降级纯文本 */
export function PlanCard({ doc, name, path, onOpenFile, onDecide, mode = 'plan' }: { doc: string; items: string[]; name?: string; path?: string; onOpenFile?: (p: string) => void; onDecide: (d: PlanCardDecision) => void; mode?: 'read-only' | 'acceptEdits' | 'full-access' | 'plan' }): JSX.Element {
  const [feedback, setFeedback] = useState('');
  const writable = mode === 'acceptEdits' || mode === 'full-access'; // 可写域=两键卡(实施=维持当前档)
  const sendRePlan = (): void => {
    const text = feedback.trim();
    onDecide(text === '' ? { approved: false } : { approved: false, feedback: text });
  };
  return (
    <div className="pending-card plan-card">
      <div className="card-head">
        <span className="card-head-icon">
          <NotebookPen size={15} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="card-title">{t('Plan approval', '计划确认')}</div>
        {name !== undefined && name !== '' ? (
          path !== undefined && onOpenFile !== undefined ? (
            <span
              role="button"
              tabIndex={-1}
              className="card-title plan-name-link"
              data-tip={t('Open plan file', '打开计划文件')}
              onClick={(e) => {
                e.stopPropagation();
                onOpenFile(path);
              }}
            >
              {name}
            </span>
          ) : (
            <span className="card-title plan-name-link">{name}</span>
          )
        ) : null}
      </div>
      <div className="plan-card-doc tool-md">
        <ReactMarkdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={keepUrl} components={mdComponentsPlain}>
          {doc}
        </ReactMarkdown>
      </div>
      <div className="plan-card-feedback">
        <textarea
          aria-label="plan feedback"
          className="plan-card-feedback-input"
          rows={2}
          value={feedback}
          placeholder={t('What should change? (optional — Enter re-plans with feedback)', '需要调整什么？（可不填——Enter 带反馈重新计划）')}
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              // 空文本 Enter 无操作(2026-11-03 用户实测「没做选择就被拒」:点进反馈框误按 Enter=立即
              // 放弃的陷阱)——带反馈 Enter 才提交重新计划;放弃本轮必须 Esc/显式关闭
              if (feedback.trim() !== '') sendRePlan();
            }
          }}
        />
      </div>
      <div className="card-actions">
        <button type="button" className="primary" onClick={() => onDecide({ approved: true, mode: writable ? mode : 'acceptEdits' })}>
          {writable && mode === 'full-access' ? t('Implement (full access)', '实施（完全访问）') : t('Implement (workspace edits)', '实施（工作区编辑）')}
        </button>
        {!writable && (
          <button type="button" onClick={() => onDecide({ approved: true, mode: 'full-access' })}>
            {t('Implement (full access)', '实施（完全访问）')}
          </button>
        )}
        <button type="button" onClick={sendRePlan}>
          {t('Re-plan', '重新计划')}
        </button>
      </div>
    </div>
  );
}

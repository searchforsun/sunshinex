import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { NotebookPen, ShieldCheck, Unlock } from 'lucide-react';
import { t } from '../../i18n';
import { keepUrl, mdComponentsPlain, MD_REHYPE_PLUGINS, MD_REMARK_PLUGINS } from './md-render';

/** 计划确认卡(2026-11-03 修订重排:滚动文档区+常驻反馈框;2026-11-04 泛化:按钮集随当前档自适应):
 *  计划书 markdown(沿 GUI 既有 markdown 通道,mdComponentsPlain 无链接版+keepUrl,ToolEntry 结果区
 *  同款)纵向滚动(max-height min(44vh,460px),修订轮换 pid remount 天然回顶);反馈框常驻
 *  (Enter=带反馈重新计划,Shift+Enter 换行——与 composer 键位同构)。按钮排布(2026-11-04 用户裁定)
 *  取消|重新计划|实施:取消=放弃本轮(decision 不带 feedback);重新计划必须反馈框有内容(空=禁用,
 *  放弃语义归取消钮,不再兼义);实施按当前档——只读域(plan/read-only)双键=实施·工作区编辑(primary
 *  缺省档)+实施·完全访问(Unlock 黄图标警示);可写域(acceptEdits/full-access)单键=实施(当前档,
 *  图标随档)——批准即维持本档,无落档切换(档位操作走 pill,不混入计划卡)。
 *  实施钮双域统一「{图标} 实施」(hover 显「在工作区编辑/完全访问下实施」),取消/重新计划纯文字;<480px 实施钮折纯图标,再窄换行。
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
      {/* 按钮排布(2026-11-04 用户裁定):取消 | 重新计划 | 实施——取消=放弃本轮(decision 不带 feedback);
          重新计划必须反馈框有内容(空=禁用,放弃走取消,空文本不再兼义);实施:可写域单键=维持当前档
          (plain 实施,图标随档);只读域双键=工作区编辑(primary)/完全访问(warn 黄警示)。
          实施钮=「{图标} 实施」双域统一(2026-11-04 用户裁定:档名后缀撤下,hover 显落档说明),取消/重新计划纯文字;容器查询 <480px 隐文字纯图标,再窄 flex-wrap 换行 */}
      <div className="card-actions">
        <button type="button" onClick={() => onDecide({ approved: false })}>{t('Cancel', '取消')}</button>
        <button type="button" disabled={feedback.trim() === ''} onClick={sendRePlan}>{t('Re-plan', '重新计划')}</button>
        {writable ? (
          <button type="button" className="primary" data-tip={mode === 'full-access' ? t('Implement under full access', '在完全访问下实施') : t('Implement under workspace edits', '在工作区编辑下实施')} onClick={() => onDecide({ approved: true, mode })}>
            {mode === 'full-access' ? <Unlock size={14} strokeWidth={2} aria-hidden="true" className="ico-warn" /> : <ShieldCheck size={14} strokeWidth={2} aria-hidden="true" />}
            <span className="btn-label">{t('Implement', '实施')}</span>
          </button>
        ) : (
          <>
            {/* 实施钮=「{图标} 实施」(2026-11-04 用户裁定):档名后缀撤下——落档说明收进 hover
                (data-tip 全局 tooltip;可访问名=aria-label,与 hover 文案同源) */}
            <button type="button" className="primary" aria-label={t('Implement under workspace edits', '在工作区编辑下实施')} data-tip={t('Implement under workspace edits', '在工作区编辑下实施')} onClick={() => onDecide({ approved: true, mode: 'acceptEdits' })}>
              <ShieldCheck size={14} strokeWidth={2} aria-hidden="true" />
              <span className="btn-label">{t('Implement', '实施')}</span>
            </button>
            <button type="button" className="primary" aria-label={t('Implement under full access', '在完全访问下实施')} data-tip={t('Implement under full access', '在完全访问下实施')} onClick={() => onDecide({ approved: true, mode: 'full-access' })}>
              {/* 完全访问=黄图标警示(2026-11-04 用户裁定「图标显示黄色就可以」——整钮黄退役) */}
              <Unlock size={14} strokeWidth={2} aria-hidden="true" className="ico-warn" />
              <span className="btn-label">{t('Implement', '实施')}</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

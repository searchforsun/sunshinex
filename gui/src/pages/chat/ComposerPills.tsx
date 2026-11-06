import { ArrowUp, ChevronDown, Square } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { t } from '../../i18n';
import { ContextRing } from '../../context-ring';
import { EffortChip, EffortSlider } from '../../effort-slider';
import type { Connection, ConnectionState } from '../../connection';
type SessionModelInfo = Awaited<ReturnType<Connection['sessionModel']>>;
import { baseModelName } from './EntryViews';
import { PlusAddIcon } from '../../sidebar/project-menu-util';
// ModeIcon 值回引宿主(调用期解绑,EntryViews 同款先例;Chat 原路径再导出保 WelcomeComposer 消费)
import { ModeMenu, sessionModeLabel } from '../../composer/mode-menu';
import { ModeIcon } from '../Chat';

/** composer 双 pill 簇(D32 第六批批F-1 自 Chat.tsx 平移,行为零变化):左=+附加面板/审批模式,
 *  右=上下文圆环/模型·强度 pill/发送·停止。开关态与动作回调 props 注入(setter 用 React
 *  Dispatch 原形,体逐字平移)。 */

interface PillsLeftProps {
  readonly pillOpen: 'mode' | 'model' | 'plus' | null;
  readonly setPillOpen: Dispatch<SetStateAction<'mode' | 'model' | 'plus' | null>>;
  readonly sessMode: 'read-only' | 'acceptEdits' | 'full-access' | 'plan';
  readonly setSessMode: Dispatch<SetStateAction<'read-only' | 'acceptEdits' | 'full-access' | 'plan'>>;
  readonly conn: Connection;
  readonly sessionId: string;
}

export function ComposerPillsLeft(props: PillsLeftProps): JSX.Element {
  const { pillOpen, setPillOpen, sessMode, setSessMode, conn, sessionId } = props;
  const modeLabel = sessionModeLabel(sessMode);
  return (
          <div className="composer-pills">
            {/* 与欢迎页同构(G12 三轮):+ 开附加面板(卡顶同宽浮层:命令/技能/文件) */}
            <button
              type="button"
              className="composer-pill composer-plus-btn"
              aria-label="add attachment"
              aria-expanded={pillOpen === 'plus'}
              data-tip={t('Add context', '添加上下文')}
              onClick={() => setPillOpen((v) => (v === 'plus' ? null : 'plus'))}
            >
              <PlusAddIcon size={16} />
            </button>
            {/* 审批模式:弹层锚按钮正上方(pill-anchor) */}
            <div className="pill-anchor">
              <button
                type="button"
                className={'composer-pill' + (sessMode === 'full-access' ? ' mode-pill-warn' : '')}
                aria-label="session mode"
                aria-expanded={pillOpen === 'mode'}
                data-tip={modeLabel}
                onClick={() => setPillOpen((v) => (v === 'mode' ? null : 'mode'))}
              >
                <ModeIcon mode={sessMode} />
                {/* 2026-10-24 用户裁定:主栏窄于阈值时标签/箭头 CSS 塌缩(sx-main-narrow),纯图标+tooltip 承载文案 */}
                <span className="pill-label">{modeLabel}</span>
                <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" className="pill-chevron" />
              </button>
              {pillOpen === 'mode' && (
                <ModeMenu
                  mode={sessMode}
                  ariaLabel="session mode menu"
                  onPick={(m) => {
                    setPillOpen(null);
                    setSessMode(m);
                    // 乐观置选;失败不回滚——模式属会话级低危偏好,权威态经下次会话快照/事件回填自纠
                    conn.setSessionMode(sessionId, m).catch(() => {});
                  }}
                />
              )}
            </div>
          </div>
  );
}

interface PillsRightProps {
  readonly pillOpen: 'mode' | 'model' | 'plus' | null;
  readonly setPillOpen: Dispatch<SetStateAction<'mode' | 'model' | 'plus' | null>>;
  readonly conn: Connection;
  readonly sessionId: string;
  readonly ctxInfo: { total: number; window: number; parts: Array<{ id: string; tokens: number; count: number }> } | null;
  readonly refreshCtx: () => void;
  readonly runCount: number;
  readonly steps: number;
  readonly tokens: number;
  readonly cacheTokens: number;
  /** 形态单源：sessionModel 返回类型直推（含图片能力位，防内联窄化漂移；explicitDefault 位 2026-10-28 T11 退役） */
  readonly modelInfo: SessionModelInfo | null;
  readonly setModelInfo: Dispatch<SetStateAction<SessionModelInfo | null>>;
  readonly sessEffort: string | undefined;
  readonly setSessEffort: Dispatch<SetStateAction<string | undefined>>;
  readonly running: boolean;
  readonly input: string;
  readonly send: () => void;
  readonly interrupt: () => void;
  readonly connState: ConnectionState;
  readonly seeding: boolean;
  /** 等待模型待态(2026-10-27 用户裁定:提交被接受→run-open 间 loading 效果挂在发送钮上,
   *  正文等待文字退役)——true 时发送钮转圈 */
  readonly sendLoading?: boolean;
}

export function ComposerPillsRight(props: PillsRightProps): JSX.Element {
  const { pillOpen, setPillOpen, conn, sessionId, ctxInfo, refreshCtx, runCount, steps, tokens, cacheTokens, modelInfo, setModelInfo, sessEffort, setSessEffort, running, input, send, interrupt, connState, seeding, sendLoading } = props;
  return (
          <div className="composer-pills composer-pills-right">
            {/* G14.18 上下文圆环:模型 pill 左侧,hover 弹上下文占用/构成明细/轮次步数/tokens/缓存。
                2026-11-06 用户裁定「辅助草稿去掉上下文圈」:ctxInfo=null(无会话无共享 ctx)不渲染
                圆环——会话中 ctxInfo 恒非空不受影响 */}
            {ctxInfo !== null && (
            <ContextRing
              used={ctxInfo.total}
              window={ctxInfo.window}
              parts={ctxInfo.parts}
              runs={runCount}
              steps={steps}
              tokens={tokens}
              cacheTokens={cacheTokens}
              onOpen={refreshCtx}
            />
            )}
            {/* 模型 pill:显示实际模型名(剥 provider 前缀);菜单=模型列表+思考强度,锚按钮正上方,
                选中不收口(一连选模型+强度,外点/再点收) */}
            <div className="pill-anchor">
              <button
                type="button"
                className="composer-pill model-pill"
                aria-label="session model"
                aria-expanded={pillOpen === 'model'}
                onClick={() => setPillOpen((v) => (v === 'model' ? null : 'model'))}
              >
                <span className="pill-label">{baseModelName(modelInfo?.current)}</span>
                {/* 思考强度随名(G13 反馈轮):`模型 · effort` 同 pill,Codex 同形 */}
                <EffortChip effort={sessEffort ?? 'medium'} />
                <ChevronDown className="pill-chevron" size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {pillOpen === 'model' && (
                <div className="sx-menu-pop pill-pop pill-pop-right pill-pop-tall" role="menu" aria-label="session model menu">
                  {(modelInfo?.choices ?? []).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="menuitem"
                      className={`sx-menuitem${baseModelName(c.id) === baseModelName(modelInfo?.current) ? ' current' : ''}`}
                      data-tip={c.id}
                      onClick={() => {
                        setModelInfo((m) => (m === null ? m : { ...m, current: c.id }));
                        // 源自带档位强度(G13 反馈轮):切换即随名展示(快照回显前先乐观落)
                        if (c.effort !== undefined) setSessEffort(c.effort);
                        // 乐观置选;失败不回滚——模型/强度属会话级低危偏好,权威态经下次会话快照/事件回填自纠
                        conn.setSessionModel(sessionId, c.id).catch(() => {});
                      }}
                    >
                      {/* 2026-10-24 用户裁定:弹层标当前选中模型(✓+强调色) */}
                      {baseModelName(c.id)}
                    </button>
                  ))}
                  {/* G14.14:强度滑块与欢迎页同一渲染(EffortSlider 共享) */}
                  <EffortSlider
                    value={sessEffort ?? 'medium'}
                    onChange={(ev) => {
                      setSessEffort(ev);
                      // 乐观置选;失败不回滚(同 model 口径)
                      conn.setSessionEffort(sessionId, ev).catch(() => {});
                    }}
                  />
                </div>
              )}
            </div>
            {/* G14.89 运行中输入框有内容 → 显示发送(入队)而非停止;空输入才是停止 */}
            {running && input.trim() === '' ? (
              <button type="button" className="send" aria-label="stop" data-tip={t('Stop', '停止')} onClick={interrupt}>
                <Square size={12} strokeWidth={2.5} aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className={`send tip-right${sendLoading === true ? ' loading' : ''}`}
                aria-label="send"
                data-tip={`${t('Send', '发送')} · Enter`}
                onClick={send}
                disabled={connState !== 'open' || seeding || sendLoading === true}
              >
                {sendLoading === true ? (
                  /* 2026-10-29 用户裁定:loading 用真转圈(run-spinner 环,与运行态同语言)——箭头自转观感滑稽 */
                  <span className="run-spinner" aria-hidden="true" />
                ) : (
                  <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />
                )}
              </button>
            )}
          </div>
  );
}

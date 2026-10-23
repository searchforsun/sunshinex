import { ArrowUp, ChevronDown, ListTodo, ShieldCheck, Square, Unlock } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { t } from '../../i18n';
import { ContextRing } from '../../context-ring';
import { EffortChip, EffortSlider } from '../../effort-slider';
import type { Connection, ConnectionState } from '../../connection';
import { baseModelName } from './EntryViews';
import { PlusAddIcon } from '../../sidebar/project-menu-util';
// ModeIcon 值回引宿主(调用期解绑,EntryViews 同款先例;Chat 原路径再导出保 WelcomeComposer 消费)
import { ModeIcon } from '../Chat';

/** composer 双 pill 簇(D32 第六批批F-1 自 Chat.tsx 平移,行为零变化):左=+附加面板/审批模式,
 *  右=上下文圆环/模型·强度 pill/发送·停止。开关态与动作回调 props 注入(setter 用 React
 *  Dispatch 原形,体逐字平移)。 */

interface PillsLeftProps {
  readonly pillOpen: 'mode' | 'model' | 'plus' | null;
  readonly setPillOpen: Dispatch<SetStateAction<'mode' | 'model' | 'plus' | null>>;
  readonly sessMode: 'dontAsk' | 'manual' | 'plan';
  readonly setSessMode: Dispatch<SetStateAction<'dontAsk' | 'manual' | 'plan'>>;
  readonly conn: Connection;
  readonly sessionId: string;
}

export function ComposerPillsLeft(props: PillsLeftProps): JSX.Element {
  const { pillOpen, setPillOpen, sessMode, setSessMode, conn, sessionId } = props;
  return (
          <div className="composer-pills">
            {/* 与欢迎页同构(G12 三轮):+ 开附加面板(卡顶同宽浮层:命令/技能/文件) */}
            <button
              type="button"
              className="composer-pill composer-plus-btn"
              aria-label="add attachment"
              aria-expanded={pillOpen === 'plus'}
              data-tip={t('Add skills, commands or files', '添加技能、命令或文件')}
              onClick={() => setPillOpen((v) => (v === 'plus' ? null : 'plus'))}
            >
              <PlusAddIcon size={16} />
            </button>
            {/* 审批模式:弹层锚按钮正上方(pill-anchor) */}
            <div className="pill-anchor">
              <button
                type="button"
                className="composer-pill"
                aria-label="session mode"
                aria-expanded={pillOpen === 'mode'}
                data-tip={sessMode === 'plan' ? t('Plan mode', '计划模式') : sessMode === 'manual' ? t('Confirm changes', '变更确认') : t('Full access', '完全访问')}
                onClick={() => setPillOpen((v) => (v === 'mode' ? null : 'mode'))}
              >
                <ModeIcon mode={sessMode} />
                {/* 2026-10-24 用户裁定:主栏窄于阈值时标签/箭头 CSS 塌缩(sx-main-narrow),纯图标+tooltip 承载文案 */}
                <span className="pill-label">{sessMode === 'plan' ? t('Plan mode', '计划模式') : sessMode === 'manual' ? t('Confirm changes', '变更确认') : t('Full access', '完全访问')}</span>
                <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" className="pill-chevron" />
              </button>
              {pillOpen === 'mode' && (
                <div className="sx-menu-pop pill-pop mode-pop" role="menu" aria-label="session mode menu">
                  {([
                    { m: 'plan' as const, label: t('Plan mode', '计划模式'), desc: t('Plan first — no changes until you approve', '先规划方案,经你确认后才执行'), icon: <ListTodo size={15} strokeWidth={1.75} aria-hidden="true" /> },
                    { m: 'dontAsk' as const, label: t('Full access', '完全访问'), desc: t('Full permissions — no confirmation prompts', '完全权限,操作不再逐一确认'), icon: <Unlock size={15} strokeWidth={1.75} aria-hidden="true" /> },
                    { m: 'manual' as const, label: t('Confirm changes', '变更确认'), desc: t('Writes and commands ask first', '写入与命令需逐一确认'), icon: <ShieldCheck size={15} strokeWidth={1.75} aria-hidden="true" /> },
                  ]).map((row, idx) => (
                    <div key={row.m} className="mode-pop-group">
                      {idx === 1 && <div className="mode-pop-sep" />}
                      <button
                        type="button"
                        role="menuitem"
                        className={`mode-item${sessMode === row.m ? ' active' : ''}`}
                        onClick={() => {
                          setPillOpen(null);
                          setSessMode(row.m);
                          // 乐观置选;失败不回滚——模式属会话级低危偏好,权威态经下次会话快照/事件回填自纠
                          conn.setSessionMode(sessionId, row.m).catch(() => {});
                        }}
                      >
                        <span className="mode-item-icon">{row.icon}</span>
                        <span className="mode-item-body">
                          <span className="mode-item-name">{row.label}</span>
                          <span className="mode-item-desc">{row.desc}</span>
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
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
  readonly modelInfo: { current?: string; choices: Array<{ id: string; model: string; effort?: string }> } | null;
  readonly setModelInfo: Dispatch<SetStateAction<{ current?: string; choices: Array<{ id: string; model: string; effort?: string }> } | null>>;
  readonly sessEffort: string | undefined;
  readonly setSessEffort: Dispatch<SetStateAction<string | undefined>>;
  readonly running: boolean;
  readonly input: string;
  readonly send: () => void;
  readonly interrupt: () => void;
  readonly connState: ConnectionState;
  readonly seeding: boolean;
}

export function ComposerPillsRight(props: PillsRightProps): JSX.Element {
  const { pillOpen, setPillOpen, conn, sessionId, ctxInfo, refreshCtx, runCount, steps, tokens, cacheTokens, modelInfo, setModelInfo, sessEffort, setSessEffort, running, input, send, interrupt, connState, seeding } = props;
  return (
          <div className="composer-pills composer-pills-right">
            {/* G14.18 上下文圆环:模型 pill 左侧,hover 弹上下文占用/构成明细/轮次步数/tokens/缓存 */}
            <ContextRing
              used={ctxInfo?.total ?? 0}
              window={ctxInfo?.window ?? 0}
              parts={ctxInfo?.parts ?? []}
              runs={runCount}
              steps={steps}
              tokens={tokens}
              cacheTokens={cacheTokens}
              onOpen={refreshCtx}
            />
            {/* 模型 pill:显示实际模型名(剥 provider 前缀);菜单=模型列表+思考强度,锚按钮正上方,
                选中不收口(一连选模型+强度,外点/再点收) */}
            <div className="pill-anchor">
              <button
                type="button"
                className="composer-pill"
                aria-label="session model"
                aria-expanded={pillOpen === 'model'}
                onClick={() => setPillOpen((v) => (v === 'model' ? null : 'model'))}
              >
                <span className="pill-label">{baseModelName(modelInfo?.current)}</span>
                {/* 思考强度随名(G13 反馈轮):`模型 · effort` 同 pill,Codex 同形 */}
                <EffortChip effort={sessEffort ?? 'medium'} />
                <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {pillOpen === 'model' && (
                <div className="sx-menu-pop pill-pop pill-pop-right pill-pop-tall" role="menu" aria-label="session model menu">
                  {(modelInfo?.choices ?? []).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="menuitem"
                      className={`sx-menuitem${baseModelName(c.id) === baseModelName(modelInfo?.current) ? ' current' : ''}`}
                      disabled={c.id === modelInfo?.current}
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
                className="send tip-right"
                aria-label="send"
                data-tip={t('Send', '发送')}
                onClick={send}
                disabled={connState !== 'open' || seeding}
              >
                <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />
              </button>
            )}
          </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, Folder } from 'lucide-react';
import { t } from '../i18n';
import { errText, pathBasename } from '../ui-util';
import { usePopOutsideClose } from '../use-pop-outside-close';
import { useWelcomeWorkspaces } from '../welcome/use-welcome-workspaces';
import { WelcomeProjectPop } from '../welcome/welcome-project-pop';
import { DirPicker } from '../pages/DirPicker';
import { baseModelName, ModeIcon } from '../pages/Chat';
import { ComposerCard } from '../composer/ComposerCard';
import { EffortChip, EffortSlider, effortLabel } from '../effort-slider';
import { ModeMenu, sessionModeLabel } from '../composer/mode-menu';
import { Select } from '../settings/controls';
import type { SelectOption } from '../settings/controls';
import type { Connection, ScheduleDraft, ScheduleJobView, ScheduleMode } from '../connection';
import { CADENCE_OPTIONS, buildWhen, pad2, weekdayLabel, weekdayListLabel, whenOf, whenSummary } from './cycle';
import type { ScheduleCadence, ScheduleWhen } from './cycle';

/**
 * 定时任务配置页（2026-11-20 用户裁定第二版）：上下布局三段——任务标题 / 调度一行 / 指令。
 * - 调度不再有开始时间：周期下拉（每小时/每天/每周/每月）+ 该周期自己的时间控件
 *   （小时=分钟选择、天/周/月=时:分；周=星期多选；月=日选择），下拉/多选全部项目自绘
 *   （settings Select + sx-dd 弹层语言），不用原生 select/date 控件。
 * - 指令完全复用对话输入框：工作区 pill（不再放「＋」）/权限弹窗/模型名/强度都收在底部 dock；
 *   模型名只读（定时执行使用应用当前默认模型），强度可调；保存钮移到页头右上角。
 * - 编辑既有非四档任务（分钟/年/多倍 every）保留 custom，原 recurrence 原样带回。
 */
export interface ScheduleConfigProps {
  readonly conn: Connection;
  readonly job?: ScheduleJobView;
  readonly defaultModel: string;
  readonly onSaved: (job: ScheduleJobView) => void;
  readonly onBack: () => void;
}

const HOUR_OPTIONS: SelectOption[] = Array.from({ length: 24 }, (_, i) => ({ v: pad2(i), l: pad2(i) }));
const MINUTE_OPTIONS: SelectOption[] = Array.from({ length: 60 }, (_, i) => ({ v: pad2(i), l: pad2(i) }));
const DAY_OPTIONS: SelectOption[] = Array.from({ length: 31 }, (_, i) => ({ v: String(i + 1), l: String(i + 1) }));

/** 时/分两枚自绘下拉（项目 sx-dd 语言）；hourly 只用分钟，daily/weekly/monthly 用两枚 */
function TimeSelects({
  hour,
  minute,
  onHour,
  onMinute,
}: {
  hour: number;
  minute: number;
  onHour: (v: number) => void;
  onMinute: (v: number) => void;
}): JSX.Element {
  return (
    <span className="sx-schedule-time" role="group" aria-label={t('Time', '时间')}>
      <Select
        className="sx-schedule-dd sx-schedule-dd-num"
        value={pad2(hour)}
        options={HOUR_OPTIONS}
        ariaLabel={t('Hour', '小时')}
        onChange={(v) => onHour(Number(v))}
      />
      <span className="sx-schedule-time-colon" aria-hidden="true">:</span>
      <Select
        className="sx-schedule-dd sx-schedule-dd-num"
        value={pad2(minute)}
        options={MINUTE_OPTIONS}
        ariaLabel={t('Minute', '分钟')}
        onChange={(v) => onMinute(Number(v))}
      />
    </span>
  );
}

/** 星期多选（sx-dd 弹层语言；至少保留一天——空集在保存面会被拦，这里直接不让清空） */
function WeekdaySelect({ value, onChange }: { value: number[]; onChange: (days: number[]) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const label = weekdayListLabel(value);
  return (
    <div className="sx-dd sx-schedule-dd sx-schedule-weekdays" ref={wrapRef}>
      <button
        type="button"
        className="sx-dd-trigger"
        aria-label={t('Weekdays', '星期')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sx-dd-value">{t(label.en, label.zh)}</span>
        <span className={`sx-dd-chevron${open ? ' up' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <ul className="sx-dd-pop sx-schedule-weekday-pop" role="listbox" aria-multiselectable="true" aria-label={t('Weekdays', '星期')}>
          {[1, 2, 3, 4, 5, 6, 7].map((d) => {
            const on = value.includes(d);
            const lab = weekdayLabel(d);
            return (
              <li key={d}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`sx-dd-opt${on ? ' active' : ''}`}
                  onClick={() => {
                    const next = on ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => a - b);
                    if (next.length > 0) onChange(next);
                  }}
                >
                  <span className="sx-dd-opt-label">{t(lab.en, lab.zh)}</span>
                  {on && <span className="sx-dd-opt-check" aria-hidden="true">✓</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ScheduleConfig({ conn, job, defaultModel, onSaved, onBack }: ScheduleConfigProps): JSX.Element {
  const initialWhen = useMemo(() => whenOf(job), [job]);
  const [when, setWhen] = useState<ScheduleWhen>(initialWhen);
  const [name, setName] = useState(job?.name ?? t('Untitled scheduled task', '未命名定时任务'));
  const [prompt, setPrompt] = useState(job?.prompt ?? '');
  const [effort, setEffort] = useState(job?.effort ?? 'medium');
  const [mode, setMode] = useState<ScheduleMode>(job?.mode ?? 'full-access');
  const [picked, setPicked] = useState(job?.root ?? '');
  const [projOpen, setProjOpen] = useState(false);
  const [projQuery, setProjQuery] = useState('');
  const [hint, setHint] = useState('');
  const [dirOpen, setDirOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nextPreview, setNextPreview] = useState<number | null>(null);
  const projRef = useRef<HTMLDivElement>(null);

  /** 编辑态根权威：workspaces 清单可能不含任务原 root——把 job.root 合成一行喂给 hook，
   *  用户显式改选前恒保持原 root，rename-only 不改落点 */
  const wsConn = useMemo(() => {
    const heldRoot = job?.root;
    if (heldRoot === undefined || heldRoot === '') return conn;
    return {
      workspaces: async (): Promise<Array<{ slug: string; root?: string; sessionCount: number }>> => {
        const list = await conn.workspaces();
        return list.some((r) => r.root === heldRoot) ? list : [...list, { slug: heldRoot, root: heldRoot, sessionCount: 0 }];
      },
      createWorkspace: conn.createWorkspace,
      locateWorkspace: conn.locateWorkspace,
      onConfigChanged: conn.onConfigChanged,
    };
  }, [conn, job?.root]);
  const { rows, browseFolder, registerFolder } = useWelcomeWorkspaces(wsConn, job?.root, 0, {
    setPicked,
    setProjOpen,
    setHint,
    setDirOpen,
  });
  usePopOutsideClose(projOpen, '.proj-pop', '.sx-schedule-ws-anchor', () => setProjOpen(false));
  usePopOutsideClose(effortOpen, '.sx-schedule-effort-pop', '.sx-schedule-effort-pill', () => setEffortOpen(false));
  usePopOutsideClose(modeOpen, '.mode-pop', '.sx-schedule-mode-pill', () => setModeOpen(false));

  const summary = whenSummary(when);
  const wsLabel = useMemo(() => {
    const r = picked.trim();
    if (r === '' || r === 'default') return t('Default workspace', '默认工作区');
    const b = pathBasename(r);
    return b === 'default' || b.startsWith('sunshinex-default') ? t('Default workspace', '默认工作区') : b;
  }, [picked]);
  const customSrc = job !== undefined ? { recurrence: job.recurrence, startAt: job.startAt } : undefined;

  // 预览（250ms 防抖）：调度态任一变更即按同一 buildWhen 计算下一次触发；不是每日新算 now 的锚，
  // 只影响 hourly 的相位时刻——engine 会自行快进到未来最近一次
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      const built = buildWhen(when, Date.now(), customSrc);
      conn.previewSchedule({ recurrence: built.recurrence, startAt: built.startAt }).then(
        (r) => {
          if (alive) setNextPreview(r.next[0] ?? null);
        },
        () => {
          if (alive) setNextPreview(null);
        },
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // customSrc 由 job 派生，job 在挂载期内稳定（SchedulePage 按 id 重挂配置页）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, when]);

  const save = (): void => {
    if (busy) return;
    if (name.trim() === '') {
      setError(t('Task title is required', '任务标题必填'));
      return;
    }
    if (prompt.trim() === '') {
      setError(t('Instruction is required', '指令必填'));
      return;
    }
    if (when.cadence === 'weekly' && when.weekdays.length === 0) {
      setError(t('Pick at least one weekday', '至少选择一个星期'));
      return;
    }
    setBusy(true);
    setError('');
    const built = buildWhen(when, Date.now(), customSrc);
    const body: ScheduleDraft = {
      name: name.trim(),
      prompt: prompt.trim(),
      root: picked.trim() === '' ? 'default' : picked.trim(),
      effort,
      mode,
      recurrence: built.recurrence,
      startAt: built.startAt,
      // 新 UI 不再暴露截止；custom 编辑保留既有 until（不静默丢）
      ...(when.cadence === 'custom' && job?.until !== undefined ? { until: job.until } : {}),
    };
    const p = job !== undefined ? conn.updateSchedule(job.id, body) : conn.createSchedule(body);
    p.then(
      (savedJob) => {
        setBusy(false);
        onSaved(savedJob);
      },
      (e: unknown) => {
        setBusy(false);
        setError(errText(e));
      },
    );
  };

  // Esc 层级：本面弹层（工作区/强度/权限/DirPicker）先收，不连带退页；Select 自己的 Esc 在弹层内收
  useEffect(() => {
    if (!projOpen && !effortOpen && !modeOpen && !dirOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setProjOpen(false);
      setEffortOpen(false);
      setModeOpen(false);
      setDirOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [projOpen, effortOpen, modeOpen, dirOpen]);

  const nextLabel = nextPreview !== null ? new Date(nextPreview).toLocaleString() : '—';
  const modelLabel = defaultModel !== '' ? baseModelName(defaultModel) : t('Default model', '默认模型');

  return (
    <div className="sx-schedule-editor">
      <div className="sx-schedule-editor-head">
        <div className="sx-schedule-editor-heading">
          <button type="button" className="sx-schedule-back" onClick={onBack}>
            <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
            {t('Back', '返回')}
          </button>
          <h1 className="sx-schedule-title">{job !== undefined ? t('Edit scheduled task', '编辑定时任务') : t('New scheduled task', '新建定时任务')}</h1>
        </div>
        <button type="button" className="sx-schedule-save" disabled={busy} onClick={save}>
          {job !== undefined ? t('Save', '保存') : t('Create', '创建')}
        </button>
      </div>

      {error !== '' && (
        <p className="sx-schedule-error" role="alert">
          {error}
        </p>
      )}

      <div className="sx-schedule-field">
        <label className="sx-schedule-field-label" htmlFor="sx-schedule-name">
          {t('Task title', '任务标题')}
        </label>
        <input
          id="sx-schedule-name"
          className="sx-schedule-name-input"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </div>

      <div className="sx-schedule-field">
        <span className="sx-schedule-field-label">{t('Schedule', '调度')}</span>
        <div className="sx-schedule-when" role="group" aria-label={t('Schedule', '调度')}>
          <Select
            className="sx-schedule-dd sx-schedule-dd-unit"
            value={when.cadence}
            options={[
              ...CADENCE_OPTIONS.map((o) => ({ v: o.id, l: t(o.label.en, o.label.zh) })),
              ...(when.cadence === 'custom' ? [{ v: 'custom', l: t('Custom (keep)', '自定义（沿用）') }] : []),
            ]}
            ariaLabel={t('Repeat', '周期')}
            onChange={(v) => setWhen((w) => ({ ...w, cadence: v as ScheduleCadence }))}
          />
          {when.cadence === 'hourly' && (
            <>
              <span className="sx-schedule-when-inline">{t('at minute', '第')}</span>
              <Select
                className="sx-schedule-dd sx-schedule-dd-num"
                value={pad2(when.minute)}
                options={MINUTE_OPTIONS}
                ariaLabel={t('Minute', '分钟')}
                onChange={(v) => setWhen((w) => ({ ...w, minute: Number(v) }))}
              />
              <span className="sx-schedule-when-inline">{t('past the hour', '分钟')}</span>
            </>
          )}
          {when.cadence === 'daily' && (
            <TimeSelects
              hour={when.hour}
              minute={when.minute}
              onHour={(v) => setWhen((w) => ({ ...w, hour: v }))}
              onMinute={(v) => setWhen((w) => ({ ...w, minute: v }))}
            />
          )}
          {when.cadence === 'weekly' && (
            <>
              <WeekdaySelect value={when.weekdays} onChange={(days) => setWhen((w) => ({ ...w, weekdays: days }))} />
              <TimeSelects
                hour={when.hour}
                minute={when.minute}
                onHour={(v) => setWhen((w) => ({ ...w, hour: v }))}
                onMinute={(v) => setWhen((w) => ({ ...w, minute: v }))}
              />
            </>
          )}
          {when.cadence === 'monthly' && (
            <>
              <Select
                className="sx-schedule-dd sx-schedule-dd-day"
                value={String(when.dayOfMonth)}
                options={DAY_OPTIONS}
                ariaLabel={t('Day of month', '日')}
                onChange={(v) => setWhen((w) => ({ ...w, dayOfMonth: Number(v) }))}
              />
              <span className="sx-schedule-when-inline">{t('day', '日')}</span>
              <TimeSelects
                hour={when.hour}
                minute={when.minute}
                onHour={(v) => setWhen((w) => ({ ...w, hour: v }))}
                onMinute={(v) => setWhen((w) => ({ ...w, minute: v }))}
              />
            </>
          )}
          {when.cadence === 'custom' && <span className="sx-schedule-when-inline">{t('Custom cadence kept', '沿用原有自定义周期')}</span>}
        </div>
        <p className="sx-schedule-hint">
          {t(summary.en, summary.zh)} · {t('Next', '接下来')} {nextLabel}
        </p>
      </div>

      <div className="sx-schedule-field">
        <span className="sx-schedule-field-label">{t('Instruction', '指令')}</span>
        <ComposerCard
          label={t('Instruction', '指令')}
          value={prompt}
          onChange={setPrompt}
          placeholder={t(
            'e.g. Review commits from the last 24 hours, summarize possible bugs and fixes',
            '例如：检查最近 24 小时的提交，总结可能引入的问题和修复建议',
          )}
          rows={4}
          onKeyDown={() => undefined}
          className="sx-schedule-instruction"
          footLeft={
            <>
              <div className="pill-anchor sx-schedule-ws-anchor">
                <button
                  type="button"
                  className="composer-pill"
                  aria-label={t('Workspace', '工作区')}
                  aria-expanded={projOpen}
                  onClick={() => {
                    setProjQuery('');
                    setProjOpen((v) => !v);
                  }}
                >
                  <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span className="pill-label">{wsLabel}</span>
                  <ChevronDown className="pill-chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
                </button>
                {projOpen && (
                  <WelcomeProjectPop
                    rows={rows}
                    picked={picked}
                    query={projQuery}
                    onQuery={setProjQuery}
                    onPick={(root) => {
                      setPicked(root);
                      setProjOpen(false);
                    }}
                    onBrowse={() => void browseFolder()}
                    hint={hint}
                    projRef={projRef}
                  />
                )}
                {dirOpen && (
                  <div className="modal-overlay" onClick={() => setDirOpen(false)}>
                    <div className="modal-body" onClick={(e) => e.stopPropagation()}>
                      <DirPicker conn={conn} showManual={false} onCancel={() => setDirOpen(false)} onConfirm={registerFolder} />
                    </div>
                  </div>
                )}
              </div>
              <div className="pill-anchor">
                <button
                  type="button"
                  className={`composer-pill sx-schedule-mode-pill${mode === 'full-access' ? ' mode-pill-warn' : ''}`}
                  aria-label="approval mode"
                  aria-expanded={modeOpen}
                  data-tip={sessionModeLabel(mode)}
                  onClick={() => setModeOpen((v) => !v)}
                >
                  <ModeIcon mode={mode} />
                  <span className="pill-label">{sessionModeLabel(mode)}</span>
                  <ChevronDown className="pill-chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
                </button>
                {modeOpen && (
                  <ModeMenu
                    mode={mode}
                    allowPlan={false}
                    ariaLabel="approval mode menu"
                    onPick={(m) => {
                      if (m !== 'plan') setMode(m);
                      setModeOpen(false);
                    }}
                  />
                )}
              </div>
            </>
          }
          footRight={
            <>
              <span
                className="composer-pill sx-schedule-model-static"
                data-tip={t('Scheduled runs use the app default model', '定时执行使用应用当前默认模型')}
              >
                {modelLabel}
              </span>
              <div className="pill-anchor">
                <button
                  type="button"
                  className="composer-pill sx-schedule-effort-pill"
                  aria-label={t('Effort', '强度')}
                  aria-expanded={effortOpen}
                  data-tip={`${t('Thinking effort', '思考强度')}: ${effortLabel(effort)}`}
                  onClick={() => setEffortOpen((v) => !v)}
                >
                  <EffortChip effort={effort} />
                  <ChevronDown className="pill-chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
                </button>
                {effortOpen && (
                  <div className="sx-menu-pop pill-pop pill-pop-right sx-schedule-effort-pop">
                    <EffortSlider value={effort} onChange={setEffort} />
                  </div>
                )}
              </div>
            </>
          }
        />
      </div>
    </div>
  );
}

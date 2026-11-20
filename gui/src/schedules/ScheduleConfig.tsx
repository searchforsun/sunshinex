import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Calendar, ChevronDown, ChevronLeft, ChevronRight, Folder } from 'lucide-react';
import { t } from '../i18n';
import { errText, pathBasename } from '../ui-util';
import { usePopOutsideClose } from '../use-pop-outside-close';
import { useWelcomeWorkspaces } from '../welcome/use-welcome-workspaces';
import { WelcomeProjectPop } from '../welcome/welcome-project-pop';
import { DirPicker } from '../pages/DirPicker';
import { baseModelName, ModeIcon } from '../pages/Chat';
import { ComposerCard } from '../composer/ComposerCard';
import { EffortChip } from '../effort-slider';
import { WelcomeModelMenu } from '../welcome/welcome-model-menu';
import { ModeMenu, sessionModeLabel } from '../composer/mode-menu';
import { Select } from '../settings/controls';
import type { SelectOption } from '../settings/controls';
import type { Connection, ScheduleDraft, ScheduleJobView, ScheduleMode } from '../connection';
import { CADENCE_OPTIONS, buildWhen, formatStamp, pad2, weekdayLabel, weekdayListLabel, whenOf, whenSummary } from './cycle';
import type { ScheduleCadence, ScheduleWhen } from './cycle';

/**
 * 定时任务配置页（2026-11-20 用户裁定第二版）：上下布局三段——标题 / 调度一行 / 指令。
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


/** 截止时间选择（2026-11-20 用户裁定「调度行右侧加上截止时间；日期选择用本项目格式，不用原生」）：
 *  自绘月历 + 时/分下拉；trigger 恒在调度行右端（margin-left:auto）。无值=「无截止」，
 *  选日/改时刻即时回写 until；清空回 undefined。过去日期禁用，今天可选（时刻合法性由保存面兜底）。 */
function DeadlinePicker({ value, onChange }: { value: number | undefined; onChange: (v: number | undefined) => void }): JSX.Element {
  const initial = value !== undefined ? new Date(value) : new Date();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ y: number; m: number }>({ y: initial.getFullYear(), m: initial.getMonth() });
  const [hour, setHour] = useState(value !== undefined ? new Date(value).getHours() : 23);
  const [minute, setMinute] = useState(value !== undefined ? new Date(value).getMinutes() : 59);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
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
  // 外部值变化（编辑态初值/清空）同步月视图与时刻
  useEffect(() => {
    if (value === undefined) return;
    const d = new Date(value);
    setHour(d.getHours());
    setMinute(d.getMinutes());
    setView({ y: d.getFullYear(), m: d.getMonth() });
  }, [value]);
  const setTime = (h: number, m: number): void => {
    setHour(h);
    setMinute(m);
    if (value !== undefined) {
      const d = new Date(value);
      d.setHours(h, m, 0, 0);
      onChange(d.getTime());
    }
  };
  const cells = useMemo(() => {
    const first = new Date(view.y, view.m, 1);
    const lead = (first.getDay() + 6) % 7; // 周一为首列
    const days = new Date(view.y, view.m + 1, 0).getDate();
    const arr: Array<number | null> = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= days; d += 1) arr.push(d);
    while (arr.length % 7 !== 0) arr.push(null);
    return arr;
  }, [view]);
  const selected = value !== undefined ? new Date(value) : undefined;
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  const label = value !== undefined ? `${t('Until', '截至')} ${formatStamp(value)}` : t('No deadline', '无截止');
  return (
    <div className="sx-schedule-deadline-anchor" ref={rootRef}>
      <button
        type="button"
        className="composer-pill sx-schedule-deadline-pill"
        aria-label={t('Deadline', '截止时间')}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip={label}
        onClick={() => setOpen((v) => !v)}
      >
        <Calendar size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="pill-label">{label}</span>
        <ChevronDown className="pill-chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div className="sx-menu-pop sx-schedule-deadline-pop" role="dialog" aria-label={t('Deadline', '截止时间')}>
          <div className="sx-deadline-head">
            <button type="button" className="sx-iconbtn" aria-label={t('Previous month', '上个月')} onClick={() => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }))}>
              <ChevronLeft size={16} strokeWidth={1.75} />
            </button>
            <span className="sx-deadline-month">{t(`${view.y}-${pad2(view.m + 1)}`, `${view.y} 年 ${view.m + 1} 月`)}</span>
            <button type="button" className="sx-iconbtn" aria-label={t('Next month', '下个月')} onClick={() => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }))}>
              <ChevronRight size={16} strokeWidth={1.75} />
            </button>
            <button type="button" className={`sx-deadline-clear${value === undefined ? ' is-active' : ''}`} onClick={() => onChange(undefined)}>
              {t('No deadline', '无截止')}
            </button>
          </div>
          <div className="sx-deadline-week">
            {[1, 2, 3, 4, 5, 6, 7].map((d) => {
              const lab = weekdayLabel(d);
              return <span key={d}>{t(lab.en, lab.zh)}</span>;
            })}
          </div>
          <div className="sx-deadline-grid">
            {cells.map((day, i) => {
              if (day === null) return <span key={`b${i}`} className="sx-deadline-day is-blank" />;
              const key = `${view.y}-${pad2(view.m + 1)}-${pad2(day)}`;
              const isSel = selected !== undefined && selected.getFullYear() === view.y && selected.getMonth() === view.m && selected.getDate() === day;
              const isPast = new Date(view.y, view.m, day).getTime() < new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
              return (
                <button
                  key={key}
                  type="button"
                  className={`sx-deadline-day${isSel ? ' is-selected' : ''}${key === todayKey ? ' is-today' : ''}`}
                  aria-label={key}
                  disabled={isPast}
                  onClick={() => onChange(new Date(view.y, view.m, day, hour, minute, 0, 0).getTime())}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <div className="sx-deadline-time">
            <span className="sx-schedule-when-inline">{t('Time', '时间')}</span>
            <Select className="sx-schedule-dd sx-schedule-dd-num" value={pad2(hour)} options={HOUR_OPTIONS} ariaLabel={t('Deadline hour', '截止小时')} onChange={(v) => setTime(Number(v), minute)} />
            <span className="sx-schedule-time-colon" aria-hidden="true">:</span>
            <Select className="sx-schedule-dd sx-schedule-dd-num" value={pad2(minute)} options={MINUTE_OPTIONS} ariaLabel={t('Deadline minute', '截止分钟')} onChange={(v) => setTime(hour, Number(v))} />
          </div>
        </div>
      )}
    </div>
  );
}

export function ScheduleConfig({ conn, job, defaultModel, onSaved, onBack }: ScheduleConfigProps): JSX.Element {
  const initialWhen = useMemo(() => whenOf(job), [job]);
  const [when, setWhen] = useState<ScheduleWhen>(initialWhen);
  const [until, setUntil] = useState<number | undefined>(job?.until);
  const [name, setName] = useState(job?.name ?? t('Untitled scheduled task', '未命名定时任务'));
  const [prompt, setPrompt] = useState(job?.prompt ?? '');
  const [effort, setEffort] = useState(job?.effort ?? 'medium');
  const [model, setModel] = useState<string | undefined>(job?.model);
  const [modelChoices, setModelChoices] = useState<Array<{ id: string; effort?: string }>>([]);
  const [mode, setMode] = useState<ScheduleMode>(job?.mode ?? 'full-access');
  const [picked, setPicked] = useState(job?.root ?? '');
  const [projOpen, setProjOpen] = useState(false);
  const [projQuery, setProjQuery] = useState('');
  const [hint, setHint] = useState('');
  const [dirOpen, setDirOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
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
  usePopOutsideClose(modelOpen, '.sx-schedule-model-pop', '.sx-schedule-model-pill', () => setModelOpen(false));
  usePopOutsideClose(modeOpen, '.mode-pop', '.sx-schedule-mode-pill', () => setModeOpen(false));

  // 模型清单（与输入框同一个 WelcomeModelMenu 数据源；旧桩无 settings 时留空，pill 回显 defaultModel）
  useEffect(() => {
    if (typeof conn.settings !== 'function') return;
    conn.settings().then(
      (v) => setModelChoices(v.providers.choices),
      () => undefined,
    );
  }, [conn]);
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
      conn.previewSchedule({ recurrence: built.recurrence, startAt: built.startAt, ...(until !== undefined ? { until } : {}) }).then(
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
  }, [conn, when, until]);

  // 保存/创建钮仅在两必填项齐备时可点（2026-11-20 用户裁定：指令与调度都填了之后才能保存）
  const canSave = prompt.trim() !== '' && (when.cadence !== 'weekly' || when.weekdays.length > 0);

  const save = (): void => {
    if (busy) return;
    const built = buildWhen(when, Date.now(), customSrc);
    if (name.trim() === '') {
      setError(t('Title is required', '标题必填'));
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
    if (until !== undefined && until <= built.startAt) {
      setError(t('Deadline must be after the start', '截止时间必须晚于开始'));
      return;
    }
    setBusy(true);
    setError('');
    const body: ScheduleDraft = {
      name: name.trim(),
      prompt: prompt.trim(),
      root: picked.trim() === '' ? 'default' : picked.trim(),
      ...(model !== undefined ? { model } : {}),
      effort,
      mode,
      recurrence: built.recurrence,
      startAt: built.startAt,
      ...(until !== undefined ? { until } : {}),
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
    if (!projOpen && !modelOpen && !modeOpen && !dirOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setProjOpen(false);
      setModelOpen(false);
      setModeOpen(false);
      setDirOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [projOpen, modelOpen, modeOpen, dirOpen]);

  const nextLabel = nextPreview !== null ? new Date(nextPreview).toLocaleString() : '—';

  return (
    <div className="sx-schedule-editor">
      <div className="sx-schedule-editor-head">
        {/* 大标题独占一行（2026-11-20 用户裁定）：返回与保存/创建在下一行 */}
        <h1 className="sx-schedule-title">{job !== undefined ? t('Edit scheduled task', '编辑定时任务') : t('New scheduled task', '新建定时任务')}</h1>
        <div className="sx-schedule-editor-sub">
          <button type="button" className="sx-schedule-back" onClick={onBack}>
            <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
            {t('Back', '返回')}
          </button>
          <button type="button" className="sx-schedule-save" disabled={busy || !canSave} onClick={save}>
            {job !== undefined ? t('Save', '保存') : t('Create', '创建')}
          </button>
        </div>
      </div>

      {error !== '' && (
        <p className="sx-schedule-error" role="alert">
          {error}
        </p>
      )}

      <div className="sx-schedule-field sx-schedule-title-field">
        <label className="sx-schedule-field-label" htmlFor="sx-schedule-name">
          {t('Title', '标题')}
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
          <DeadlinePicker value={until} onChange={setUntil} />
        </div>
        <p className="sx-schedule-hint">
          {t(summary.en, summary.zh)} · {t('Next', '接下来')} {nextLabel}
          {until !== undefined ? ` · ${t('Until', '截至')} ${formatStamp(until)}` : ''}
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
            /* 与输入框同一枚模型 pill（模型名 + 强度 chip + 同一 WelcomeModelMenu 弹层）：
               2026-11-20 用户裁定「模型选择和思考强度完全使用输入框的，不要分开」 */
            <div className="pill-anchor">
              <button
                type="button"
                className="composer-pill model-pill sx-schedule-model-pill"
                aria-label="model"
                aria-expanded={modelOpen}
                data-tip={model ?? defaultModel ?? modelChoices[0]?.id}
                onClick={() => setModelOpen((v) => !v)}
              >
                {baseModelName(model ?? defaultModel ?? modelChoices[0]?.id)}
                <EffortChip effort={effort} />
                <ChevronDown className="pill-chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {modelOpen && (
                <WelcomeModelMenu
                  className="sx-schedule-model-pop"
                  choices={modelChoices}
                  current={model ?? defaultModel}
                  effort={effort}
                  onPick={(id, e) => {
                    setModel(id);
                    if (e !== undefined) setEffort(e);
                  }}
                  onEffort={setEffort}
                />
              )}
            </div>
          }
        />
      </div>
    </div>
  );
}

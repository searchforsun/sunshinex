import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Folder, Plus } from 'lucide-react';
import { t } from '../i18n';
import { errText, pathBasename } from '../ui-util';
import { usePopOutsideClose } from '../use-pop-outside-close';
import { useWelcomeWorkspaces } from '../welcome/use-welcome-workspaces';
import { WelcomeProjectPop } from '../welcome/welcome-project-pop';
import { DirPicker } from '../pages/DirPicker';
import { ComposerCard } from '../composer/ComposerCard';
import { EffortSlider, effortLabel } from '../effort-slider';
import type { Connection, ScheduleDraft, ScheduleJobView, ScheduleMode } from '../connection';
import { CYCLE_OPTIONS, cycleOf, recurrenceOf } from './cycle';
import type { ScheduleCycle } from '../connection';

/**
 * 定时任务三行配置页(scheduled-tasks Task 8,spec §12):
 * 名称 / 调度(周期+开始锚点+无截止+截止, hint=预览) / 任务(ComposerCard)。
 * 底 dock 复用欢迎页语言:工作区 pill(useWelcomeWorkspaces 单点)+＋浏览+模型 pill(强度 chip
 * 挂在模型 pill 内,不另设强度 pill)+权限 pill+保存。无 footer/无预览卡——页面顶栏即取消。
 * 编辑态(job 在场)全字段预填并以 updateSchedule 保存;新建走 createSchedule。rec 由
 * recurrenceOf(cycle, startAt) 单点映射,startAt 是锚点。时间恒本地,due 前 250ms 防抖预览。
 */
export interface ScheduleConfigProps {
  readonly conn: Connection;
  readonly job?: ScheduleJobView;
  readonly defaultModel: string;
  readonly onSaved: (job: ScheduleJobView) => void;
}

const MODES: Array<{ id: ScheduleMode; en: string; zh: string }> = [
  { id: 'read-only', en: 'Read-only', zh: '只读' },
  { id: 'acceptEdits', en: 'Auto edit', zh: '自动编辑' },
  { id: 'full-access', en: 'Full access', zh: '完全访问' },
];

/** 时间戳 → datetime-local 值(本地时区,分钟精度——与 recurrence at=HH:mm 同粒度) */
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** datetime-local 值 → 时间戳(无时区=按本地解析;空/非法=NaN 由校验面兜底) */
function fromLocalInput(v: string): number {
  return new Date(v).getTime();
}

export function ScheduleConfig({ conn, job, defaultModel, onSaved }: ScheduleConfigProps): JSX.Element {
  const [name, setName] = useState(job?.name ?? '');
  const [prompt, setPrompt] = useState(job?.prompt ?? '');
  const [cycle, setCycle] = useState<ScheduleCycle>(job !== undefined ? cycleOf(job.recurrence) : 'daily');
  const [start, setStart] = useState(toLocalInput(job?.startAt ?? Date.now()));
  const [noUntil, setNoUntil] = useState(job?.until === undefined);
  const [until, setUntil] = useState(job?.until !== undefined ? toLocalInput(job.until) : '');
  const [effort, setEffort] = useState(job?.effort ?? 'high');
  const [mode, setMode] = useState<ScheduleMode>(job?.mode ?? 'full-access');
  const [picked, setPicked] = useState('');
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
  const { rows, browseFolder, registerFolder } = useWelcomeWorkspaces(conn, job?.root, 0, {
    setPicked,
    setProjOpen,
    setHint,
    setDirOpen,
  });
  usePopOutsideClose(projOpen, '.proj-pop', '.sx-schedule-ws-anchor', () => setProjOpen(false));
  usePopOutsideClose(modelOpen, '.sx-schedule-effort-pop', '.sx-schedule-model-pill', () => setModelOpen(false));
  usePopOutsideClose(modeOpen, '.sx-schedule-mode-pop', '.sx-schedule-mode-pill', () => setModeOpen(false));

  const startMs = fromLocalInput(start);
  const wsLabel = useMemo(() => {
    const r = picked.trim();
    if (r === '' || r === 'default') return t('Default workspace', '默认工作区');
    const b = pathBasename(r);
    return b === 'default' || b.startsWith('sunshinex-default') ? t('Default workspace', '默认工作区') : b;
  }, [picked]);

  // 预览(250ms 防抖):周期/开始/截止任一变更即重算下一次触发时刻;截止仅在「无截止」未勾时携带
  useEffect(() => {
    if (!Number.isFinite(startMs)) {
      setNextPreview(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      const untilMs = !noUntil && until !== '' ? fromLocalInput(until) : undefined;
      conn
        .previewSchedule({
          recurrence: recurrenceOf(cycle, startMs),
          startAt: startMs,
          ...(untilMs !== undefined && Number.isFinite(untilMs) ? { until: untilMs } : {}),
        })
        .then(
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
  }, [conn, cycle, startMs, noUntil, until]);

  const save = (): void => {
    if (busy) return;
    if (name.trim() === '' || prompt.trim() === '') {
      setError(t('Name and task are required', '名称和任务必填'));
      return;
    }
    if (!Number.isFinite(startMs)) {
      setError(t('Invalid start time', '开始时间无效'));
      return;
    }
    const untilMs = noUntil ? undefined : fromLocalInput(until);
    if (!noUntil && (!Number.isFinite(untilMs) || (untilMs as number) <= startMs)) {
      setError(t('End must be after start', '截止时间必须晚于开始'));
      return;
    }
    setBusy(true);
    setError('');
    const body: ScheduleDraft = {
      name: name.trim(),
      prompt: prompt.trim(),
      root: picked.trim() === '' ? 'default' : picked.trim(),
      effort,
      mode,
      recurrence: recurrenceOf(cycle, startMs),
      startAt: startMs,
      ...(untilMs !== undefined ? { until: untilMs } : {}),
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

  const nextLabel = nextPreview !== null ? new Date(nextPreview).toLocaleString() : '—';

  return (
    <div className="sx-schedule-cfg">
      <div className="sx-schedule-row">
        <label className="sx-schedule-label" htmlFor="sx-schedule-name">
          {t('Name', '名称')}
        </label>
        <input
          id="sx-schedule-name"
          className="sx-schedule-input"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </div>

      <div className="sx-schedule-row">
        <label className="sx-schedule-label" htmlFor="sx-schedule-cycle">
          {t('Schedule', '调度')}
        </label>
        <div>
          <div className="sx-schedule-schedule">
            <select
              id="sx-schedule-cycle"
              className="sx-schedule-input sx-schedule-select"
              aria-label={t('Repeat', '周期')}
              value={cycle}
              onChange={(e) => setCycle(e.target.value as ScheduleCycle)}
            >
              {CYCLE_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {t(o.label.en, o.label.zh)}
                </option>
              ))}
            </select>
            <label className="sx-schedule-inline">
              <span>{t('Starts at', '开始时间')}</span>
              <input
                type="datetime-local"
                className="sx-schedule-input sx-schedule-datetime"
                aria-label={t('Starts at', '开始时间')}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label className="sx-schedule-nocut">
              <input type="checkbox" checked={noUntil} onChange={(e) => setNoUntil(e.target.checked)} />
              {t('No deadline', '无截止')}
            </label>
            <input
              type="datetime-local"
              className="sx-schedule-input sx-schedule-datetime"
              aria-label={t('Ends at', '截止时间')}
              value={until}
              disabled={noUntil}
              onChange={(e) => setUntil(e.target.value)}
            />
          </div>
          <div className="sx-schedule-hint">
            {t('The cycle anchors on the start time', '周期以开始时间为锚点')} · {t('Next', '接下来')} {nextLabel}
          </div>
        </div>
      </div>

      <div className="sx-schedule-row">
        <span className="sx-schedule-label">{t('Task', '任务')}</span>
        <ComposerCard
          label={t('Task', '任务')}
          value={prompt}
          onChange={setPrompt}
          placeholder={t(
            'Write the full brief: context, goal, acceptance. Every new session starts fresh.',
            '写清背景、目标、验收标准；每个新会话从零开始',
          )}
          rows={3}
          onKeyDown={() => undefined}
          className="sx-schedule-task-composer"
          footLeft={
            <>
              <div className="pill-anchor sx-schedule-ws-anchor">
                <button
                  type="button"
                  className="composer-pill"
                  onClick={() => {
                    setProjQuery('');
                    setProjOpen((v) => !v);
                  }}
                >
                  <Folder size={14} strokeWidth={1.75} />
                  <span className="pill-label">{wsLabel}</span>
                  <ChevronDown className="pill-chevron" size={14} strokeWidth={1.75} />
                </button>
                {projOpen && (
                  <WelcomeProjectPop
                    rows={rows}
                    picked={picked}
                    query={projQuery}
                    onQuery={setProjQuery}
                    onPick={(r) => {
                      setPicked(r);
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
                      <DirPicker
                        conn={conn}
                        showManual={false}
                        onCancel={() => setDirOpen(false)}
                        onConfirm={registerFolder}
                      />
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="composer-pill composer-plus-btn"
                title={t('Add workspace', '新增工作目录')}
                onClick={() => void browseFolder()}
              >
                <Plus size={14} strokeWidth={2} />
              </button>
              <div className="pill-anchor">
                <button
                  type="button"
                  className="composer-pill model-pill sx-schedule-model-pill"
                  onClick={() => setModelOpen((v) => !v)}
                >
                  {defaultModel}
                  <span className="model-effort-chip">{effortLabel(effort)}</span>
                  <ChevronDown className="pill-chevron" size={14} strokeWidth={1.75} />
                </button>
                {modelOpen && (
                  <div className="sx-menu-pop sx-schedule-effort-pop">
                    <EffortSlider value={effort} onChange={setEffort} />
                  </div>
                )}
              </div>
              <div className="pill-anchor">
                <button
                  type="button"
                  className={`composer-pill sx-schedule-mode-pill${mode === 'full-access' ? ' mode-pill-warn' : ''}`}
                  title={
                    mode === 'full-access'
                      ? t('Unattended: no approvals, writes directly', '无人值守：不会弹审批，会直接写工作目录')
                      : mode === 'acceptEdits'
                        ? t('Unattended: may wait for approval', '无人值守：可能停在审批卡')
                        : t('Read-only', '只读')
                  }
                  onClick={() => setModeOpen((v) => !v)}
                >
                  {t(
                    MODES.find((m) => m.id === mode)?.en ?? 'Full access',
                    MODES.find((m) => m.id === mode)?.zh ?? '完全访问',
                  )}
                </button>
                {modeOpen && (
                  <div className="sx-menu-pop sx-schedule-mode-pop">
                    {MODES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className="sx-menuitem"
                        onClick={() => {
                          setMode(m.id);
                          setModeOpen(false);
                        }}
                      >
                        {t(m.en, m.zh)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          }
          footRight={
            <button
              type="button"
              className="send"
              aria-label={t('Save', '保存')}
              title={t('Save', '保存')}
              disabled={busy}
              onClick={save}
            >
              <Check size={16} strokeWidth={2} />
            </button>
          }
        />
      </div>

      {error !== '' && (
        <p className="sx-schedule-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

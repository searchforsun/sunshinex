import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsKeyRow, SettingsView } from '../connection';
import { SourceBadge } from './SourceBadge';
import { relTime, errText } from '../ui-util';
import { parseLanguage, setLanguage } from '../i18n';

/**
 * G8c T8 通用键值表单引擎(+四简单面板配置):mount/effect 拉 conn.settings(root)→按 pane
 * 键过滤 →行渲染(SourceBadge+label+输入);envOverride 行禁编+title「env 覆盖中,改文件不
 * 生效」(env 槽覆盖文件面,改文件不生效——GUI 禁编是唯一诚实呈现);「保存」收集改动 diff
 * (空改动禁用)→conn.putSettings(root,updates)→成功:toast「已生效:新建会话起」(sx-toast
 * 底部 3s 自隐;语义键改写不热载——生效面在新会话装配)+重拉 settings;失败(400 未知键/
 * 409 畸形文件):行内错误条原文示出。
 * root 归一:''(仅全局)→ settings/memoryStats 省参(空串 root 服务端不可靠);putSettings
 * 收 root 原样(写面恒项目级——仅全局态保存由 daemon 400 面经错误条示出,不静默)。
 * 数字键(input 'number')保存时 number 化;清空值存 null(daemon 语义 null=delete)。on/off
 * 字符串键(autoMemory 等)统一 text 输入+placeholder 提示(33 键无 boolean 形,裁定)。
 * 记忆面板概览行(pane.memoryOverview):conn.memoryStats 只读展示「N 条记忆·最近 X」。
 */

export interface SettingsFieldDef {
  readonly key: string;
  readonly label: string;
  readonly input: 'text' | 'number' | 'boolean';
}

/** 面板配置:id(导航/重挂键)+title(导航项与面板标题)+fields(键名逐字)+记忆概览行开关 */
export interface SettingsPaneDef {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly SettingsFieldDef[];
  /** 记忆面板:true = 顶部概览行(memoryStats 只读) */
  readonly memoryOverview?: boolean;
}

/** 表单引擎连接面(结构满足即收,App 传整只 Connection) */
export interface SettingsFormConn {
  settings(root?: string): Promise<SettingsView>;
  putSettings(root: string, updates: Record<string, string | number | null>): Promise<void>;
  memoryStats(root?: string): Promise<{ entries: number; lastWriteAt: number | null }>;
}

/** 数字键清单(brief 逐字):input='number' + 保存时 number 化 */
const NUMBER_KEYS = new Set([
  'contextWindow',
  'maxTokens',
  'subagentTokenCap',
  'teamTokenCap',
  'maxSteps',
  'maxLoopIterations',
  'maxGraphNodes',
  'learnedSkillLimit',
  'memoryIdleKickMs',
  'stepDigestMaxSteps',
  'stepDigestItemChars',
  'stepDigestTotalChars',
]);

/** on/off 字符串键(placeholder 提示;统一 text 输入——33 键无 boolean 形裁定) */
const TOGGLE_KEYS = new Set(['autoMemory', 'learnedSkills']);

const field = (key: string): SettingsFieldDef => ({ key, label: key, input: NUMBER_KEYS.has(key) ? 'number' : 'text' });

const fields = (keys: readonly string[]): SettingsFieldDef[] => keys.map(field);

/**
 * 四简单面板(G8c-T8 只挂已实现面;T9 扩全十项——禁用占位=死 UI 违禁,故导航仅列此四)。
 * 键名与 daemon SEMANTIC_KEYS 逐字对齐。
 */
export const SETTINGS_PANES: readonly SettingsPaneDef[] = [
  { id: 'general', title: '通用', fields: fields(['language', 'shell', 'projectsDir', 'userSkillsDir', 'globalSunshine']) },
  {
    id: 'limits',
    title: '上下文与限额',
    fields: fields([
      'contextWindow',
      'maxTokens',
      'subagentTokenCap',
      'teamTokenCap',
      'maxSteps',
      'maxLoopIterations',
      'maxGraphNodes',
      'readFence',
      'sandbox',
      'isolation',
    ]),
  },
  {
    id: 'memory',
    title: '记忆',
    memoryOverview: true,
    fields: fields([
      'autoMemory',
      'learnedSkills',
      'learnedSkillLimit',
      'memoryIdleKickMs',
      'stepDigestMaxSteps',
      'stepDigestItemChars',
      'stepDigestTotalChars',
    ]),
  },
  {
    id: 'kb',
    title: '知识库与搜索',
    fields: fields(['kbBackend', 'kbDataDir', 'embeddingBaseUrl', 'embeddingModel', 'websearchProvider', 'websearchEndpoint']),
  },
];

/** 相对时间与错误文案归一:G8e-T2 抽共享 ui-util(三处本地复制收敛) */

export interface SettingsFormProps {
  readonly conn: SettingsFormConn;
  /** 项目上下文('' = 仅全局;读面归一为省参) */
  readonly root: string;
  readonly pane: SettingsPaneDef;
}

export function SettingsForm({ conn, root, pane }: SettingsFormProps): JSX.Element {
  /** 键行表(pane 键过滤后;null = 加载中) */
  const [rows, setRows] = useState<Record<string, SettingsKeyRow> | null>(null);
  /** 输入当前值(键→字符串面;number 输入亦暂存字符串,保存时化型) */
  const [values, setValues] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  /** 记忆概览行数据(memoryOverview 面板拉取;null = 无/未落定) */
  const [stats, setStats] = useState<{ entries: number; lastWriteAt: number | null } | null>(null);
  /** toast 3s 自隐句柄(连续保存重置;卸载兜底清) */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** load 代计数(G8e-T2 竞态守卫):每次发起新拉即递增;应答到达时代不齐 = 陈旧(root 已
   *  切走/保存后重拉)——弃,不覆写行表(慢应答迟到不冲新 root 值) */
  const loadGenRef = useRef(0);

  /** 拉取:settings(root)+ 记忆面板附 memoryStats;成功落行表与输入值(整替——重拉即复位);
   *  代守卫:root 快切时旧应答迟到弃(终态=最新代) */
  const load = useCallback((): void => {
    const gen = ++loadGenRef.current;
    const r = root === '' ? undefined : root; // 仅全局 = 省参(空串 root 服务端不可靠)
    conn.settings(r).then(
      (view) => {
        if (loadGenRef.current !== gen) return; // 陈旧代:root 已切走,弃
        const byKey = new Map(view.keys.map((k) => [k.key, k]));
        const nextRows: Record<string, SettingsKeyRow> = {};
        const nextValues: Record<string, string> = {};
        for (const fd of pane.fields) {
          const row = byKey.get(fd.key);
          if (row === undefined) continue; // daemon 未报键(旧版缺面)——行省略
          nextRows[fd.key] = row;
          nextValues[fd.key] = row.value ?? ''; // 缺省空
        }
        setRows(nextRows);
        setValues(nextValues);
        setLoadError('');
      },
      (err: unknown) => {
        if (loadGenRef.current !== gen) return; // 陈旧代:错误也不落(新代在途/已落)
        setLoadError(errText(err));
      },
    );
    if (pane.memoryOverview)
      conn.memoryStats(r).then(
        (v) => {
          if (loadGenRef.current === gen) setStats(v);
        },
        () => {
          if (loadGenRef.current === gen) setStats(null);
        },
      );
  }, [conn, root, pane]);

  useEffect(() => {
    load();
  }, [load]);

  /** 卸载兜底:在途 toast 计时器不泄漏 */
  useEffect(
    () => () => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    },
    [],
  );

  /** 改动 diff(envOverride 行禁编不入;空值→null=delete;数字键 number 化) */
  const updates = useMemo(() => {
    const out: Record<string, string | number | null> = {};
    if (rows === null) return out;
    for (const fd of pane.fields) {
      const row = rows[fd.key];
      if (row === undefined || row.envOverride) continue;
      const cur = values[fd.key] ?? '';
      if (cur === (row.value ?? '')) continue;
      out[fd.key] = cur === '' ? null : fd.input === 'number' ? Number(cur) : cur;
    }
    return out;
  }, [rows, values, pane]);

  const save = (): void => {
    if (saving || Object.keys(updates).length === 0) return;
    setSaving(true);
    setSaveError('');
    conn.putSettings(root, updates).then(
      () => {
        setSaving(false);
        // 语言键保存即热切换 GUI chrome 双语(G10-C3c;其余键新建会话起)
        if (updates.language !== undefined && typeof updates.language === 'string') {
          const lang = parseLanguage(updates.language);
          if (lang !== undefined) setLanguage(lang);
        }
        setToast('已生效:新建会话起');
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(''), 3_000);
        load(); // 重拉 settings(新来源归因/值回落)
      },
      (err: unknown) => {
        setSaving(false);
        setSaveError(errText(err)); // 400/409 原文行内示出
      },
    );
  };

  return (
    <section className="sx-settings-form" aria-label={`settings pane ${pane.title}`}>
      <h2>{pane.title}</h2>
      {pane.memoryOverview && stats !== null && (
        <p className="sx-memory-stats" aria-label="memory stats">
          {stats.entries} 条记忆{stats.lastWriteAt !== null ? ` · 最近 ${relTime(stats.lastWriteAt)}` : ''}
        </p>
      )}
      {loadError !== '' && <p className="home-error" role="alert">{loadError}</p>}
      {rows === null && loadError === '' && <p className="home-loading">加载设置…</p>}
      {rows !== null && (
        <ul className="sx-settings-rows">
          {pane.fields.map((fd) => {
            const row = rows[fd.key];
            if (row === undefined) return null;
            const id = `settings-input-${fd.key}`;
            return (
              <li key={fd.key} className="sx-setting-row">
                <SourceBadge source={row.source} />
                <label className="sx-setting-label" htmlFor={id}>
                  {fd.label}
                </label>
                <input
                  id={id}
                  aria-label={fd.key}
                  type={fd.input === 'number' ? 'number' : 'text'}
                  className="sx-setting-input"
                  value={values[fd.key] ?? ''}
                  placeholder={TOGGLE_KEYS.has(fd.key) ? 'on/off' : undefined}
                  disabled={row.envOverride}
                  title={row.envOverride ? 'env 覆盖中,改文件不生效' : undefined}
                  onChange={(e) => setValues((v) => ({ ...v, [fd.key]: e.target.value }))}
                />
              </li>
            );
          })}
        </ul>
      )}
      {saveError !== '' && <p className="home-error" role="alert">{saveError}</p>}
      <button type="button" className="sx-settings-save" disabled={saving || Object.keys(updates).length === 0} onClick={save}>
        保存
      </button>
      {toast !== '' && (
        <div className="sx-toast" role="status">
          {toast}
        </div>
      )}
    </section>
  );
}

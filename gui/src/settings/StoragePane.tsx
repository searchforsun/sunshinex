import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { CacheClearResp, CacheStatusResp, SettingsKeyRow, SettingsView } from '../connection-types';
import { t } from '../i18n';
import { errText, fmtBytes, relTime } from '../ui-util';
import { cacheClearResultText, clearCacheAll } from '../cache-clear';
import { KEY_DESCRIPTIONS } from './SettingsForm';

/**
 * 存储面板(2026-11-21 归档保留期/缓存清理 spec §7.1):两卡——①归档会话保留天数(语义键
 * archiveRetentionDays,读写走 settings/putSettings,引擎语义同 SettingsForm 自动保存轮;
 * 行锚 data-setting-key=键名)②缓存清点(GET /cache 逐类体积+单独清理钮;主按钮=一键清 safe
 * 全档+壳侧浏览器 HTTP 缓存;images-cache 引用型带警示、行内二次确认(3.5s 内再点执行))。
 * 分类双语标签本表单点,id 与 daemon CACHE_CATEGORIES 人工同源;http-cache=壳侧伪行
 * (sunshinexWindow 缺席即省略——浏览器态无 Chromium 缓存面)。
 */

export interface StoragePaneConn {
  settings(root?: string): Promise<SettingsView>;
  putSettings(scope: 'project' | 'global', root: string | undefined, updates: Record<string, string | number | null>): Promise<void>;
  cacheStatus(): Promise<CacheStatusResp>;
  clearCache(categories?: string[]): Promise<CacheClearResp>;
}

/** 分类双语标签(id 稳定;desc=行内说明;http-cache=壳侧伪行) */
const CACHE_LABELS: Record<string, { label: { en: string; zh: string }; desc: { en: string; zh: string } }> = {
  'pty-replay': { label: { en: 'Terminal replay buffers', zh: '终端回放缓存' }, desc: { en: 'PTY scrollback replay files', zh: '终端回滚缓冲的落盘副本' } },
  'editor-icons': { label: { en: 'Editor icon cache', zh: '编辑器图标缓存' }, desc: { en: 'Regenerated on demand', zh: '按需自动重新生成' } },
  'compaction-archives': { label: { en: 'Compaction archive mirrors', zh: '压缩归档镜像' }, desc: { en: 'Session journals stay the byte-exact authority', zh: '会话档为逐字节权威，镜像可清' } },
  'tool-outputs': { label: { en: 'Oversized tool outputs', zh: '超长工具输出存档' }, desc: { en: 'Previews stay in the chain, old recovery paths stop working', zh: '链上保留预览，旧恢复路径将失效' } },
  'plugin-logs': { label: { en: 'Plugin host logs', zh: '插件宿主日志' }, desc: { en: 'MCP host logs', zh: 'MCP 宿主运行日志' } },
  'computer-use-screenshots': { label: { en: 'Computer-use screenshots', zh: '电脑操作截图' }, desc: { en: 'Temporary screenshots from computer use', zh: '电脑操作过程的临时截图' } },
  'http-cache': { label: { en: 'Browser HTTP cache', zh: '浏览器 HTTP 缓存' }, desc: { en: 'Login states are not touched', zh: '登录态不受影响' } },
  'images-cache': { label: { en: 'Image attachment originals', zh: '图片附件原图' }, desc: { en: 'Only copy on disk, past images become unviewable after clearing', zh: '磁盘唯一副本，清理后历史消息中的图片将无法查看' } },
};

/** 引用型单清二次确认窗口(首点置确认态,窗口内再点才执行) */
const CONFIRM_WINDOW_MS = 3_500;

export function StoragePane({ conn, root }: { conn: StoragePaneConn; root: string }): JSX.Element {
  /** 保留天数行(GET /settings 中该键行;null=旧 daemon 缺键/加载中) */
  const [row, setRow] = useState<SettingsKeyRow | null>(null);
  const [value, setValue] = useState('');
  const [cache, setCache] = useState<CacheStatusResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState('');
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bumpToast = (msg: string): void => {
    setToast(msg);
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3_000);
  };
  useEffect(
    () => () => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const load = useCallback((): void => {
    const r = root === '' ? undefined : root;
    conn.settings(r).then(
      (view) => {
        const k = view.keys.find((x) => x.key === 'archiveRetentionDays');
        if (k !== undefined) {
          setRow(k);
          setValue(k.value ?? '');
        }
      },
      () => setRow(null),
    );
    conn.cacheStatus().then(setCache, () => setCache(null));
  }, [conn, root]);
  useEffect(() => {
    load();
  }, [load]);

  /** 保留天数保存(引擎语义同 SettingsForm.persistField:变更才写/按行 source 归桶/失败行内示出) */
  const persistRetention = (raw: string): void => {
    const k = row;
    if (k === null || k.envOverride) return;
    if (raw === (k.value ?? '')) return;
    if (raw === '') {
      // 清空=删键回落缺省 30 天(引擎同款 null 语义)
      void (k.source === 'project' && root !== '' ? conn.putSettings('project', root, { archiveRetentionDays: null }) : conn.putSettings('global', undefined, { archiveRetentionDays: null }))
        .then(() => {
          bumpToast(t('Applied', '已生效'));
          load();
        })
        .catch((err: unknown) => setSaveError(errText(err)));
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const v = Math.max(0, Math.floor(n));
    const isProject = k.source === 'project';
    setSaveError('');
    const put =
      isProject && root === ''
        ? Promise.reject(new Error(t('Project-level settings need a project context — open settings inside a project', '项目级配置需项目上下文——请在项目内打开设置再修改')))
        : isProject
          ? conn.putSettings('project', root, { archiveRetentionDays: v })
          : conn.putSettings('global', undefined, { archiveRetentionDays: v });
    void put
      .then(() => {
        bumpToast(t('Applied', '已生效'));
        load();
      })
      .catch((err: unknown) => setSaveError(errText(err)));
  };

  /** 缓存清理:ids 缺省=safe 全档(主按钮,附壳侧 http-cache);显式 ids=行级单独清
   *  ——并行组合与文案走 cache-clear 共享单点(与 App.clearCacheNow 同源) */
  const clear = (ids: string[] | undefined): void => {
    if (busy) return;
    setBusy(true);
    setConfirmId(null);
    clearCacheAll(conn, ids)
      .then(async (r) => {
        bumpToast(cacheClearResultText(r));
        load();
      })
      .catch((err: unknown) => setSaveError(errText(err)))
      .finally(() => setBusy(false));
  };

  /** 引用型单清二次确认:首点置确认态(3.5s 复位),再点执行 */
  const clearWithConfirm = (id: string): void => {
    if (confirmId !== id) {
      setConfirmId(id);
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), CONFIRM_WINDOW_MS);
      return;
    }
    if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
    clear([id]);
  };

  /** 浏览器 HTTP 缓存行(壳桥在场才显;单独清=只调壳桥) */
  const hasHttpCache = typeof window !== 'undefined' && window.sunshinexWindow?.clearHttpCache !== undefined;
  const desc = KEY_DESCRIPTIONS.archiveRetentionDays;
  const retention = cache?.retention;
  const categories = cache?.categories ?? [];

  return (
    <section className="sx-settings-form sx-settings-body" aria-label="settings pane storage">
      <h2>{t('Storage', '存储')}</h2>
      <div className="sx-card sx-settings-card">
        <div className="sx-card-head">
          <span className="sx-card-title">{t('Archived sessions', '归档会话')}</span>
        </div>
        <div className="sx-card-rows">
          <div className="sx-setting-row" data-setting-key="archiveRetentionDays">
            <div className="sx-setting-main">
              <div className="sx-setting-title">
                <span className="sx-setting-label" data-tip="archiveRetentionDays">
                  {desc !== undefined ? t(desc.label.en, desc.label.zh) : 'archiveRetentionDays'}
                </span>
              </div>
              {desc !== undefined && <p className="sx-setting-desc">{t(desc.en, desc.zh)}</p>}
            </div>
            <div className="sx-setting-ctl">
              <input
                type="number"
                className="sx-setting-input"
                aria-label="archiveRetentionDays"
                min={0}
                step={1}
                placeholder="30"
                value={value}
                disabled={row?.envOverride === true}
                data-tip={row?.envOverride === true ? t('Overridden by env — read-only', 'env 覆盖中,改文件不生效') : undefined}
                onChange={(e) => setValue(e.target.value)}
                onBlur={(e) => persistRetention(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />
            </div>
          </div>
          <div className="sx-setting-row">
            <div className="sx-setting-main">
              <div className="sx-setting-title">
                <span className="sx-setting-label">{t('Last auto-clean', '上次自动清理')}</span>
              </div>
              <p className="sx-setting-desc">
                {retention === undefined
                  ? t('Loading…', '加载中…')
                  : retention.days <= 0
                    ? t('Auto-clean is off, 0 keeps everything', '自动清理已关闭，0 为永不')
                    : retention.lastRunAt === null
                      ? t('Not run yet', '尚未运行')
                      : t(`${relTime(retention.lastRunAt)} · purged ${retention.lastPurged} sessions`, `${relTime(retention.lastRunAt)} · 已清理 ${retention.lastPurged} 个会话`)}
              </p>
            </div>
          </div>
        </div>
      </div>
      <div className="sx-card sx-settings-card">
        <div className="sx-card-head">
          <span className="sx-card-title" data-setting-key="cache">
            {t('Cache', '缓存')}
          </span>
          {/* 总占用随卡头右侧:「总量 + 清理缓存」一组贴右缘,不另立行 */}
          <div className="sx-storage-headctl">
            {cache !== null && <span className="sx-storage-size">{fmtBytes(cache.total)}</span>}
            <button
              type="button"
              className="sx-storage-btn sx-storage-head-btn"
              disabled={busy}
              data-tip={t('Clear all safe caches + browser HTTP cache', '清理全部安全缓存与浏览器 HTTP 缓存')}
              onClick={() => clear(undefined)}
            >
              <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
              {t('Clear cache', '清理缓存')}
            </button>
          </div>
        </div>
        <div className="sx-card-rows">
          {categories.map((c) => {
            const l = CACHE_LABELS[c.id];
            return (
              <div key={c.id} className="sx-setting-row sx-storage-row" data-setting-key={`cache:${c.id}`}>
                <div className="sx-setting-main">
                  <div className="sx-setting-title">
                    <span className="sx-setting-label">{l !== undefined ? t(l.label.en, l.label.zh) : c.id}</span>
                  </div>
                  {l !== undefined && <p className="sx-setting-desc">{t(l.desc.en, l.desc.zh)}</p>}
                </div>
                <div className="sx-setting-ctl sx-storage-rowctl">
                  <span className="sx-storage-size">{fmtBytes(c.size)}</span>
                  {/* 行级清理统一「图标+文字」胶囊,控件组贴右缘对齐;引用型保行内二次确认态 */}
                  <button
                    type="button"
                    className={`sx-storage-btn${confirmId === c.id ? ' danger' : ''}`}
                    aria-label={`clear ${c.id}`}
                    data-tip={c.safe || confirmId === c.id ? undefined : t('Click again within 3.5s to confirm', '3.5 秒内再次点击确认')}
                    disabled={busy}
                    onClick={() => (c.safe ? clear([c.id]) : clearWithConfirm(c.id))}
                  >
                    <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                    {confirmId === c.id ? t('Confirm clear', '确认清理') : t('Clear', '清理')}
                  </button>
                </div>
              </div>
            );
          })}
          {hasHttpCache && (
            <div className="sx-setting-row sx-storage-row" data-setting-key="cache:http-cache">
              <div className="sx-setting-main">
                <div className="sx-setting-title">
                  <span className="sx-setting-label">{t(CACHE_LABELS['http-cache']!.label.en, CACHE_LABELS['http-cache']!.label.zh)}</span>
                </div>
                <p className="sx-setting-desc">{t(CACHE_LABELS['http-cache']!.desc.en, CACHE_LABELS['http-cache']!.desc.zh)}</p>
              </div>
              <div className="sx-setting-ctl sx-storage-rowctl">
                <span className="sx-storage-size" />
                <button
                  type="button"
                  className="sx-storage-btn"
                  aria-label="clear http-cache"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void (window.sunshinexWindow?.clearHttpCache?.() ?? Promise.resolve({ ok: true }))
                      .catch(() => undefined)
                      .finally(() => {
                        setBusy(false);
                        bumpToast(t('Browser cache cleared', '浏览器缓存已清'));
                      });
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                  {t('Clear', '清理')}
                </button>
              </div>
            </div>
          )}
          {cache === null && <p className="home-loading">{t('Loading cache info…', '加载缓存信息…')}</p>}
        </div>
      </div>
      {saveError !== '' && (
        <p className="home-error" role="alert">
          {saveError}
        </p>
      )}
      {toast !== '' && (
        <div className="sx-toast" role="status">
          {toast}
        </div>
      )}
    </section>
  );
}

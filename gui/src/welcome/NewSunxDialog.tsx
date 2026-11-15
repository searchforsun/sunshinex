import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Folder } from 'lucide-react';
import type { DirPickerResp, SunxTemplateEntry } from '../connection';
import { t } from '../i18n';
import { errText, pathBasename } from '../ui-util';
import { DirPicker } from '../pages/DirPicker';
import { WelcomeProjectPop } from './welcome-project-pop';
import { useWelcomeWorkspaces } from './use-welcome-workspaces';
import { usePopOutsideClose } from '../use-pop-outside-close';

/**
 * 「新建 Sunx」弹窗——创建/编辑双模式(sunx P1 Task 6;2026-11-15 用户裁定「编辑 Sunx 复用创建
 * 弹窗,禁用工作区」+「编辑 Sunx 支持修改名称和品性」)。
 *
 * 创建模式(缺省):三元组表单——姓名(必填)/工作目录(欢迎页 useWelcomeWorkspaces 下拉,创建定死)/
 * 品性(留空=仅总章程)。提交 conn.newSession(target, undefined, undefined, undefined,
 * { kind:'sunx', name, charter? }) → 成功走既有 openSession 链路并关弹窗。
 *
 * 编辑模式(edit prop 在场):姓名可改(meta.title 显示链+rename 尾追同步行进链——模型下一轮即知
 * 新名)/工作目录禁用显示(创建定死不可改,域绑定语义)/品性可改(GET /session/:id/charter 预填 →
 * editCharter 全文替换+尾追替代行)。提交=两端点按变更分派,全 settlement 后 onClose。
 *
 * 关闭三径:ESC/点外(遮罩)/取消钮;提交中 busy 锁禁重复提交且三关闭路径拒关(创建=「发出即必建」
 * 不可取消;编辑=保存在途不可取消)。全局 portal 到 body(WelcomeIsoDialog 同款)。
 *
 * 模板挑选(创建模式,sunx P2 Task 6):表单态顶部模板下拉(GET /settings/sunx-templates 惰拉,
 * 锚=当前 picked),选中回填 name=模板 name、charter=章程全文(回填只是播种——改后以改后为准);
 * 清单空/惰拉失败=选择器隐藏。被遮蔽行(shadowed)不进选项(生效视图口径)。
 */

/** 连接面(收窄子集,Connection/ProjectMenuConn 均满足) */
export interface NewSunxConn {
  dirpicker(path?: string): Promise<DirPickerResp>;
  workspaces(): Promise<Array<{ slug: string; root?: string; sessionCount: number }>>;
  /** 建项目:原生选择器/DirPicker 确认后注册既有目录(幂等,同 root 直返 ok) */
  createWorkspace(body: { name?: string; path?: string }): Promise<{ ok: true; root: string; slug: string }>;
  /** 原生选择标记定位(浏览器态 pickWorkspaceFolder 回退;桌面壳 IPC 在场时不走) */
  locateWorkspace(body: { token: string; roots?: string[] }): Promise<{ path: string | null }>;
  /** 工作区在他面创建落库时广播(旧桩/降级面缺名即不订阅) */
  onConfigChanged?(cb: (info: { resource: string; scope?: string; root?: string | null }) => void): () => void;
  /** 第 5 参 opts(2026-11-15 Task 4):kind/name/charter 透传——缺席字段省发,body 与旧形态逐字节相同 */
  newSession(root: string, mode?: 'acceptEdits' | 'full-access', worktree?: boolean, branch?: string, opts?: { kind?: 'sunx'; name?: string; charter?: string }): Promise<{ sessionId: string }>;
  /** GET /settings/sunx-templates(sunx P2 Task 6,模板挑选数据源):打开/切换工作目录时惰拉,失败静默 */
  sunxTemplates(root?: string): Promise<{ entries: SunxTemplateEntry[]; warnings: string[] }>;
  /** GET /session/:id/charter(编辑模式品性预填) */
  sessionCharter(id: string): Promise<{ text: string | null; charterRev: number }>;
  /** POST /session/:id/charter {text}:全文替换,成功回新 rev */
  editCharter(id: string, text: string): Promise<{ ok: true; charterRev: number }>;
  /** POST /session/:id/rename {title}:显示名+sunx 尾追同步行(daemon 侧) */
  renameSession(id: string, title: string): Promise<{ ok: true; title: string }>;
}


export interface NewSunxDialogProps {
  /** 受控开合:母体持态(false=零渲染) */
  readonly open: boolean;
  readonly onClose: () => void;
  readonly conn: NewSunxConn;
  /** 创建模式:成功后打开新会话(既有 openSession 链路);编辑模式不消费 */
  readonly onOpenSession?: (sessionId: string, root: string) => void;
  /** 编辑模式(2026-11-15 用户裁定「编辑 Sunx 复用创建弹窗,禁用工作区,支持改名+品性」):
   *  sessionId 寻址;name=当前显示名(预填);提交走 rename+editCharter 双端点 */
  readonly edit?: { sessionId: string; name: string };
  /** 创建模式缺省工作目录锚(当前默认工作区 root;宿主 defaultWorkspaceAnchor 单点供值) */
  readonly defaultRoot?: string;
}

export function NewSunxDialog(props: NewSunxDialogProps): JSX.Element | null {
  const { open, onClose, conn, onOpenSession } = props;
  const edit = props.edit;
  const isEdit = edit !== undefined;
  const [name, setName] = useState('');
  const [charter, setCharter] = useState('');
  /** 工作目录选择面(创建模式):既有 DirPicker 整面替换表单;编辑模式整字段禁用不渲染 */
  const [browse, setBrowse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 模板清单(创建模式):空数组=无模板态(选择器隐藏);templateId=下拉当前选中(空串=未选) */
  const [templates, setTemplates] = useState<SunxTemplateEntry[]>([]);
  const [templateId, setTemplateId] = useState('');
  /** 编辑模式品性预填(GET /session/:id/charter;失败静默锁空——替换语义空文 400 禁保存) */
  const [charterLoaded, setCharterLoaded] = useState(false);
  /** 编辑模式品性回源基线(GET 应答原文;提交时与现文比较——未变不重发) */
  const [fetchedCharter, setFetchedCharter] = useState<string | null>(null);
  /** 工作目录(欢迎页 hook 单点复用):picked=选中根(空串=未锚,回源后落默认锚);
   *  projOpen=下拉弹层;dirOpen=DirPicker 登记面;hint=浏览/登记错误行 */
  const [picked, setPicked] = useState('');
  const [projOpen, setProjOpen] = useState(false);
  const [projQuery, setProjQuery] = useState('');
  const [hint, setHint] = useState('');
  const [dirOpen, setDirOpen] = useState(false);
  const projRef = useRef<HTMLDivElement>(null);

  const { rows, browseFolder, registerFolder } = useWelcomeWorkspaces(conn, undefined, undefined, {
    setPicked,
    setProjOpen,
    setHint,
    setDirOpen,
  });

  /** open 翻真即重置表单(创建:草稿不残留;编辑:名=当前显示名,品性异步预填) */
  useEffect(() => {
    if (!open) return;
    setName(isEdit ? (edit?.name ?? '') : '');
    setCharter('');
    setBrowse(false);
    setBusy(false);
    setError('');
    setProjOpen(false);
    setHint('');
    setDirOpen(false);
  }, [open]);

  /** 编辑模式品性预填(GET /session/:id/charter;失败静默锁空——替换语义空文 400 禁保存) */
  useEffect(() => {
    if (!open || !isEdit || edit === undefined) return;
    let alive = true;
    conn
      .sessionCharter(edit.sessionId)
      .then((r) => {
        if (!alive) return;
        setCharter(r.text ?? '');
        setFetchedCharter(r.text ?? '');
        setCharterLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        setCharter('');
        setFetchedCharter('');
        setCharterLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  /** 模板清单惰拉(创建模式,P2 Task 6 裁定 5):弹窗打开取一次,root=当前 picked;失败静默 */
  useEffect(() => {
    if (!open || isEdit) return;
    setTemplates([]);
    setTemplateId('');
    let alive = true;
    conn
      .sunxTemplates(picked.trim() === '' ? undefined : picked)
      .then((r) => {
        if (alive) setTemplates(r.entries);
      })
      .catch(() => undefined); // 失败静默:清单保持空=选择器隐藏
    return () => {
      alive = false;
    };
  }, [open, conn, picked]);

  /** 关闭三径之一:ESC。busy(提交在途)拒关;浏览面先回表单(创建模式),表单面才整弹窗关 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (busy) return;
      if (browse) {
        setBrowse(false);
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, browse, busy, onClose]);

  /** 下拉弹层点外收(弹层面+.sx-sunx-ws-bar 锚外 mousedown) */
  usePopOutsideClose(projOpen, '.proj-pop', '.sx-sunx-ws-bar', () => setProjOpen(false));

  if (!open) return null;

  /** 提交根(创建=picked 锚定;编辑不消费) */
  const target = picked.trim() === '' ? 'default' : picked.trim();
  const isDefaultPicked = (() => {
    const nm = pathBasename(target);
    return nm === 'default' || nm.startsWith('sunshinex-default');
  })();
  const wsLabel = isDefaultPicked ? t('Default workspace', '默认工作区') : pathBasename(target);
  /** 姓名必填(trim 后非空)+ busy 锁(提交中禁重复提交) */
  const canSubmit = name.trim() !== '' && !busy && (isEdit ? charterLoaded : true);

  /** 创建提交 */
  const submitCreate = (): void => {
    if (!canSubmit || onOpenSession === undefined) return;
    setBusy(true);
    setError('');
    // charter 空白不落键(留空=仅总章程);非空原样透传(用户自撰物料逐字进冻结层,连接层同纪律)
    const text = charter;
    conn
      .newSession(target, undefined, undefined, undefined, {
        kind: 'sunx',
        name: name.trim(),
        ...(text.trim() !== '' ? { charter: text } : {}),
      })
      .then(
        ({ sessionId }) => {
          setBusy(false);
          onOpenSession(sessionId, target); // 既有 openSession 链路(宿主装配)
          onClose();
        },
        (err: unknown) => {
          setBusy(false);
          setError(errText(err));
        },
      );
  };

  /** 编辑提交(双端点按变更分派):名称=renameSession(meta.title 显示链+daemon 尾追同步行——模型
   *  下一轮即知新名);品性=editCharter(全文替换+尾追替代行)。全 settlement 后关弹窗 */
  const submitEdit = (): void => {
    if (!canSubmit || edit === undefined) return;
    setBusy(true);
    setError('');
    const jobs: Array<Promise<unknown>> = [conn.renameSession(edit.sessionId, name.trim())];
    if (charter !== (fetchedCharter ?? '')) jobs.push(conn.editCharter(edit.sessionId, charter));
    Promise.all(jobs).then(
      () => {
        setBusy(false);
        onClose();
      },
      (err: unknown) => {
        setBusy(false);
        setError(errText(err));
      },
    );
  };

  const submit = isEdit ? submitEdit : submitCreate;

  return createPortal(
    <div
      className="modal-overlay"
      onClick={() => {
        // 点外关:busy 拒关(提交在途不可取消);浏览面先回表单(创建模式),表单面整弹窗关
        if (busy) return;
        if (browse) setBrowse(false);
        else onClose();
      }}
    >
      <div className="modal-body sx-sunx-dialog" role="dialog" aria-label={isEdit ? t('Edit Sunx', '编辑 Sunx') : t('New Sunx', '新建 Sunx')} onClick={(e) => e.stopPropagation()}>
        <header className="dirpicker-head">
          <span>{isEdit ? t('Edit Sunx', '编辑 Sunx') : t('New Sunx', '新建 Sunx')}</span>
          {/* ✕ 同取消钮 disabled={busy}——第三关闭路径 busy 拒关(fix round 1) */}
          <button type="button" aria-label="close sunx dialog" disabled={busy} onClick={onClose}>
            ✕
          </button>
        </header>
        {/* 模板挑选(创建模式,P2 Task 6):表单态顶部下拉;无模板数据=不渲染(选择器不阻塞手填)。
            选中回填 name/charter 可改;shadowed 行不进选项(生效视图口径,模块头注) */}
        {!isEdit && templates.length > 0 && (
          <label className="sx-sunx-field">
            <span>{t('Template', '模板')}</span>
            <select
              aria-label={t('Template', '模板')}
              value={templateId}
              onChange={(e) => {
                const id = e.target.value;
                setTemplateId(id);
                // 取未遮蔽行（生效视图口径，与 option 列表同谓词）——同 id 双行时 find 裸查会
                // 命中在列序更早的全局 shadowed 行，回填被顶掉的章程
                const tpl = templates.find((x) => x.id === id && !x.shadowed);
                if (tpl) {
                  setName(tpl.name); // ruling 3:模板 name 回填姓名
                  setCharter(tpl.charter); // charter 章程全文回填品性(回填可改,以改后为准)
                }
              }}
            >
              <option value="">{t('Select a template…', '选择模板…')}</option>
              {templates
                .filter((x) => !x.shadowed)
                .map((x) => (
                  <option key={`${x.source}/${x.id}`} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="sx-sunx-field">
          <span>{t('Name', '姓名')}</span>
          <input
            aria-label={t('Name', '姓名')}
            value={name}
            maxLength={80} // daemon name trim 帽 80 同口径(Task 4)
            autoFocus
            placeholder={t('e.g. Repo steward', '如：仓库管家')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </label>
        {/* 工作目录(2026-11-15 用户实测反馈「不支持手写,参考欢迎页」):choose-project-bar 同款
            选择条+WelcomeProjectPop 弹层(筛选/默认工作区锚/浏览文件夹…),登记面走 DirPicker
            overlay(welcome 同构)。anchor 相对容器使弹层向下展开(dialog 内无 welcome-dock 锚) */}
        <div className="sx-sunx-field">
          <span>{t('Working directory', '工作目录')}</span>
          <div className="sx-sunx-ws-anchor">
            <button
              type="button"
              className="choose-project-bar sx-sunx-ws-bar"
              aria-label={t('Choose working directory', '选择工作目录')}
              onClick={() => {
                setProjQuery('');
                setProjOpen((v) => !v);
              }}
            >
              <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="wc-pill-label">{wsLabel}</span>
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
                  <DirPicker conn={conn} showManual={false} onCancel={() => setDirOpen(false)} onConfirm={registerFolder} />
                </div>
              </div>
            )}
          </div>
        </div>
        <label className="sx-sunx-field">
          <span>{t('Charter', '品性')}</span>
          <textarea
            aria-label={t('Charter', '品性')}
            rows={6}
            value={charter}
            placeholder={t('Personality and rules for this Sunx.', '这个 Sunx 的品性与守则')}
            onChange={(e) => setCharter(e.target.value)}
          />
        </label>
        {error !== '' && (
          <p className="dirpicker-error" role="alert">
            {error}
          </p>
        )}
        <footer className="dirpicker-foot">
          <button type="button" disabled={busy} onClick={onClose}>
            {t('Cancel', '取消')}
          </button>
          <button type="button" className="primary" disabled={!canSubmit} onClick={submit}>
            {busy
              ? isEdit
                ? t('Saving…', '保存中…')
                : t('Creating…', '创建中…')
              : isEdit
                ? t('Save', '保存')
                : t('Create', '创建')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

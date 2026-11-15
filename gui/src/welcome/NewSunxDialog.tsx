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
 * 「新建 Sunx」创建弹窗(sunx P1 Task 6,2026-11-15 用户裁定:与「新对话」同级、独立弹窗;
 * 欢迎页 composer 零改动)。三元组表单——姓名(必填,空禁提交)/工作目录/品性(Charter 文本域)。
 * 提交 conn.newSession(target, undefined, undefined, undefined, { kind:'sunx', name, charter? })
 * → 成功走既有 openSession 链路打开该会话并关弹窗。开合受控(open prop + onClose);关闭三径:
 * ESC/点外(遮罩)/取消钮;提交中 busy 锁禁重复提交。全局 portal 到 body(WelcomeIsoDialog
 * 同款——composer 祖先带定位上下文,内联 overlay 的 fixed 会被困住)。
 *
 * 工作目录(2026-11-15 用户实测反馈「不支持手写,参考欢迎页」):整体复用欢迎页
 * useWelcomeWorkspaces 单点(默认锚去重清单/壳 IPC 与浏览器态双浏览通道/DirPicker 登记/
 * config-changed 回源)+WelcomeProjectPop 弹层(筛选+默认工作区锚+浏览文件夹…项)——样式与
 * 交互同源对齐,零平行实现。picked 缺席由 hook 落默认锚('default' 字面或现存锚点行)。
 *
 * 模板挑选(sunx P2 Task 6):打开/切换工作目录时惰拉(GET /settings/sunx-templates,锚=当前
 * picked——项目级模板随所选工作区装配),选中即回填 name=模板 name、charter=章程全文(回填只是
 * 播种——用户改后以改后为准,不锁定);清单空/惰拉失败=选择器隐藏,表单照常可用。被遮蔽行
 * (shadowed)不进选项(生效视图口径——同 id 被更高层级顶掉的全局行,内容已被生效版取代)。
 */

/** 连接面(收窄子集,Connection/ProjectMenuConn 均满足):弹窗只消费这些方法。
 *  workspaces/createWorkspace/locateWorkspace/onConfigChanged=useWelcomeWorkspaces 数据面 */
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
}

export interface NewSunxDialogProps {
  /** 受控开合:母体持态(false=零渲染) */
  readonly open: boolean;
  readonly onClose: () => void;
  readonly conn: NewSunxConn;
  /** 成功后打开新会话(既有 openSession 链路;宿主侧自带抽屉收起/清单重拉等既有装配) */
  readonly onOpenSession: (sessionId: string, root: string) => void;
}

export function NewSunxDialog(props: NewSunxDialogProps): JSX.Element | null {
  const { open, onClose, conn, onOpenSession } = props;
  const [name, setName] = useState('');
  const [charter, setCharter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 模板清单(P2 Task 6):空数组=无模板态(选择器隐藏);templateId=下拉当前选中(空串=未选) */
  const [templates, setTemplates] = useState<SunxTemplateEntry[]>([]);
  const [templateId, setTemplateId] = useState('');
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

  /** open 翻真即重置表单(草稿不残留;工作目录由 hook 回源落默认锚) */
  useEffect(() => {
    if (!open) return;
    setName('');
    setCharter('');
    setBusy(false);
    setError('');
    setProjOpen(false);
    setHint('');
    setDirOpen(false);
  }, [open]);

  /** 模板清单惰拉(P2 Task 6;2026-11-15 随工作目录下拉改锚):锚=当前 picked——项目级模板随
   *  所选工作区装配(切目录重拉,清单跟随);锚空=仅全局清单。失败静默=无模板态——模板只服务
   *  表单挑选,error 不示出,零打扰创建主流程;alive 闸过期的迟到应答 */
  useEffect(() => {
    if (!open) return;
    setTemplates([]);
    setTemplateId('');
    let alive = true;
    const anchor = picked.trim() === '' ? undefined : picked.trim();
    conn
      .sunxTemplates(anchor)
      .then((r) => {
        if (alive) setTemplates(r.entries);
      })
      .catch(() => undefined); // 失败静默:清单保持空=选择器隐藏
    return () => {
      alive = false;
    };
  }, [open, conn, picked]);

  /** 关闭径:ESC。busy(提交在途)拒关——fix round 1(2026-11-15 审查 Important);弹层/登记面
   *  逐层先收(品性草稿不丢),表单面才整弹窗关 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (busy) return;
      if (projOpen) {
        setProjOpen(false);
        return;
      }
      if (dirOpen) {
        setDirOpen(false);
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, projOpen, dirOpen, busy, onClose]);

  /** 下拉弹层点外收(弹层面+.sx-sunx-ws-bar 锚外 mousedown) */
  usePopOutsideClose(projOpen, '.proj-pop', '.sx-sunx-ws-bar', () => setProjOpen(false));

  if (!open) return null;

  const target = picked.trim() === '' ? 'default' : picked.trim();
  /** 显示名(欢迎页同款):默认锚行=「默认工作区」,其余=目录 basename */
  const isDefaultPicked = (() => {
    const nm = pathBasename(target);
    return nm === 'default' || nm.startsWith('sunshinex-default');
  })();
  const wsLabel = isDefaultPicked ? t('Default workspace', '默认工作区') : pathBasename(target);
  /** 姓名必填(trim 后非空)+ busy 锁(提交中禁重复提交) */
  const canSubmit = name.trim() !== '' && !busy;

  const submit = (): void => {
    if (!canSubmit) return;
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

  return createPortal(
    <div
      className="modal-overlay"
      onClick={() => {
        // 点外关:busy 拒关(fix round 1 同 ESC——创建中不可取消);弹层/登记面逐层先收
        if (busy) return;
        if (projOpen) setProjOpen(false);
        else if (dirOpen) setDirOpen(false);
        else onClose();
      }}
    >
      <div className="modal-body sx-sunx-dialog" role="dialog" aria-label={t('New Sunx', '新建 Sunx')} onClick={(e) => e.stopPropagation()}>
        <header className="dirpicker-head">
          <span>{t('New Sunx', '新建 Sunx')}</span>
          {/* ✕ 同取消钮 disabled={busy}——第三关闭路径 busy 拒关(fix round 1) */}
          <button type="button" aria-label="close sunx dialog" disabled={busy} onClick={onClose}>
            ✕
          </button>
        </header>
        {/* 模板挑选(P2 Task 6):表单态顶部下拉;无模板数据=不渲染(选择器不阻塞手填)。
            选中回填 name/charter 可改;shadowed 行不进选项(生效视图口径,模块头注) */}
        {templates.length > 0 && (
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
            {busy ? t('Creating…', '创建中…') : t('Create', '创建')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

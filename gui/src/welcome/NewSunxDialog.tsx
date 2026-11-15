import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DirPickerResp, SunxTemplateEntry } from '../connection';
import { t } from '../i18n';
import { errText } from '../ui-util';
import { DirPicker } from '../pages/DirPicker';

/**
 * 「新建 Sunx」创建弹窗(sunx P1 Task 6,2026-11-15 用户裁定:与「新对话」同级、独立弹窗;
 * 欢迎页 composer 零改动)。三元组表单——姓名(必填,空禁提交)/工作目录(复用既有 DirPicker
 * 面,缺省=当前默认工作区锚)/品性(Charter 文本域,留空=仅总章程)。提交
 * conn.newSession(target, undefined, undefined, undefined, { kind:'sunx', name, charter? })
 * → 成功走既有 openSession 链路打开该会话并关弹窗。开合受控(open prop + onClose);关闭三径:
 * ESC/点外(遮罩)/取消钮;提交中 busy 锁禁重复提交。全局 portal 到 body(WelcomeIsoDialog
 * 同款——composer 祖先带定位上下文,内联 overlay 的 fixed 会被困住)。
 * 模板挑选(sunx P2 Task 6):表单态顶部模板下拉(GET /settings/sunx-templates 惰拉),选中即
 * 回填 name=模板 name、charter=章程全文(回填只是播种——用户改后以改后为准,不锁定);模板
 * 选择器不阻塞手填:清单空/惰拉失败=选择器隐藏,表单照常可用。被遮蔽行(shadowed)不进选项
 * (生效视图口径——同 id 被更高层级顶掉的全局行,内容已被生效版取代,入列只会重复选项)。
 */

/** 连接面(收窄子集,Connection/ProjectMenuConn 均满足):弹窗只消费这三方法 */
export interface NewSunxConn {
  dirpicker(path?: string): Promise<DirPickerResp>;
  /** 第 5 参 opts(2026-11-15 Task 4):kind/name/charter 透传——缺席字段省发,body 与旧形态逐字节相同 */
  newSession(root: string, mode?: 'acceptEdits' | 'full-access', worktree?: boolean, branch?: string, opts?: { kind?: 'sunx'; name?: string; charter?: string }): Promise<{ sessionId: string }>;
  /** GET /settings/sunx-templates(sunx P2 Task 6,模板挑选数据源):弹窗打开时惰拉一次,失败静默 */
  sunxTemplates(root?: string): Promise<{ entries: SunxTemplateEntry[]; warnings: string[] }>;
}

export interface NewSunxDialogProps {
  /** 受控开合:母体持态(false=零渲染) */
  readonly open: boolean;
  readonly onClose: () => void;
  readonly conn: NewSunxConn;
  /** 缺省工作目录锚(当前默认工作区 root;ProjectMenu defaultWorkspaceAnchor 单点供值) */
  readonly defaultRoot: string;
  /** 成功后打开新会话(既有 openSession 链路;宿主侧自带抽屉收起/清单重拉等既有装配) */
  readonly onOpenSession: (sessionId: string, root: string) => void;
}

export function NewSunxDialog(props: NewSunxDialogProps): JSX.Element | null {
  const { open, onClose, conn, defaultRoot, onOpenSession } = props;
  const [name, setName] = useState('');
  const [root, setRoot] = useState(defaultRoot);
  const [charter, setCharter] = useState('');
  /** 目录浏览面(既有 DirPicker 整面替换表单;取消/选完即回表单) */
  const [browse, setBrowse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 模板清单(P2 Task 6):空数组=无模板态(选择器隐藏);templateId=下拉当前选中(空串=未选) */
  const [templates, setTemplates] = useState<SunxTemplateEntry[]>([]);
  const [templateId, setTemplateId] = useState('');

  /** open 翻真即重置表单(锚=当前默认工作区;上一次的草稿不残留) */
  useEffect(() => {
    if (!open) return;
    setName('');
    setCharter('');
    setBrowse(false);
    setBusy(false);
    setError('');
    setRoot(defaultRoot);
  }, [open, defaultRoot]);

  /** 模板清单惰拉(P2 Task 6,Controller 裁定 5):弹窗打开取一次,root=缺省工作区锚(项目级模板
   *  随锚装配;锚空=仅全局清单)。失败静默=无模板态——模板只服务表单挑选,error 不示出,零打扰
   *  创建主流程;浏览改目录不重拉(裁定=打开时一次,锚定打开时刻的缺省工作区)。卸载/重开防竞态:
   *  alive 闸过期的迟到应答 */
  useEffect(() => {
    if (!open) return;
    setTemplates([]);
    setTemplateId('');
    let alive = true;
    conn
      .sunxTemplates(defaultRoot.trim() === '' ? undefined : defaultRoot)
      .then((r) => {
        if (alive) setTemplates(r.entries);
      })
      .catch(() => undefined); // 失败静默:清单保持空=选择器隐藏
    return () => {
      alive = false;
    };
  }, [open, conn, defaultRoot]);

  /** 关闭三径之一:ESC。busy(提交在途)拒关——fix round 1(2026-11-15 审查 Important:提交中取消
   *  仍会在 resolve 后经 .then 拽进刚取消的会话;语义=「创建中不可取消」,与取消/创建钮 disabled
   *  同面;daemon 侧提交发出即必建,拒关避免「已建未开」孤儿)。浏览面先回表单(不丢已填草稿),
   *  表单面才整弹窗关 */
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

  if (!open) return null;

  const target = root.trim() === '' ? 'default' : root.trim();
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
        // 点外关:busy 拒关(fix round 1 同 ESC——创建中不可取消);浏览面先回表单(与 ESC 同径,
        // 不丢草稿),表单面整弹窗关
        if (busy) return;
        if (browse) setBrowse(false);
        else onClose();
      }}
    >
      <div className="modal-body sx-sunx-dialog" role="dialog" aria-label={t('New Sunx', '新建 Sunx')} onClick={(e) => e.stopPropagation()}>
        {browse ? (
          /* 既有 DirPicker 面原样复用(showManual=false 藏审批勾选——侧栏添加工作区同款) */
          <DirPicker
            conn={conn}
            showManual={false}
            onCancel={() => setBrowse(false)}
            onConfirm={(p) => {
              if (p.trim() !== '') setRoot(p.trim());
              setBrowse(false);
            }}
          />
        ) : (
          <>
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
            <label className="sx-sunx-field">
              <span>{t('Working directory', '工作目录')}</span>
              <span className="sx-sunx-dir">
                <span className="sx-sunx-dir-path">{target}</span>
                <button type="button" aria-label={t('Browse…', '浏览…')} onClick={() => setBrowse(true)}>
                  {t('Browse…', '浏览…')}
                </button>
              </span>
            </label>
            <label className="sx-sunx-field">
              <span>{t('Charter', '品性')}</span>
              <textarea
                aria-label={t('Charter', '品性')}
                rows={5}
                value={charter}
                placeholder={t('Personality and rules for this Sunx; leave empty to keep only the global charter.', '这个 Sunx 的品性与守则；留空＝仅总章程')}
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
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

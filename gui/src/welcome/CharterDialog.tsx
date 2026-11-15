import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { errText } from '../ui-util';

/**
 * 品性编辑弹窗(sunx P2 Task 7):「编辑品性」行菜单的落点——打开拉当前品性预填(GET
 * /session/:id/charter 读面,conn.sessionCharter)→ textarea 编辑 → 保存 conn.editCharter
 * (POST /session/:id/charter,append-only 替代行语义=全文替换)→ 成功行内小字提示新 rev 后
 * 自动关闭。装载失败(409 非 sunx/404 不在座等)静默禁保存——textarea 锁空,保存钮 disabled
 * (宿主裁定:失败不示错不打扰,保存面整体失效)。复用弹层惯例(NewSunxDialog 同款):受控开合
 * (open prop + onClose)、全局 portal 到 body、关闭三径 ESC/点外(遮罩)/✕、提交中 busy 锁禁
 * 重复提交且三关闭路径拒关(保存在途不可取消——POST 发出即必落,拒关避免「已落未见 rev」)。
 */

/** 连接面(收窄子集,Connection 满足):弹窗只消费这两方法(sunx P2 Task 7 读/写封装) */
export interface CharterConn {
  /** GET /session/:id/charter:当前品性全文+rev;409=非 sunx 等失败走静默禁保存 */
  sessionCharter(id: string): Promise<{ text: string | null; charterRev: number }>;
  /** POST /session/:id/charter {text}:全文替换,成功回新 rev;空白 400/非 sunx 409 抛错 */
  editCharter(id: string, text: string): Promise<{ ok: true; charterRev: number }>;
}

export interface CharterDialogProps {
  /** 受控开合:母体持态(false=零渲染) */
  readonly open: boolean;
  readonly onClose: () => void;
  readonly conn: CharterConn;
  /** 寻址会话 id(宿主解析:行 liveSessionId 优先,无在座标注回落 journal id——POST 端点
   *  仅在座可写,不在座行装载即静默禁保存,打开会话后再编辑) */
  readonly sessionId: string;
}

/** 成功提示(行内小字)停留时长:可读到新 rev 再自动关 */
const SAVED_NOTICE_MS = 1400;

export function CharterDialog(props: CharterDialogProps): JSX.Element | null {
  const { open, onClose, conn, sessionId } = props;
  const [text, setText] = useState('');
  /** 装载态:loaded=预填就绪可编辑;loadFailed=静默禁保存(textarea 锁空+保存 disabled) */
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 成功新 rev(非 null=已保存,行内小字提示中,定时自动关) */
  const [savedRev, setSavedRev] = useState<number | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  /** open 翻真即重置+拉预填(每次打开重拉——他处编辑后重开不落旧草稿);竞态闸防慢应答串场 */
  useEffect(() => {
    if (!open) return;
    setText('');
    setLoaded(false);
    setLoadFailed(false);
    setBusy(false);
    setError('');
    setSavedRev(null);
    let alive = true;
    conn
      .sessionCharter(sessionId)
      .then(
        (r) => {
          if (!alive) return;
          setText(r.text ?? '');
          setLoaded(true);
        },
        () => {
          if (!alive) return;
          setLoadFailed(true); // 静默禁保存:不示错,保存面整体失效
        },
      );
    return () => {
      alive = false;
    };
  }, [open, conn, sessionId]);

  /** 关闭路径(busy 拒关——保存在途不可取消,NewSunxDialog 同款纪律;成功提示期即关可省时) */
  const requestClose = (): void => {
    if (busy) return;
    window.clearTimeout(closeTimer.current);
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      requestClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]); // busy 进闭包(拒关语义实时);成功提示期 busy=false 即关可省时

  if (!open) return null;

  /** 空白禁保存(替换语义=全文替换,空 text 后端 400);装载失败/在途同样禁 */
  const canSave = loaded && !busy && text.trim() !== '';

  const submit = (): void => {
    if (!canSave) return;
    setBusy(true);
    setError('');
    conn
      .editCharter(sessionId, text)
      .then(
        ({ charterRev }) => {
          setBusy(false);
          setSavedRev(charterRev); // 行内小字提示新 rev,停留一拍再自动关
          window.clearTimeout(closeTimer.current);
          closeTimer.current = window.setTimeout(onClose, SAVED_NOTICE_MS);
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
        // 点外关:busy 拒关(保存在途不可取消);成功提示期点击即关(可省时)
        requestClose();
      }}
    >
      <div className="modal-body sx-sunx-dialog" role="dialog" aria-label={t('Edit charter', '编辑品性')} onClick={(e) => e.stopPropagation()}>
        <header className="dirpicker-head">
          <span>{t('Edit charter', '编辑品性')}</span>
          {/* ✕ 同取消钮 disabled={busy}——第三关闭路径 busy 拒关(NewSunxDialog 同款) */}
          <button type="button" aria-label="close charter dialog" disabled={busy} onClick={requestClose}>
            ✕
          </button>
        </header>
        <label className="sx-sunx-field">
          <span>{t('Charter', '品性')}</span>
          <textarea
            aria-label={t('Charter', '品性')}
            rows={8}
            value={text}
            disabled={!loaded || loadFailed}
            placeholder={
              loadFailed
                ? t('Charter unavailable for this session — open it first.', '该会话当前不可读品性——请先打开会话')
                : t('Personality and rules for this Sunx.', '这个 Sunx 的品性与守则')
            }
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {savedRev !== null ? (
          // 成功提示新 rev(行内小字;宿主裁定:保存→提示→关)——role=status 供测试/读屏锚定
          <p className="sx-charter-saved" role="status">
            {t(`Saved — charter v${savedRev}`, `已保存 — 品性 v${savedRev}`)}
          </p>
        ) : (
          error !== '' && (
            <p className="dirpicker-error" role="alert">
              {error}
            </p>
          )
        )}
        <footer className="dirpicker-foot">
          <button type="button" disabled={busy} onClick={requestClose}>
            {t('Cancel', '取消')}
          </button>
          <button type="button" className="primary" disabled={!canSave} onClick={submit}>
            {busy ? t('Saving…', '保存中…') : t('Save', '保存')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

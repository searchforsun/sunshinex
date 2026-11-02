/**
 * 工具行图片渲染件单点（D62 批A 外提，行为零变化）：折叠行缩略（ToolImageThumb——dataURL 直显/
 * 本地地址经 MdImageContext loader 取回/失败占位）与 read 图片展开体（ReadImageBody——重读图片
 * 不依赖 result 帧随行 images、灯箱缩放）。props 注入零闭包依赖，ToolEntry 原位消费。
 */
import { useContext, useEffect, useState } from 'react';
import { t } from '../../i18n';
import { ImageLightbox } from '../../ImageLightbox';
import { ImageMissing } from './EntryViews';
import { MdImageContext } from './md-render';

/** read 图片行展开体(2026-10-27 用户裁定):点击展开时按路径经 MdImageContext 重读图片——
 *  不依赖 result 帧随行 images(切会话回放即丢,曾「切会话后无法再次显示」),随时可显;
 *  裸显无框无底/与其他展开行左缘对齐/contain 保比例高 240 不越行宽/点击开灯箱缩放 */
/** 工具行图片缩略(2026-10-31 用户裁定「工具下拉中的内部图片要渲染;原图删除渲染占位」):
 *  dataURL 直显;本地文件地址(截屏落盘 images-cache 后档内即地址)经 MdImageContext loader
 *  取回 dataURL;失败渲染同位占位图标识(默认缩略尺寸,不显破图) */
export function ToolImageThumb({ src, onOpen }: { src: string; onOpen: (src: string) => void }): JSX.Element {
  const loader = useContext(MdImageContext);
  const [resolved, setResolved] = useState<string | null>(src.startsWith('data:') || /^https?:/i.test(src) ? src : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (src.startsWith('data:') || /^https?:/i.test(src) || loader === null) return;
    let alive = true;
    void loader(src).then(
      (f) => {
        if (!alive) return;
        if (f.type === 'image' && f.mime !== undefined && f.data !== undefined) setResolved(`data:${f.mime};base64,${f.data}`);
        else setFailed(true);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [src, loader]);
  if (failed) return <ImageMissing name={src} size={120} />;
  if (resolved === null) return <span style={{ width: 120, height: 72, display: 'inline-block', borderRadius: 'var(--radius-sm)', border: '1px dashed var(--border)' }} aria-hidden="true" />;
  return (
    <img
      src={resolved}
      alt={t('Tool image', '工具图片')}
      className="tool-image-thumb"
      /* 原始长宽比同比缩小(2026-10-31 用户裁定「保持原始长宽比,同比缩小,不超过工具行宽度」):
         width/height auto + maxWidth 100% + maxHeight 240(与 ReadImageBody 展开体同口径) */
      style={{ width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: 240, objectFit: 'contain' }}
      onClick={() => onOpen(resolved)}
    />
  );
}

export function ReadImageBody({ path }: { path: string }): JSX.Element {
  const loader = useContext(MdImageContext);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [lightbox, setLightbox] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (loader === null) return;
    let alive = true;
    void loader(path).then(
      (f) => {
        if (!alive) return;
        if (f.type === 'image' && f.mime !== undefined && f.data !== undefined) setSrc(`data:${f.mime};base64,${f.data}`);
        else setFailed(true);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [loader, path]);
  if (src !== null) {
    return (
      <div className="tool-image-plain">
        <img src={src} alt="" onClick={() => setLightbox(src)} />
        {lightbox !== undefined && <ImageLightbox src={lightbox} onClose={() => setLightbox(undefined)} />}
      </div>
    );
  }
  if (failed) return <span className="tool-image-miss">{t('image unavailable', '图片不可用')}</span>;
  return <span className="tool-image-miss">{t('loading image…', '图片加载中…')}</span>;
}

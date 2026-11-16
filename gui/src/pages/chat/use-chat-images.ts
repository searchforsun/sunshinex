import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { MAX_IMAGES, appendImages, loadImages } from '../../images';
import { loadDraftImages, saveDraftImages } from '../../draft-images';
import { t } from '../../i18n';

/**
 * 图片附件簇(Chat 外提,D62 批I;2026-10-26):composer 待发 dataURL 列(≤8 张)——粘贴/附件
 * 选择装载,send 发送即清;查看浮层(lightbox)与提示条(超限/模型不支持)同挂本页。草稿图持久化
 * (用户裁定「发送前放到草稿中,和队列一样」):按 journalId 稳定身份落 IndexedDB——切换会话/
 * 重启回来不丢;发送即清;载入完成前跳过回写(防空初值覆盖已存档)。附件承接单点(粘贴/文件选择
 * 共用):不支持模型先拦;装载(转码)→ ≤8 张钳制→溢出提示。当前模型图片能力乐观缺省=支持
 * (sessionModel choices supportsImages 显式 false 才拦)。
 */
export function useChatImages({ archiveKey, modelInfo }: {
  archiveKey: string;
  modelInfo: { current?: string; choices: Array<{ id: string; supportsImages?: boolean }> } | null;
}): {
  pendingImages: string[];
  setPendingImages: Dispatch<SetStateAction<string[]>>;
  lightboxSrc: string | undefined;
  setLightboxSrc: Dispatch<SetStateAction<string | undefined>>;
  imgHint: string | undefined;
  showImgHint: (text: string) => void;
  modelSupportsImages: boolean;
  addImageFiles: (files: File[]) => void;
} {
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  // 草稿图持久化（用户裁定「发送前放到草稿中,和队列一样」）：按 journalId 稳定身份落 IndexedDB——
  // 切换会话/重启回来不丢;发送即清。载入完成前跳过回写（防空初值覆盖已存档）。
  const draftLoadedRef = useRef(false);
  useEffect(() => {
    draftLoadedRef.current = false;
    let alive = true;
    void loadDraftImages(archiveKey).then((imgs) => {
      if (!alive) return;
      setPendingImages(imgs);
      draftLoadedRef.current = true;
    });
    return () => { alive = false; };
  }, [archiveKey]);
  useEffect(() => {
    if (draftLoadedRef.current) void saveDraftImages(archiveKey, pendingImages);
  }, [archiveKey, pendingImages]);
  const [lightboxSrc, setLightboxSrc] = useState<string | undefined>(undefined);
  const [imgHint, setImgHint] = useState<string | undefined>(undefined);
  const imgHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (imgHintTimer.current !== null) clearTimeout(imgHintTimer.current);
  }, []);
  const showImgHint = useCallback((text: string): void => {
    setImgHint(text);
    if (imgHintTimer.current !== null) clearTimeout(imgHintTimer.current);
    imgHintTimer.current = setTimeout(() => setImgHint(undefined), 2600);
  }, []);
  /** 当前模型图片能力(乐观缺省=支持):sessionModel choices supportsImages 显式 false 才拦 */
  const modelSupportsImages = (() => {
    const cur = modelInfo?.current;
    if (cur === undefined || cur === '') return true;
    return modelInfo?.choices.find((c) => c.id === cur)?.supportsImages !== false;
  })();
  /** 附件承接单点(粘贴/文件选择共用):不支持模型先拦;装载(转码)→ ≤8 张钳制→溢出提示 */
  const addImageFiles = useCallback(
    (files: File[]): void => {
      if (!modelSupportsImages) {
        showImgHint(t('Current model does not support image input', '当前模型不支持图片输入'));
        return;
      }
      void loadImages(files).then((imgs) => {
        if (imgs.length === 0) return;
        setPendingImages((cur) => {
          const { images, overflow } = appendImages(cur, imgs);
          if (overflow > 0) showImgHint(t(`Up to ${MAX_IMAGES} images per message`, `每条消息最多 ${MAX_IMAGES} 张图片`));
          return images;
        });
      });
    },
    [modelSupportsImages, showImgHint],
  );
  return { pendingImages, setPendingImages, lightboxSrc, setLightboxSrc, imgHint, showImgHint, modelSupportsImages, addImageFiles };
}

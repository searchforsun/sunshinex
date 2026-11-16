import type { Dispatch, SetStateAction } from 'react';
import { useState } from 'react';
import { appendImages, loadImages, MAX_IMAGES } from '../images';
import { t } from '../i18n';

/** 欢迎页图片附件簇（D62 批G 外提,行为零变化）：待发 dataURL 清单+灯箱源+attach 入口——
 *  ≤8 张帽溢出提示经宿主 setHint 上抛（文案同主对话口径）。Chat 页内联实现既有,欢迎页同语言 */
export function useWelcomeImages(setHint: (msg: string) => void): {
  images: string[];
  setImages: Dispatch<SetStateAction<string[]>>;
  lightboxSrc: string | undefined;
  setLightboxSrc: (src: string | undefined) => void;
  attachImages: (files: File[]) => void;
} {
  const [images, setImages] = useState<string[]>([]);
  const [lightboxSrc, setLightboxSrc] = useState<string | undefined>(undefined);
  const attachImages = (files: File[]): void => {
    void loadImages(files).then((imgs) => {
      if (imgs.length === 0) return;
      setImages((cur) => {
        const { images: merged, overflow } = appendImages(cur, imgs);
        if (overflow > 0) setHint(t(`Up to ${MAX_IMAGES} images per message`, `每条消息最多 ${MAX_IMAGES} 张图片`));
        return merged;
      });
    });
  };
  return { images, setImages, lightboxSrc, setLightboxSrc, attachImages };
}

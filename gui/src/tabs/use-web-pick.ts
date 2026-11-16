import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** 拾取目标 webview 方法面(结构满足即收;宿主 WvElement 运行时满足) */
export interface PickWv {
  executeJavaScript?(code: string, userGesture?: boolean): Promise<unknown>;
  getWebContentsId(): number;
}

/** 元素拾取脚本(2026-11-04 元素选取面):注入页内——悬停高亮/点击捕获/Escape 取消;
 *  回传 {url,title,path,html}(html 截 2000 字防大 DOM 灌会话);capture 阶段拦截页面自身点击 */
const PICK_ELEMENT_JS = String.raw`
(() => new Promise((resolve) => {
  const mark = '__sx_pick';
  document.getElementById(mark)?.remove();
  const style = document.createElement('style');
  style.id = mark;
  style.textContent = '.__sx_pick_hover{outline:2px solid #22d3ee !important;outline-offset:1px !important;cursor:crosshair !important}';
  document.head.appendChild(style);
  let last = null;
  const cleanup = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (last) last.classList.remove('__sx_pick_hover');
    style.remove();
  };
  const onMove = (e) => {
    e.stopPropagation();
    if (last && last !== e.target) last.classList.remove('__sx_pick_hover');
    last = e.target;
    last.classList.add('__sx_pick_hover');
  };
  const describe = (el) => {
    let path = el.tagName.toLowerCase();
    if (el.id) path += '#' + el.id;
    else if (el.className && typeof el.className === 'string') path += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    return { url: location.href, title: document.title, path, html: (el.outerHTML || '').slice(0, 2000) };
  };
  const onClick = (e) => {
    e.preventDefault(); e.stopPropagation();
    cleanup();
    resolve(describe(e.target));
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); cleanup(); resolve(null); }
  };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
}))`;

/**
 * 元素选取簇(WebTab 外提,D62 批J;2026-11-04 用户裁定「选中元素发到会话,补页签 id/网址等
 * 元数据」):注入拾取脚本→悬停高亮→点击捕获(定位路径+outerHTML 片段)+页元数据,Escape 取消;
 * DevTools 开着也能用(不走其选中态,通道独立)。两入口:发主对话(事件通道)/发辅助会话。
 * 2026-11-04 CDP Overlay inspect 改宗+交互简化(用户裁定):工具条独立钮(自由尺寸前,检视中
 * active 态)→原生高亮+showInfo 信息条→点击直投主对话;点网页外/Esc 自动退出。
 */
export function useWebPick(wvRef: RefObject<PickWv | null>): {
  pickState: 'idle' | 'picking' | 'failed';
  pickElement: () => Promise<void>;
} {
  const [pickState, setPickState] = useState<'idle' | 'picking' | 'failed'>('idle');
  /** 桥面拾取在途态(订阅回调寻址;refs 免闭包陈旧) */
  const pickWcRef = useRef(0);
  const pickViaBridgeRef = useRef(false);
  /** 拾取结果直投主对话(2026-11-04 用户裁定「点击后自动放到主对话框,不用再次点击」:选择卡
   *  两段式退役)——⟦token⟧ 简标识落 composer(内容入账本发送期展开) */
  const insertPicked = (el: { wcId: number; url: string; title: string; path: string; html: string }): void => {
    const content = [
      '```browser-element',
      `页签 #${el.wcId}`,
      `标题: ${el.title}`,
      `网址: ${el.url}`,
      `定位: ${el.path}`,
      '---',
      el.html,
      '```',
    ].join('\n');
    const token = `⟦   网页#${el.wcId.toString(36)} · ${el.path}⟧`;
    window.dispatchEvent(new CustomEvent('sunshinex:insert-ref', { detail: { kind: 'ref', token, content } }));
  };
  const exitPick = (): void => {
    pickViaBridgeRef.current = false;
    void window.sunshinexWindow?.pickElementStop?.(pickWcRef.current);
    setPickState('idle');
  };
  /** 桥面拾取结果订阅:节点点击=直投主对话收口;null=Esc 取消。mount 级订阅一次,wcId 寻址判非本页忽略 */
  useEffect(() => {
    const sub = window.sunshinexWindow?.onPickNode;
    if (sub === undefined) return;
    return sub((wcId, info) => {
      if (pickViaBridgeRef.current !== true || pickWcRef.current !== wcId) return;
      exitPick();
      if (info !== null && info.html !== '') insertPicked({ wcId, url: info.url, title: info.title, path: info.path, html: info.html });
    });
  }, []);
  // 点击非网页区=自动退出(2026-11-04 用户裁定):host DOM 事件不经 webview,网页内点击被
  // inspect 模式拦截不冒泡到宿主——picking 期宿主任一 pointerdown 即页外,捕获段先于 UI 处理
  useEffect(() => {
    if (pickState !== 'picking' || pickViaBridgeRef.current !== true) return;
    const onDown = (): void => exitPick();
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [pickState]);
  // 卸载兜底:拾取在途即退(检视态悬着+debugger 挂着都不可残留)
  useEffect(
    () => () => {
      if (pickViaBridgeRef.current) void window.sunshinexWindow?.pickElementStop?.(pickWcRef.current);
    },
    [],
  );
  const pickElement = async (): Promise<void> => {
    const wv = wvRef.current;
    if (wv === null) return;
    if (pickState === 'picking') {
      // 检视中再点=取消(2026-11-04 用户裁定:按钮开合态随检视,选中/点外/Esc/再点均收)
      exitPick();
      return;
    }
    const failHint = (): void => {
      // 2026-11-04 用户裁定:失败提示=通知框形态,3s 自愈回落,不常驻
      setPickState('failed');
      window.setTimeout(() => setPickState((c) => (c === 'failed' ? 'idle' : c)), 3000);
    };
    const bridge = window.sunshinexWindow?.pickElementStart;
    if (bridge !== undefined && wv.executeJavaScript !== undefined) {
      // 桌面壳桥面(2026-11-04 用户裁定「任何页面都能选取,参考开源实现」):CDP Overlay inspect=
      // DevTools 检视同源——原生蓝框+showInfo 信息条+点击拦截在浏览器层,不注脚本,
      // 任意 CSP/框架页面可用(注入版被页面环境卡死即此弃因)。结果经 onPickNode 回投
      let wcId = 0;
      try {
        wcId = wv.getWebContentsId();
      } catch {
        failHint();
        return;
      }
      setPickState('picking');
      pickWcRef.current = wcId;
      pickViaBridgeRef.current = true;
      const r = await bridge(wcId).catch(() => ({ ok: false, error: 'bridge failed' }));
      if (r.ok !== true) {
        pickViaBridgeRef.current = false;
        failHint();
      }
      return;
    }
    // 注入兜底(纯浏览器 iframe 态/旧壳):原 executeJavaScript 拾取脚本,同样直投主对话
    if (wv.executeJavaScript === undefined) return;
    let wcId = 0;
    try {
      wcId = wv.getWebContentsId();
    } catch {
      failHint();
      return;
    }
    setPickState('picking');
    try {
      const picked = (await wv.executeJavaScript(PICK_ELEMENT_JS, true)) as { url: string; title: string; path: string; html: string } | null;
      setPickState('idle');
      if (picked === null || picked.html === '') return; // Esc 取消
      insertPicked({ wcId, url: picked.url, title: picked.title, path: picked.path, html: picked.html });
    } catch {
      failHint(); // 注入失败可见化(导航中/CSP/页环境异常)
    }
  };
  return { pickState, pickElement };
}

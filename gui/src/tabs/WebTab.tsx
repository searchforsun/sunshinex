import { useState } from 'react';
import type { TabParams } from './tab-state';

/**
 * G8d Web 标签体(T4):URL 输入 → iframe 沙盒内嵌呈现(spec §1 工具组)。受控 url 输入
 * (sx-web-url;回车或「打开」钮 → active 落定:去首尾空白,无 :// 前缀补 https://——
 * example.com → https://example.com,http://localhost:3000 原样);iframe 以
 * key=`${active}#${nonce}` 挂载(url 变更/「刷新」钮 bump nonce 均强制重挂 = 重载),
 * sandbox 四值(allow-scripts allow-forms allow-same-origin allow-popups)、title=active
 * (无障碍名/测试锚)。「外开」钮 window.open(active,'_blank','noopener,noreferrer')
 * (noop 隔离 opener)。外站 X-Frame-Options 拒嵌浏览器侧不可探测(iframe load 失败无回执
 * 面),故恒示引导文案(title=active 提示 + 「在系统浏览器打开」引流外开钮);jsdom 不渲染
 * iframe 内容——测试断言框架属性/输入/按钮行为。sx-web-* 伴生样式归 G8d-e(app.css 冻结期,
 * 与 DiffTab/AgentsTab 同裁定)。
 */

export interface WebTabProps {
  /** 开档参数:url 可选(带 url 开档即直开;「+」菜单裸开 = 空输入引导面) */
  readonly params: TabParams;
}

/** url 规范化:去首尾空白;无 :// 前缀(无 scheme)补 https:// */
export function normalizeWebUrl(raw: string): string {
  const t = raw.trim();
  return t.includes('://') ? t : `https://${t}`;
}

export function WebTab({ params }: WebTabProps): JSX.Element {
  const [input, setInput] = useState(params.url ?? '');
  const [active, setActive] = useState<string | null>(() => {
    const raw = (params.url ?? '').trim();
    return raw === '' ? null : normalizeWebUrl(raw);
  });
  /** 刷新 bump:入 iframe key —— 变更即强制重挂(= 重新加载) */
  const [nonce, setNonce] = useState(0);

  const open = (): void => {
    if (input.trim() === '') return; // 空输入不开档(与 Chat 空输入 Enter 同口径)
    setActive(normalizeWebUrl(input));
  };

  return (
    <div className="sx-web-tab" aria-label="web tab">
      <div className="sx-web-bar">
        <input
          className="sx-web-url"
          aria-label="web url input"
          value={input}
          placeholder="https://…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') open();
          }}
        />
        <button type="button" className="sx-web-open" onClick={open}>
          打开
        </button>
        {active !== null && (
          <>
            <button
              type="button"
              className="sx-web-ext"
              title="在系统浏览器打开"
              onClick={() => window.open(active, '_blank', 'noopener,noreferrer')}
            >
              外开
            </button>
            <button type="button" className="sx-web-reload" onClick={() => setNonce((n) => n + 1)}>
              刷新
            </button>
          </>
        )}
      </div>
      {active === null ? (
        <p className="sx-web-empty">输入 URL 回车打开;外站若经 X-Frame-Options 拒绝内嵌,可「外开」在系统浏览器打开。</p>
      ) : (
        <>
          <iframe
            key={`${active}#${nonce}`}
            className="sx-web-frame"
            title={active}
            src={active}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
          />
          <p className="sx-web-hint">
            {`空白页?站点可能经 X-Frame-Options 拒绝内嵌——「外开」在系统浏览器打开(${active})。`}
          </p>
        </>
      )}
    </div>
  );
}

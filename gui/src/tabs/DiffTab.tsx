import { useEffect, useState } from 'react';
import { DiffPanel } from '../diff-panel';
import type { Connection, DiffResp } from '../connection';
import type { TabParams } from './tab-state';

/**
 * G8d Diff 标签体(T2):write 调用的 pre-image ↔ 磁盘现文件双列呈现(spec §2 Diff 行)。
 * mount 以 params.callId 拉 conn.fetchDiff(sessionId, callId)(G7 既有面)→ 成功:标题行
 * (path = params.path 优先回落应答 path;oldContent 缺场 →「新建」标;truncated → 截断横幅)
 * + DiffPanel 双列复用(G6 既有渲染——old 缺场自动单列现内容);404 无快照(daemon {error:
 * 'no-snapshot'} 面,连接层以 HTTP 失败抛——消息含状态码)→ 行内降级错误条带 callId;其他
 * HTTP 失败原文示出;callId 缺场(「+」菜单裸开)→ 引导文案不拉。状态随挂载(切标签卸毁即失,
 * 重挂重拉——Files/DirectoryTab 同口径)。sx-diff-* 伴生样式归 G8d-e(app.css 冻结期)。
 */

export interface DiffTabProps {
  readonly conn: Connection;
  /** 当前会话(:id 寻址维) */
  readonly sessionId: string;
  /** 开档参数:callId 寻址判重键;path 可选(title 与标题行的可读优先面——Chat 开档时透传) */
  readonly params: TabParams;
}

/** 拉取态四分:在途 / 404 无快照降级 / 其他错误(原文) / 成功 */
type DiffLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'no-snapshot'; readonly callId: string }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'loaded'; readonly resp: DiffResp };

export function DiffTab({ conn, sessionId, params }: DiffTabProps): JSX.Element {
  const [load, setLoad] = useState<DiffLoad>({ status: 'loading' });
  const callId = params.callId;

  useEffect(() => {
    if (callId === undefined) return; // 裸开档(无 callId):不拉,引导文案面
    let alive = true;
    setLoad({ status: 'loading' });
    conn.fetchDiff(sessionId, callId).then(
      (resp) => {
        if (alive) setLoad({ status: 'loaded', resp });
      },
      (err: unknown) => {
        if (!alive) return;
        const message = err instanceof Error ? err.message : String(err);
        // 404 = 无快照(环已裁或非 write)——降级文案面;其余(HTTP 面)原文示出不静默
        if (message.includes('-> 404')) setLoad({ status: 'no-snapshot', callId });
        else setLoad({ status: 'error', message });
      },
    );
    return () => {
      alive = false; // 卸载弃在途应答(标签体已不在场)
    };
  }, [conn, sessionId, callId]);

  if (callId === undefined) {
    return (
      <div className="sx-diff-tab" aria-label="diff tab">
        <div className="sx-diff-status">无 callId——从对话 write 工具条目的路径钮打开。</div>
      </div>
    );
  }
  if (load.status === 'loading') {
    return (
      <div className="sx-diff-tab" aria-label="diff tab">
        <div className="sx-diff-status" role="status">
          diff 加载中…
        </div>
      </div>
    );
  }
  if (load.status === 'no-snapshot') {
    return (
      <div className="sx-diff-tab" aria-label="diff tab">
        <div className="sx-diff-error">{`无快照(环已裁或非 write)——callId: ${load.callId}`}</div>
      </div>
    );
  }
  if (load.status === 'error') {
    return (
      <div className="sx-diff-tab" aria-label="diff tab">
        <div className="sx-diff-error">{load.message}</div>
      </div>
    );
  }
  const resp = load.resp;
  return (
    <div className="sx-diff-tab" aria-label="diff tab">
      <div className="sx-diff-head">
        <span className="sx-diff-path" title={resp.path}>
          {params.path ?? resp.path}
        </span>
        {resp.oldContent === undefined && <span className="sx-diff-badge">新建</span>}
        {resp.truncated === true && <span className="sx-diff-truncated">内容超限已截断</span>}
      </div>
      <DiffPanel oldStr={resp.oldContent} newStr={resp.newContent} />
    </div>
  );
}

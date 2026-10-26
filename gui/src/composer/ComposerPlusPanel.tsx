import { useEffect, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { t, getLanguage } from '../i18n';
import { IMAGE_ACCEPT } from '../images';
import { FileIcon } from '../file-icon';

/**
 * 「+」附加面板(G12 统一 composer):浮在输入卡上方、与卡同宽(absolute left/right 0,锚
 * `.sx-composer`,经 ComposerCard overlays 槽渲染)。四区列表:
 * - 附件(2026-10-26 图片功能,置首):图片选择——系统文件资源管理器(input type=file
 *   accept=image/*),多选;调用面 onAttachImages 承接装载与 ≤8 张钳制。欢迎页不传不渲染;
 * - 命令:GET /commands,点击插入 `/cmd `(回车执行——会话内走 / 命令通道);
 * - 技能:GET /settings/skills 三源(project/user/learned)按 id 去重合并,点击插入 `/<id>`
 *   (G14.213 skills 纯文本语义:不再走 /skill <id> 命令形态——daemon 已 400);
 * - 文件:仅会话内(sessionId 在场)——GET /session/:id/tree 逐级浏览工作区目录,点击文件插入
 *   相对路径;欢迎页无会话不渲染此区。
 * 插入即收口:调用面 onInsert 负责落文本+关面板+焦点回输入框。
 */
export interface PlusPanelConn {
  commands(): Promise<{ commands: string[]; descriptions: Record<string, string>; supported: string[] }>;
  skillsGroups(root?: string): Promise<{
    groups: Array<{ source: string; skills: Array<{ id: string; name?: string; description?: string }> }>;
  }>;
  tree(sessionId: string, path?: string): Promise<{ entries: Array<{ name: string; kind: 'dir' | 'file' }>; truncated?: boolean }>;
  /** G14.128 工作区文件索引(文件区平铺:名+相对目录,最近改动优先);缺省回落 tree 浏览 */
  workspaceFiles?(root: string): Promise<{ files: Array<{ path: string; mtime: number }> }>;
}

function parentOf(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

/** 内置命令描述 zh 面(2026-10-26 用户报障「命令要显示中文」):daemon /commands 描述随
 *  **daemon** 语言(settings 链)装配,GUI 语言独立时英文穿透——本表按 GUI 语言取词,
 *  zh 命中即用,en 回落 daemon 原文;键=去斜杠命令词,与 src/tui/slash-commands.ts 同源口径 */
const CMD_DESC_ZH: Record<string, string> = {
  help: '查看可用命令',
  init: '分析生成/完善 SUNSHINE.md',
  status: '会话与账本摘要',
  'terminal-setup': '配置终端键位（Shift+Enter 换行，Windows Terminal）',
  tasks: '列出后台任务',
  skill: '加载技能进上下文',
  new: '新会话（软重置）',
  resume: '恢复已保存会话',
  rewind: '回退到更早的任务轮',
  fork: '分叉出平行会话',
  btw: '辅助问答（fork 旁路，不进主链）：/btw <问题>',
  side: '辅助问答（/btw 别名）',
  archive: '归档当前会话（移出主列表）',
  unarchive: '撤销归档（选择卡）',
  delete: '删除当前会话（须先归档）',
  compact: '压缩上下文',
  context: '上下文各段占比与大小',
  plan: '先规划后执行',
  goal: '运行完整验收修正环',
  model: '切换模型（多源清单）',
  'model-tier': '切换模型档位',
  'model-effort': '切换思考强度',
  'add-dir': '扩展信任目录',
  'kb-index': '构建知识库索引',
  memory: '列出持久记忆',
  'memory-add': '添加记忆',
  'memory-rm': '删除记忆（多选卡）',
  'memory-gc': '立即整理记忆',
  'memory-on': '本会话开启持久记忆',
  'memory-off': '本会话关闭持久记忆',
};

export function ComposerPlusPanel({
  conn,
  sessionId,
  root,
  onInsert,
  onAttachImages,
}: {
  conn: PlusPanelConn;
  /** 在场 = 会话内:文件区可浏览(tree);欢迎页不传 → 文件区不渲染 */
  sessionId?: string;
  /** 工作区 root(skills 的 project 组源);缺省只拉 user/learned */
  root?: string;
  onInsert: (text: string) => void;
  /** 图片附件(2026-10-26 置首区):文件选择承接(装载+钳制在调用面);未配不渲染附件区 */
  onAttachImages?: (files: File[]) => void;
}): JSX.Element {
  const [cmds, setCmds] = useState<Array<{ name: string; desc: string }> | null>(null);
  const [skills, setSkills] = useState<Array<{ id: string; desc: string }> | null>(null);
  /** 文件浏览当前目录('' = 会话 root)与目录项;null = 加载中 */
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<Array<{ name: string; kind: 'dir' | 'file' }> | null>(null);
  const [truncated, setTruncated] = useState(false);
  const filePickRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    conn.commands().then(
      (r) => {
        if (!alive) return;
        // G14.145 只列可用命令(supported 在场即过滤)+行内说明(descriptions 键不带斜杠,双键兼容)
        const supported = Array.isArray(r.supported) ? r.supported : [];
        setCmds(
          r.commands
            .filter((c) => supported.length === 0 || supported.includes(c))
            .map((c) => { const bare = c.replace(/^\//, ''); const daemonDesc = r.descriptions[c] ?? r.descriptions[bare] ?? ''; return { name: c, desc: getLanguage() === 'zh' ? (CMD_DESC_ZH[bare] ?? daemonDesc) : daemonDesc }; }),
        );
      },
      () => {
        if (alive) setCmds([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [conn]);

  useEffect(() => {
    let alive = true;
    conn.skillsGroups(root).then(
      (r) => {
        if (!alive) return;
        const seen = new Set<string>(); // 跨源同 id 去重(面板单列,遮蔽裁决属装配面)
        const rows: Array<{ id: string; desc: string }> = [];
        for (const g of r.groups) {
          for (const s of g.skills) {
            if (seen.has(s.id)) continue;
            seen.add(s.id);
            rows.push({ id: s.id, desc: s.description ?? s.name ?? '' });
          }
        }
        if (alive) setSkills(rows);
      },
      () => {
        if (alive) setSkills([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [conn, root]);

  useEffect(() => {
    if (sessionId === undefined) return;
    let alive = true;
    setEntries(null);
    conn.tree(sessionId, path).then(
      (r) => {
        if (!alive) return;
        setEntries(r.entries);
        setTruncated(r.truncated === true);
      },
      () => {
        if (alive) setEntries([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [conn, sessionId, path]);

  /** G14.128 文件区平铺(工作区索引):名+相对目录后缀,最近改动优先;root 缺场回落 tree 浏览 */
  const [indexed, setIndexed] = useState<Array<{ rel: string; base: string; dir: string }> | null>(null);
  useEffect(() => {
    if (root === undefined || root === '' || conn.workspaceFiles === undefined) {
      setIndexed(null);
      return;
    }
    let alive = true;
    conn.workspaceFiles(root).then(
      (r) => {
        if (!alive) return;
        setIndexed(
          r.files.slice(0, 60).map((f) => {
            const si = f.path.lastIndexOf('/');
            return {
              rel: f.path,
              base: si < 0 ? f.path : f.path.slice(si + 1),
              dir: si < 0 ? '' : f.path.slice(0, si + 1),
            };
          }),
        );
      },
      () => {
        if (alive) setIndexed(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [conn, root]);

  return (
    <div className="sx-plus-panel" role="menu" aria-label={t('Add context', '添加附件')}>
      {/* 附件区(2026-10-26 置首):图片选择开系统文件资源管理器;隐藏 input 承接 onChange */}
      {onAttachImages !== undefined && (
        <>
          <div className="sx-plus-sec">{t('Attach', '附件')}</div>
          <button
            type="button"
            role="menuitem"
            className="sx-plus-row"
            data-tip={t('Open file picker, up to 8', '打开文件选择器,最多 8 张')}
            onClick={() => filePickRef.current?.click()}
          >
            <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className="sx-plus-name">{t('Select images', '选择图片')}</span>
          </button>
          <input
            ref={filePickRef}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            className="sx-plus-file-input"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = ''; // 重置:同批文件可重复选择
              if (files.length > 0) onAttachImages(files);
            }}
          />
        </>
      )}
      <div className="sx-plus-sec">{t('Commands', '命令')}</div>
      {cmds === null && <div className="sx-plus-empty">{t('Loading…', '加载中…')}</div>}
      {cmds !== null && cmds.length === 0 && <div className="sx-plus-empty">{t('No commands', '暂无命令')}</div>}
      {cmds?.map((c) => (
        <button key={c.name} type="button" role="menuitem" className="sx-plus-row" data-tip={c.desc} onClick={() => onInsert(c.name + ' ')}>
          <span className="sx-plus-name">{c.name}</span>
          <span className="sx-plus-desc">{c.desc}</span>
        </button>
      ))}
      <div className="sx-plus-sec">{t('Skills', '技能')}</div>
      {skills === null && <div className="sx-plus-empty">{t('Loading…', '加载中…')}</div>}
      {skills !== null && skills.length === 0 && <div className="sx-plus-empty">{t('No skills', '暂无技能')}</div>}
      {skills?.map((s) => (
        <button key={s.id} type="button" role="menuitem" className="sx-plus-row" data-tip={s.desc} onClick={() => onInsert(`/${s.id} `)}>
          <span className="sx-plus-name">{s.id}</span>
          <span className="sx-plus-desc">{s.desc}</span>
        </button>
      ))}
      {/* G14.128 文件区:root 索引在场即渲染(欢迎页也可用);否则会话内回落 tree 浏览 */}
      {(indexed !== null || sessionId !== undefined) && (
        <>
          <div className="sx-plus-sec">{t('Files', '文件')}</div>
          {indexed !== null ? (
            <>
              {/* G14.128 平铺索引:名+相对目录后缀(@ 同源),点击插入 @相对路径 */}
              {indexed.length === 0 && <div className="sx-plus-empty">{t('(empty)', '(空)')}</div>}
              {indexed.map((f) => (
                <button key={f.rel} type="button" role="menuitem" className="sx-plus-row" onClick={() => onInsert(`@${f.rel} `)}>
                  <FileIcon path={f.rel} />
                  <span className="sx-plus-name">{f.base}</span>
                  {f.dir !== '' && <span className="sx-plus-desc">{f.dir}</span>}
                </button>
              ))}
            </>
          ) : (
            <>
              {path !== '' && (
                <button
                  type="button"
                  role="menuitem"
                  className="sx-plus-row"
                  onClick={() => setPath(parentOf(path))}
                >
                  <span className="sx-plus-name">../</span>
                  <span className="sx-plus-desc">{path}</span>
                </button>
              )}
              {entries === null && <div className="sx-plus-empty">{t('Loading…', '加载中…')}</div>}
              {entries !== null && entries.length === 0 && <div className="sx-plus-empty">{t('(empty)', '(空)')}</div>}
              {entries?.map((e) => {
                const rel = path === '' ? e.name : `${path}/${e.name}`;
                return e.kind === 'dir' ? (
                  <button key={rel} type="button" role="menuitem" className="sx-plus-row" onClick={() => setPath(rel)}>
                    <FileIcon path={rel} folder />
                    <span className="sx-plus-name">{e.name}/</span>
                  </button>
                ) : (
                  <button key={rel} type="button" role="menuitem" className="sx-plus-row" onClick={() => onInsert(`@${rel} `)}>
                    <FileIcon path={rel} />
                    <span className="sx-plus-name">{e.name}</span>
                  </button>
                );
              })}
              {truncated && <div className="sx-plus-empty">{t('…truncated', '…已截断')}</div>}
            </>
          )}
        </>
      )}
    </div>
  );
}

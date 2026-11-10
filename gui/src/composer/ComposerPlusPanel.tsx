import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { t } from '../i18n';
import { cmdDescOf } from '../CommandPalette';
import { IMAGE_ACCEPT } from '../images';
import { FileIcon } from '../file-icon';

/**
 * 「+」附加面板(G12 统一 composer):浮在输入卡上方、与卡同宽(absolute left/right 0,锚
 * `.sx-composer`,经 ComposerCard overlays 槽渲染)。六区列表:
 * - 附件(2026-10-26 图片功能,置首):图片选择——系统文件资源管理器(input type=file
 *   accept=image/*),多选;调用面 onAttachImages 承接装载与 ≤8 张钳制。欢迎页不传不渲染;
 * - 命令:GET /commands,点击插入 `/cmd `(回车执行——会话内走 / 命令通道);
 * - 技能:GET /settings/skills 三源(project/user/learned)按 id 去重合并,点击插入 `/<id>`
 *   (G14.213 skills 纯文本语义:不再走 /skill <id> 命令形态——daemon 已 400);
 * - 智能体(2026-11-05 用户裁定,与技能区同构):agentsView 内置四角色+两级注册表生效集
 *   (builtin-first 去重),点击插入 `$<id> `——$ 软引用纯文本,提交链零改动;
 * - 智能体团队(同上):teamsView 生效集,点击插入 `#<id> `;
 * - 文件:仅会话内(sessionId 在场)——GET /session/:id/tree 逐级浏览工作区目录,点击文件插入
 *   相对路径;欢迎页无会话不渲染此区。
 * 插入即收口:调用面 onInsert 负责落文本+关面板+焦点回输入框。
 */
export interface PlusPanelConn {
  commands(): Promise<{ commands: string[]; descriptions: Record<string, string>; supported: string[] }>;
  skillsGroups(root?: string): Promise<{
    groups: Array<{ source: string; skills: Array<{ id: string; name?: string; description?: string; disabled?: boolean }> }>;
  }>;
  /** 智能体/团队区数据源(2026-11-05;可选——桩面未挂即区块不渲染) */
  agentsView?(root?: string): Promise<{ builtins: Array<{ role: string; name: string }>; view: { entries: Array<{ id: string; name: string; shadowed?: boolean }>; warnings: string[] } }>;
  teamsView?(root?: string): Promise<{ view: { entries: Array<{ id: string; name: string; shadowed?: boolean }>; warnings: string[] } }>;
  tree(sessionId: string, path?: string): Promise<{ entries: Array<{ name: string; kind: 'dir' | 'file' }>; truncated?: boolean }>;
  /** G14.128 工作区文件索引(文件区平铺:名+相对目录,最近改动优先);缺省回落 tree 浏览 */
  workspaceFiles?(root: string): Promise<{ files: Array<{ path: string; mtime: number }> }>;
}

function parentOf(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

/** 内置命令描述 zh 面已上移 CommandPalette.cmdDescOf 单源(2026-10-31;两面板同数据源同口径,
 *  渲染期 t 求值随语言切换——原 getLanguage() 装载期取词在切换后滞后,一并退役) */

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
            .map((c) => { const bare = c.replace(/^\//, ''); return { name: c, desc: r.descriptions[c] ?? r.descriptions[bare] ?? '' }; }),
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
            if (s.disabled === true) continue; // 停用技能(2026-11-07 加载开关)不进 + 面板技能区
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

  /** 智能体/团队区数据(2026-11-05):内置四角色+生效集(builtin-first 去重,shadowed 行剔除);
   *  失败静默空列(区块显示「暂无」,不拖垮其余分区)。root 同 Chat 守卫(空/'default'=全局) */
  const [agents, setAgents] = useState<Array<{ id: string; name: string }> | null>(null);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }> | null>(null);
  useEffect(() => {
    if (conn.agentsView === undefined || conn.teamsView === undefined) return;
    const refRoot = root !== undefined && root !== '' && root !== 'default' ? root : undefined;
    let alive = true;
    void Promise.all([conn.agentsView(refRoot), conn.teamsView(refRoot)]).then(
      ([a, tv]) => {
        if (!alive) return;
        setAgents([
          ...a.builtins.map((b) => ({ id: b.role, name: b.name })),
          ...a.view.entries.filter((e) => e.shadowed !== true).map((e) => ({ id: e.id, name: e.name })),
        ].filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i));
        setTeams(tv.view.entries.filter((e) => e.shadowed !== true).map((e) => ({ id: e.id, name: e.name })));
      },
      () => {
        if (!alive) return;
        setAgents([]);
        setTeams([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [conn, root]);

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

  /** 高度不足量测(2026-11-10 用户裁定「不足以展示全部弹窗高度就把输入框整体覆盖」):锚上方空间
   *  < 满高 360 即挂 cover 类——面板整体下移覆盖 composer,不再向上裁切 */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [cover, setCover] = useState(false);
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    if (r.top < 8) {
      // 不止挂 cover:按缺口下移(缺口=顶部越界量),相对锚式 calc 减缺口——覆盖整个 composer 也在所不惜
      setCover(true);
      const shift = Math.round(8 - r.top);
      el.style.bottom = `calc(100% + 8px - ${shift}px)`;
    } else setCover(false);
  }, []);
  return (
    <div ref={panelRef} className={'sx-plus-panel' + (cover ? ' cover' : '')} role="menu" aria-label={t('Add context', '添加附件')}>
      <div className="sx-plus-scroll">
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
      {/* 引用区已退役(2026-11-05 用户裁定:改为技能区后的 智能体/智能体团队 实体分组——见下) */}
      <div className="sx-plus-sec">{t('Commands', '命令')}</div>
      {cmds === null && <div className="sx-plus-empty">{t('Loading…', '加载中…')}</div>}
      {cmds !== null && cmds.length === 0 && <div className="sx-plus-empty">{t('No commands', '暂无命令')}</div>}
      {cmds?.map((c) => (
        <button key={c.name} type="button" role="menuitem" className="sx-plus-row" data-tip={cmdDescOf(c.name, c.desc)} onClick={() => onInsert(c.name + ' ')}>
          <span className="sx-plus-name">{c.name}</span>
          <span className="sx-plus-desc">{cmdDescOf(c.name, c.desc)}</span>
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
      {/* 智能体/智能体团队区(2026-11-05 用户裁定:与技能区同构的实体分组,置于技能后)——
          内置四角色+生效集(builtin-first 去重),点击插 `$<id> `/`#<id> `($ # 软引用纯文本) */}
      {conn.agentsView !== undefined && (
        <>
          <div className="sx-plus-sec">{t('Sub-agents', '子智能体')}</div>
          {agents === null && <div className="sx-plus-empty">{t('Loading…', '加载中…')}</div>}
          {agents !== null && agents.length === 0 && <div className="sx-plus-empty">{t('No sub-agents', '暂无子智能体')}</div>}
          {agents?.map((a) => (
            <button key={`$${a.id}`} type="button" role="menuitem" className="sx-plus-row" data-tip={a.name} onClick={() => onInsert(`$${a.id} `)}>
              <span className="sx-plus-name">{a.id}</span>
              <span className="sx-plus-desc">{a.name}</span>
            </button>
          ))}
        </>
      )}
      {conn.teamsView !== undefined && (
        <>
          <div className="sx-plus-sec">{t('Agent Teams', '智能体团队')}</div>
          {teams === null && <div className="sx-plus-empty">{t('Loading…', '加载中…')}</div>}
          {teams !== null && teams.length === 0 && <div className="sx-plus-empty">{t('No teams', '暂无团队')}</div>}
          {teams?.map((tm) => (
            <button key={`#${tm.id}`} type="button" role="menuitem" className="sx-plus-row" data-tip={tm.name} onClick={() => onInsert(`#${tm.id} `)}>
              <span className="sx-plus-name">{tm.id}</span>
              <span className="sx-plus-desc">{tm.name}</span>
            </button>
          ))}
        </>
      )}
      {/* G14.128 文件区:root 索引在场即渲染(欢迎页也可用);否则会话内回落 tree 浏览 */}
      {(indexed !== null || sessionId !== undefined) && (
        <>
          <div className="sx-plus-sec">{t('Add file', '添加文件')}</div>
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
      {/* 快捷键提示脚行(2026-11-03 用户裁定):钉底恒显——@ 添加文件 / 选择命令或技能 / $ # 引用 / Ctrl+V 粘贴图片 */}
      <div className="sx-plus-foot">
        <span className="sx-plus-hint"><kbd>@</kbd>{t('Add file', '添加文件')}</span>
        <span className="sx-plus-hint"><kbd>/</kbd>{t('Pick command or skill', '选择命令或技能')}</span>
        <span className="sx-plus-hint"><kbd>$</kbd>{t('Sub-agents', '子智能体')}</span>
        <span className="sx-plus-hint"><kbd>#</kbd>{t('Agent teams', '智能体团队')}</span>
        <span className="sx-plus-hint"><kbd>Ctrl+V</kbd>{t('Paste image', '粘贴图片')}</span>
      </div>
    </div>
  );
}

import { Check, ArrowRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { t } from '../../i18n';
import { localizeNotice } from '../../i18n-notice';
import { highlightCommand, stripAnsi } from '../../highlight';
import { openExternalUrl } from '../../ui-util';
import type { ChatEntry } from '../../chat-reducer';
import type { DiffResp } from '../../connection';
import { DiffLines } from '../../diff-lines';
import { keepUrl, mdComponentsPlain, MD_REHYPE_PLUGINS, MD_REMARK_PLUGINS } from '../Chat';
import { mcpToolParts, parseAskAnswer, parseAskInput, parseWebSearchOutput, withoutPurpose } from './tool-entry-data';
import { ToolImageThumb } from './tool-entry-media';

/** 工具行展开体（D62 批B，2026-11-07 自 ToolEntry.tsx 外提——宿主留折叠行+壳+拉取态）：按 toolName
 *  分型渲染 write/edit diff 面板、skill md 正文、ask/exit_plan 问答记录、exec/MCP 终端块、websearch
 *  链接卡、todo 清单、团队消息井；其余=输出原文。输入面全经 props 注入（宿主 locals 直映，零闭包依赖），
 *  JSX 与宿主原段逐字等价。 */
export function ToolEntryBody({
  entry,
  toolName,
  input,
  executing,
  resultText,
  isWrite,
  diff,
  path,
  callId,
  onOpenDiff,
  onOpenFile,
  planName,
  planFilePath,
  command,
  messageText,
  onOpenImage,
}: {
  entry: ChatEntry;
  toolName: string;
  input: Record<string, unknown>;
  executing: boolean;
  /** 展开面全文（entry.result full 全量观测优先，text 兜底） */
  resultText: string;
  isWrite: boolean;
  /** G7 diff 拉取态：undefined=未拉/在途，null=拉取失败（退单列现内容），对象=成功 */
  diff: DiffResp | null | undefined;
  path: string | undefined;
  callId: string | undefined;
  onOpenDiff?: (callId: string, path: string) => void;
  onOpenFile?: (path: string) => void;
  planName: string;
  planFilePath: string | undefined;
  command: string | undefined;
  messageText: string;
  /** 回显图片点击开灯箱（宿主自持浮层态） */
  onOpenImage: (src: string) => void;
}): JSX.Element {
  const fullResult = resultText;
  const askInput = parseAskInput(toolName, input);
  const askAnswer = parseAskAnswer(fullResult);
  /** 展开面主体(G14 分型):write/edit=行级 diff 面板;skill=md 正文;exec=$ 命令高亮+输出;
   *  todo_write=本地化清单(G14.138,daemon 英文结果不进展开面);其余=输出原文 */
  let body: JSX.Element;
  if (toolName === 'send_agent_team_message') {
    // 正文进工具井(.tool-md=surface-code 黑框,与 skill/ask 同面);回执次级灰跟在正文下
    body = (
      <div className="tool-md tool-msg">
        {messageText !== '' && <div className="tool-msg-body">{messageText}</div>}
        {resultText !== '' && <div className="tool-msg-receipt">{resultText}</div>}
        {messageText === '' && resultText === '' && <div className="tool-todo-empty">{t('(empty)', '（空）')}</div>}
      </div>
    );
  } else if (toolName === 'todo_write') {
    const arr = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
    body = (
      <div className="tool-todos" aria-label="todo list">
        {arr.length === 0 && <div className="tool-todo tool-todo-empty">{t('(empty list)', '（空清单）')}</div>}
        {arr.map((o, i) => {
          const st = (o ?? {}).status === 'completed' ? 'completed' : (o ?? {}).status === 'in_progress' ? 'in_progress' : 'pending';
          return (
            <div key={i} className={`tool-todo tool-todo-${st}`}>
              {/* G14.169 统一圆圈三态:完成=绿底√/进行=→/等待=虚线圈(用户裁决,替代 ☑◐☐ 字符) */}
              <span className={`todo-dot ${st}`} aria-hidden="true">
                {st === 'completed' && <Check size={9} strokeWidth={3} />}
                {st === 'in_progress' && <ArrowRight size={9} strokeWidth={3} />}
              </span>
              <span className="tool-todo-text">{typeof (o ?? {}).text === 'string' ? String((o ?? {}).text) : ''}</span>
            </div>
          );
        })}
      </div>
    );
  } else if (isWrite) {
    // 拦截态先行(2026-10-31 用户实测「守卫拦截了但没显示报错」):失败(write/edit 被拒/NOT_READ/
    // STALE_READ 等)渲染 err 色错误横幅替代 diff——尝试的替换对未落盘,当 diff 显是误导
    if (entry.result?.ok === false && !executing) {
      body = (
        <div className="tool-detail" role="alert">
          <div style={{ color: 'var(--err)', fontSize: 'calc(12px * var(--fz))', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>✗ {resultText}</div>
        </div>
      );
    } else {
    // 快照兜底列(404/失败/加载期):write=整稿新内容(input.content);edit=本次替换对(oldString→newString)
    const fallbackOld = toolName === 'edit' && typeof input.oldString === 'string' ? input.oldString : undefined;
    const fallbackNew =
      toolName === 'edit'
        ? typeof input.newString === 'string'
          ? input.newString
          : ''
        : typeof input.content === 'string'
          ? input.content
          : '';
    const openDiff =
      onOpenDiff !== undefined && callId !== undefined && path !== undefined
        ? (): void => {
            onOpenDiff(callId, path);
          }
        : onOpenFile !== undefined && path !== undefined
          ? (): void => {
              onOpenFile(path);
            }
          : undefined;
    const openDiffTitle =
      onOpenDiff !== undefined && callId !== undefined ? t('Open diff tab', '打开 diff 标签') : t('Preview in file tab', '在文件标签预览');
    body = (
      <div className="tool-detail">
        {/* G14.51:自绘行级 diff;⇄ 开 diff 标签钮迁入(原 DiffPanel 角标钮,可及名=路径) */}
        <div className="tool-diffwrap">
          <DiffLines oldStr={diff?.oldContent ?? fallbackOld} newStr={diff !== null && diff !== undefined ? diff.newContent : fallbackNew} path={path} maxHeight={280} />
          {openDiff !== undefined && (
            <button
              type="button"
              className="tool-path"
              aria-label={path}
              data-tip={openDiffTitle}
              onClick={openDiff}
            >
              <span aria-hidden="true">⇄</span>
            </button>
          )}
        </div>
      </div>
    );
    }
  } else if (toolName === 'skill') {
    body = (
      <div className="tool-md">
        <ReactMarkdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={keepUrl} components={mdComponentsPlain}>{fullResult}</ReactMarkdown>
      </div>
    );
  } else if (toolName === 'ask_question' && askInput !== null) {
    const askQ = askInput;
    // G14.82:结构化问答体——问题+选项清单(✓ 用户所选/跳过态)+回答条,替代原始 I/O 文本块
    // G14.102 回答行去「✓ Answered」前缀:回答态只示回答内容(accent),skip 示「Skipped」(灰),
    // 自定义示输入内容;等待态保留 spinner+文案
    const answerRow =
      askAnswer.kind === 'answers' || askAnswer.kind === 'answer'
        ? { kind: 'answer' as const, text: askAnswer.labels.join('、') }
        : askAnswer.kind === 'custom'
          ? { kind: 'custom' as const, text: askAnswer.text }
          : askAnswer.kind === 'dismissed'
            ? { kind: 'dismissed' as const, text: t('Skipped', '已跳过') }
            : { kind: 'waiting' as const, text: t('Waiting for answer', '等待回答') };
    // G14.84/G14.102:展开体=问题(加重)+回答结果,普通展开区域包裹(选项清单挂起表单已示,不复读)
    body = (
      <div className="tool-md ask-record">
        <div className="ask-q">{askQ.question}</div>
        <div className={`ask-answer kind-${answerRow.kind}`}>
          {answerRow.kind === 'waiting' && <span className="run-spinner" aria-hidden="true" />}
          <span className="ask-answer-text">{answerRow.text}</span>
        </div>
      </div>
    );
  } else if (toolName === 'exit_plan') {
    // 交稿体（2026-11-03）：计划名(加重)+裁决状态行（ask-answer 同款三态面——等待态 spinner,
    // 终态显 decision 文本）;计划文件链接在场即附(点击开侧栏 file 页签)
    const planExecuting = entry.status === 'pending' || entry.status === 'running';
    body = (
      <div className="tool-md ask-record">
        {/* 2026-11-04 用户裁定:展开体计划名不可交互不蓝——plan-name-link 摘除 */}
        <div className="ask-q">{planName !== '' ? planName : t('Plan', '计划')}</div>
        <div className={`ask-answer ${planExecuting ? 'kind-waiting' : 'kind-answer'}`}>
          {planExecuting && <span className="run-spinner" aria-hidden="true" />}
          <span className="ask-answer-text">
            {planFilePath !== undefined && onOpenFile !== undefined ? (
              <span
                role="button"
                tabIndex={-1}
                className="tool-file-base tool-file-link"
                data-tip={t('Open plan file', '打开计划文件')}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFile(planFilePath);
                }}
              >
                {t('Open plan file', '打开计划文件')}
              </span>
            ) : null}
            {planExecuting ? t('Awaiting user decision', '等待用户裁决') : fullResult !== '' ? localizeNotice(stripAnsi(fullResult)) : ''}
          </span>
        </div>
      </div>
    );
  } else if (command !== undefined) {
    body = (
      // G14.50:命令与输出合一区(终端形态:$ 行命令着色 + 输出同块次级灰——2026-10-25 用户裁定
      // 「结果再偏灰一点,方便区分命令行和结果」;输出剥 ANSI 转义(终端色码渲染即乱码))
      <div className="tool-exec">
        <pre className="tool-io-pre">
          <span className="exec-prompt" aria-hidden="true">$ </span>
          <code dangerouslySetInnerHTML={{ __html: highlightCommand(command) }} />
          {'\n'}
          <span className="exec-output">{fullResult !== '' ? stripAnsi(fullResult) : t('(no result)', '(无结果)')}</span>
        </pre>
      </div>
    );
  } else if (mcpToolParts(toolName) !== null) {
    // 2026-10-26 MCP 工具展开面(用户裁定「参数和返回值显示和其他工具一样」):server·tool 标识行 +
    // params JSON(入参全量,空参显 {})+ 返回值,终端块同形态($ 行/输出 的 MCP 对位)
    const mcp = mcpToolParts(toolName)!;
    const shown = withoutPurpose(toolName, input); // purpose 已作行标题,展开体只列插件真实收到的参数
    const params = Object.keys(shown).length > 0 ? JSON.stringify(shown, null, 2) : '{}';
    body = (
      <div className="tool-exec">
        <pre className="tool-io-pre">
          <span className="exec-prompt" aria-hidden="true">mcp </span>
          <code>{mcp.server}</code>
          {' · '}
          <code>{mcp.tool}</code>
          {'\n'}
          <span className="exec-prompt" aria-hidden="true">params </span>
          <code>{params}</code>
          {'\n'}
          <span className="exec-output">{fullResult !== '' ? stripAnsi(fullResult) : t('(no result)', '(无结果)')}</span>
        </pre>
        {/* 回显带图(2026-10-30 用户裁定「回显也要显示截图的图片」):截屏类工具的截图在展开体
            结果后同样渲染——回显卡不只有参数/元数据,图片就近可看(缩略行同款,点击开灯箱) */}
        {entry.images !== undefined && entry.images.length > 0 && (
          <div className="tool-images">
            {entry.images.map((src, i) => (
              <ToolImageThumb key={`${i}:${src.slice(-24)}`} src={src} onOpen={onOpenImage} />
            ))}
          </div>
        )}
      </div>
    );
  } else if (toolName === 'websearch') {
    // 2026-11-01 用户裁定「网址名做链接不显示 url,点击开系统默认浏览器」:websearch 输出结构化解析——
    // 标题=可点链接(preload 桥 shell.openExternal,OS 默认浏览器承接),URL 行不显示,摘要保留
    const hits = parseWebSearchOutput(fullResult);
    // 卡片四条(底色/圆角/内距/margin)走 tool-io-pre 类单点(tool-io.css,2026-11-02 技术债轮回归);
    // div 专属高度帽与字号行距内联保留
    body =
      hits.length > 0 ? (
        <div
          className="tool-io-pre"
          style={{ maxHeight: 280, overflow: 'auto', fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.6 }}
        >
            {hits.map((h) => (
              <div key={h.n} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 'calc(13px * var(--fz))' }}>
                  {h.n}.{' '}
                  <a
                    href={h.url}
                    style={{ color: 'var(--accent, #6ea8fe)' }}
                    onClick={(e) => {
                      e.preventDefault();
                      openExternalUrl(h.url);
                    }}
                  >
                    {h.title}
                  </a>
                </div>
                <div style={{ fontSize: 'calc(12px * var(--fz))', opacity: 0.75, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', paddingLeft: 14 }}>{h.snippet}</div>
              </div>
            ))}
        </div>
      ) : (
        <pre className="tool-io-pre">{fullResult !== '' ? stripAnsi(fullResult) : t('(no result)', '(无结果)')}</pre>
      );
  } else {
    body = <pre className="tool-io-pre">{fullResult !== '' ? stripAnsi(fullResult) : t('(no result)', '(无结果)')}</pre>;
  }
  return body;
}

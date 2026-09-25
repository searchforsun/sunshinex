import type { AskUserRequest, AskUserSeam } from '../../types';
import type { SnapshotEntry } from '../../tui/session-journal';
import * as fs from 'fs';
import * as path from 'path';
import { RegisteredTool, CodedToolError } from '../tools';
import { SafetyChain } from '../security/chain';
import { ExecResult, ToolInput, TodoStatus } from '../../types';
import { Result } from '../../result';
import { KnowledgeBase } from '../knowledge/index';
import { SkillsFacade } from '../skills';
import { resolveWebSearchProvider, WebSearchProvider } from './websearch';
import { ToolOutputArchive } from './output-archive';
import { TaskRegistry } from '../tasks';
import { MemoryWriteSeam } from '../memory/writer';
import { MemoryScope } from '../memory/paths';

/** 工具入参路径归一单点：绝对路径原样（信封即语义），相对路径按项目根解析——兑现 schema 声明的
 *  "relative to the project root"。缺此归一相对路径按 Node 进程 cwd 解析，从父目录启动会话时
 *  read/write 与 glob/exec（程序侧锚 root/execCwd）锚点分裂，出现「glob 看得到、read 读不到」 */
function resolveProjectPath(root: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(root, p);
}
import { createWorktree, removeWorktree, readRegistry, worktreesRoot, isDirty, randomWorktreeName } from '../worktree';
import { resolveDataDir } from '../../config/data-dir';

/** §9.3 快照过期回执文案（写链恒英文单语——CLAUDE.md §15；置于模块级避免每次 builtinTools 调用重建） */
const SUNSHINE_STALE_NOTICE = 'SUNSHINE.md rewritten — session snapshot is stale until the next refresh point';

/** §9.3 触发判据：目标是否为项目根的 SUNSHINE.md。两侧同基准：file 已是安全链 realpath 归一的绝对路径（safePath 注入），
 *  root 侧取安全链构造期归一的 rootReal（root 含符号链接段时字面比较会漏报）；归一异常按 false 兜底（不误报） */
function isSunshineMdTarget(safety: SafetyChain, file: string): boolean {
  try {
    return path.resolve(file) === path.resolve(safety.rootReal, 'SUNSHINE.md');
  } catch {
    return false;
  }
}

/** memory_write 工具的执行接缝（规格 §3.7）：装配层注入 `writeMemoryFact` 绑定 root 后的形态。
 *  工具只做入参整形/错误转译，闸门、三级去重、落盘与容量回执全在记忆侧单点（builtin 不复制任何记忆语义）。
 *  入参 `scope`（规格 §4.2 记忆隔离）由**执行期从安全链取**（`safety.memoryScope`，子代理链为 `agents/<id>`），
 *  模型输入面不暴露该字段——模型自选的 scope 一律忽略，防越权改记忆落点。 */
export type MemoryWriteTool = (input: { type: string; content: string; description?: string; scope?: MemoryScope }) => Result<{
  slug: string;
  existed: boolean;
  notice: string | null;
}>;

/** 内置工具集：read/write/grep/glob/exec/webfetch/websearch/kb_search；文件路径为安全链注入的 safePath（绝对路径），仅 exec 的 shell 工作目录以 root 为基准；webSearch 供测试注入桩 Provider，缺省按环境解析（DDG/Bing）；archive 为工具出口预算接缝（超限截断+全文落盘留 read 恢复路径），缺省不设预算（旧测试桩行为不变）；memory 为记忆写入接缝（第 7 可选参，缺省不注入＝旧行为逐字节不变，工具清单零变化）；memoryWrite 为 memory_write 工具接缝（第 8 可选参，缺省不注入＝工具清单与第 7 参引入前逐字节一致，注入才注册 memory_write；执行期以本参数捕获的安全链 `memoryScope` 透传记忆写入 scope——**子代理隔离要求装配面带 scope 的链**：`derive()` 共享 executor 闭包，闭包持有的是装配期那条链） */
export function builtinTools(safety: SafetyChain, root: string, kb?: KnowledgeBase, webSearch?: WebSearchProvider, archive?: ToolOutputArchive, skills?: SkillsFacade, memory?: MemoryWriteSeam, memoryWrite?: MemoryWriteTool, ask?: AskUserSeam, writeSnapshot?: { capture(p: string): void; drain(): SnapshotEntry[] }, activeRoot?: () => string | null, todos?: { set(items: { text: string; status: TodoStatus }[]): void }, tasks?: TaskRegistry): RegisteredTool[] {
  // 出口预算统一管线：注册了 archive 的工具出口过 fit；未注册保持现行行为（逐字节不变）
  const fitOut = (tool: string, out: string): string => (archive ? archive.fit(tool, out) : out);
  const execOut = (stdout: string, stderr = ''): ExecResult => ({ exitCode: 0, stdout, stderr, timedOut: false });
  const backend = safety.backend;

  const tools: RegisteredTool[] = [
    {
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'background'],
        properties: {
          command: { type: 'string', description: 'Shell command to run (POSIX sh; runs from the project root)' },
          background: { type: ['boolean', 'null'], description: 'Run in the background: returns immediately with a task id and an output file path; poll by reading that file — the file ends with an [exit N] line once the command finishes' },
        },
      },
      name: 'exec',
      description: 'Execute a shell command inside the project sandbox; long-running commands are automatically moved to the background when they time out; oversized output is truncated and saved to disk (full output path shown in the result)',
      category: 'bash',
      executor: async (input: ToolInput, runtimeSafety) => {
        const cmd = String(input.command ?? '');
        // 执行期安全缝（规格 D6）：cwd 锚定与命令判界取运行期链视图（fork 子链 withRoot 换根克隆注入即生效；
        // 缺省回落装配链），前台/后台共用同一闸门——后台分支直调 backend，闸门须在分流前
        const gateView = runtimeSafety ?? safety;
        const gate = gateView.execCommandAllowed(cmd);
        if (!gate.allowed) return { exitCode: 127, stdout: '', stderr: gate.reason, timedOut: false };
        if (input.background === true) {
          if (tasks === undefined) throw new CodedToolError('NOT_SUPPORTED', 'background execution requires a task registry (not wired in this assembly)');
          if (backend.execBackground === undefined) throw new CodedToolError('NOT_SUPPORTED', 'background exec requires a backend with execBackground');
          const wrap = gateView.execWrap !== undefined ? await gateView.execWrap(cmd) : null;
          const task = tasks.submit({ kind: 'exec', label: cmd.trim().split(/\s+/)[0] ?? cmd, ownerRun: tasks.currentOwner() });
          const started = await backend.execBackground(cmd, {
            cwd: gateView.execCwd(),
            ...(wrap !== null ? { wrap } : {}),
            onData: (chunk) => tasks.append(task.id, chunk),
            onExit: (code) => tasks.finish(task.id, code === 0 ? 'done' : 'failed', { exitCode: code }),
          });
          if (started.ok) task.stop = () => backend.killBackground?.(started.value.pid);
          return execOut(`task ${task.id} started (output: ${task.outputFilePath})`);
        }
        // exec cwd 判定单点（规格 §11）：执行期安全缝锚 cwd——fork 子链换根克隆即锚专属树，缺省装配根
        // 前台超时转后台（规格 D5，对标 CC）：账本在场且非 sleep 开头时带 timeoutToBackground，到点不杀进程、登记转后台
        const wantsBg = tasks !== undefined && !/^\s*sleep(?=\s|$)/.test(cmd.trim());
        const r = await safety.run(cmd, { cwd: gateView.execCwd(), ...(wantsBg ? { timeoutToBackground: true } : {}) });
        if (r.ok && r.value.timedOut && r.value.child) {
          const child = r.value.child;
          const ledger = tasks!;
          const task = ledger.submit({ kind: 'exec', label: cmd.trim().split(/\s+/)[0] ?? cmd, ownerRun: ledger.currentOwner() });
          if (r.value.stdout !== '') ledger.append(task.id, r.value.stdout);
          if (r.value.stderr !== '') ledger.append(task.id, r.value.stderr);
          child.stdout?.on('data', (c: Buffer) => ledger.append(task.id, c.toString('utf8')));
          child.stderr?.on('data', (c: Buffer) => ledger.append(task.id, c.toString('utf8')));
          child.on('close', (code) => ledger.finish(task.id, code === 0 ? 'done' : 'failed', { exitCode: code ?? -1 }));
          // 收割收敛 killBackground 单点（§14）：按进程树/进程组同步收割（win32 taskkill /T /F，POSIX kill(-pid)）
          task.stop = () => backend.killBackground?.(child.pid ?? 0);
          ledger.append(task.id, '[moved to background after timeout]\n');
          return execOut(`command moved to background after timeout: task ${task.id} (output: ${task.outputFilePath})`);
        }
        if (r.ok) return { ...r.value, stdout: fitOut('exec', r.value.stdout) };
        throw new Error(`${r.error.code}: ${r.error.message}`);
      },
    },
    {
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'range'],
        properties: {
          path: { type: 'string', description: 'File path (relative to the project root or absolute)' },
          range: { type: ['string', 'null'], description: 'Optional line range, 1-based inclusive: "L100-125" lines 100-125; "L100" or "L100-" from line 100 to EOF; "L-20" first 20 lines; null reads the whole file' },
        },
      },
      name: 'read',
      description:
        'Read file content; optional range selects lines, 1-based inclusive: "L100-125" lines 100-125; "L100" or "L100-" from line 100 to EOF; "L-20" first 20 lines; output prefixed with line numbers; oversized output is truncated and saved to disk (full output path shown in the result)',
      category: 'read',
      executor: async (input: ToolInput) => {
        const content = backend.readFile(resolveProjectPath(root, String(input.path)));
        // 空语义归一单点：undefined / JSON null / "null"·"undefined" 字符串字面量（模型把可空联合当字符串传的形态）均按整文件处理
        const range = input.range === undefined || input.range === null || input.range === 'null' || input.range === 'undefined' ? '' : String(input.range).trim();
        if (range === '') return execOut(fitOut('read', content));
        // 形态语义：L<a>-<b> 闭区间；L<a> 与 L<a>- 同义（a 行到尾）；L-<b>（前 b 行）；越界钳制到文件实际范围
        const m = /^L(?<a>\d+)?(?:-(?<b>\d+)?)?$/.exec(range);
        const a = m?.groups?.a === undefined ? NaN : parseInt(m.groups.a, 10);
        const b = m?.groups?.b === undefined ? NaN : parseInt(m.groups.b, 10);
        if (!m || (Number.isNaN(a) && Number.isNaN(b))) throw new CodedToolError('INVALID_ARG', `Invalid range "${range}"; expected L<start>-<end> like L100-125`);
        const lines = content.split('\n');
        const start = Math.max(1, Number.isNaN(a) ? 1 : a);
        const end = Math.min(lines.length, Number.isNaN(b) ? lines.length : b);
        if (!Number.isNaN(b) && b < start) throw new CodedToolError('INVALID_ARG', `Range end before start: ${range}`);
        const slice = lines.slice(start - 1, end);
        // 完全越界（start 超文件行数）钳制为空：附 EOF 提示行，避免「ok 但静默空」被误判为通道故障
        if (slice.length === 0) return execOut(fitOut('read', `[EOF] file has ${lines.length} lines; requested range "${range}" is past end of file`));
        return execOut(fitOut('read', slice.map((l, i) => `${start + i}: ${l}`).join('\n')));
      },
    },
    {
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'params'],
        properties: {
          id: { type: 'string', description: 'Skill id from the available skills list' },
          params: { type: 'object', additionalProperties: true, description: 'Optional name→value substitution for skill template placeholders (free-form)' },
        },
      },
      name: 'skill',
      description:
        'Load a skill\'s full instructions by id when the task matches an entry in the available skills list; use only ids that appear in the available skills list — never guess or invent a name; oversized output is truncated and saved to disk (full output path shown in the result)',
      category: 'read',
      executor: async (input: ToolInput) => {
        if (!skills) throw new CodedToolError('skill_not_configured', 'Skill facade is not wired in this run');
        const id = String(input.id ?? '').trim();
        if (id === '') throw new CodedToolError('INVALID_ARG', 'Missing skill id');
        const raw = input.params;
        if (raw !== undefined && (typeof raw !== 'object' || raw === null)) throw new CodedToolError('INVALID_ARG', 'params must be a name→value object');
        const r = skills.resolve(id, raw as Record<string, string> | undefined);
        if (!r.ok) throw new CodedToolError(r.error.code, `${r.error.code}: ${r.error.message}`);
        return execOut(fitOut('skill', `[Skill] ${r.value.manifest.name || id}\n\n${r.value.body}`));
      },
    },
    {
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'File path (relative to the project root or absolute)' },
          content: { type: 'string', description: 'Full file content to write' },
        },
      },
      name: 'write',
      description: 'Write file content',
      category: 'write',
      executor: async (input: ToolInput) => {
        const p = String(input.path);
        const content = String(input.content ?? '');
        // 记忆写入接缝（规格 §4.4）：命中记忆路径走接缝（校验/规范化/索引/容量回执）；未注入接缝＝旧行为
        if (memory) {
          // scope 只接 safety.memoryScope（undefined | agents/<id>）：显式 'main' 在判类下等价全拒，接缝会判 'pass' 而让闸门静默消失，
          // 故在此显式收窄（不用 as 掩盖）；生产链侧该取值组合的写早已被写窄口拒绝，此处只把契约固定下来。
          const scope = safety.memoryScope;
          const r = memory({
            root,
            absPath: p,
            content,
            ...(scope !== undefined && scope !== 'main' ? { scope } : {}),
          });
          if (!r.ok) throw new CodedToolError(r.error.code, r.error.message);
          if (r.value !== 'pass') return execOut(r.value.observation);
        }
        // write 影子快照（rewind/fork 规格 §6.1）：落盘前捕获 pre-image；记忆接缝路径不经过此处（上文已 return）
        const target = resolveProjectPath(root, p);
        writeSnapshot?.capture(target);
        backend.writeFile(target, content);
        // §9.3 快照过期回执：写项目根 SUNSHINE.md 时观察行补一句（快照仍冻结到下一刷新点，§9.2 漂移检测下轮起点统一尾追全文）
        return execOut(isSunshineMdTarget(safety, p) ? `written\n${SUNSHINE_STALE_NOTICE}` : 'written');
      },
    },
    {
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['pattern', 'glob', 'path'],
        properties: {
          pattern: { type: 'string', description: 'JavaScript regular expression to match' },
          glob: { type: ['string', 'null'], description: 'Optional filename glob filter for directory search (e.g. **/*.ts); null for no filter' },
          path: { type: ['string', 'null'], description: 'File or directory to search; null defaults to the project root' },
        },
      },
      name: 'grep',
      description: 'Regex search: for a file path emit raw matching lines; for a directory search recursively and emit relativePath:line:line',
      category: 'read',
      executor: async (input: ToolInput) => {
        const { pattern, glob: globFilter } = input as { pattern: string; glob?: string };
        const target = String(input.path ?? '.');
        if (!fs.statSync(target).isDirectory()) {
          const content = backend.readFile(target);
          const lines = content.split('\n').filter((l) => new RegExp(pattern).test(l));
          // 零命中附提示行：避免「ok 但静默空」被误判为通道故障
          if (lines.length === 0) return execOut(`no matches for pattern "${pattern}" in ${target}`);
          return execOut(lines.join('\n'));
        }
        // 目录模式复用后端遍历：与 glob 工具同一跳过集（node_modules/.git/dist），glob 过滤与遍历匹配口径一致
        const files = backend.listFiles(target, globFilter ?? '**/*');
        const re = new RegExp(pattern);
        const out: string[] = [];
        for (const rel of files) {
          let content: string;
          try {
            content = backend.readFile(path.join(target, rel));
          } catch {
            continue; // 不可读文件（权限/二进制）跳过，不中断整体检索
          }
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i])) continue;
            if (out.length >= 200) return execOut(out.join('\n') + '\ntruncated: true');
            out.push(`${rel}:${i + 1}:${lines[i]}`);
          }
        }
        // 零命中附提示行：避免「ok 但静默空」被误判为通道故障
        if (out.length === 0) return execOut(`no matches for pattern "${pattern}" in ${target}`);
        return execOut(out.join('\n'));
      },
    },
    {
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['pattern'],
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. src/**/*.ts)' },
        },
      },
      name: 'glob',
      description: 'List files matching a glob pattern; oversized listing is truncated and saved to disk (full output path shown in the result)',
      category: 'read',
      executor: async (input: ToolInput) => {
        const files = backend.listFiles(root, String(input.pattern ?? '*'));
        // 零命中附提示行：避免「ok 但静默空」被误判为通道故障
        if (files.length === 0) return execOut(`no files match pattern "${String(input.pattern ?? '*')}" under project root`);
        return execOut(fitOut('glob', files.join('\n')));
      },
    },
    {
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'http/https URL to fetch' },
        },
      },
      name: 'webfetch',
      description: 'Fetch a web page: input { url }, http/https only (protocol floor enforced by the security guard); oversized body is truncated and saved to disk (full output path shown in the result)',
      category: 'network',
      executor: async (input: ToolInput) => {
        const res = await fetch(String(input.url ?? ''));
        if (!res.ok) throw new Error(`WEBFETCH_HTTP_${res.status}`);
        const text = await res.text();
        return execOut(fitOut('webfetch', text));
      },
    },
    {
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'count'],
        properties: {
          query: { type: 'string', description: 'Search query text' },
          count: { type: ['integer', 'null'], description: 'Result count, clamped to 1-10; null defaults to 5' },
        },
      },
      name: 'websearch',
      description: 'Web search: input { query, count? } (count default 5, max 10); stdout is title/URL/snippet lines; engine endpoint allows http/https only',
      category: 'network',
      executor: async (input: ToolInput) => {
        const provider = webSearch ?? resolveWebSearchProvider();
        const n = Number(input.count ?? 5);
        const count = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 10) : 5;
        const hits = await provider.search(String(input.query ?? ''), count);
        if (hits.length === 0) return execOut('(no results)');
        return execOut(hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n'));
      },
    },
    {
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'topK'],
        properties: {
          query: { type: 'string', description: 'Search query text' },
          topK: { type: ['integer', 'null'], description: 'Max hits to return; null defaults to 5' },
        },
      },
      name: 'kb_search',
      description: 'Local vector knowledge-base search: input { query, topK? }, stdout is KbHit[] JSON; degrades to kb_not_configured when not configured (never blocks other tools)',
      category: 'read',
      executor: async (input: ToolInput) => {
        if (!kb) throw new CodedToolError('kb_not_configured', 'Knowledge base not configured: EMBEDDING_* env required and indexDir must be indexed');
        const hits = await kb.search(String(input.query ?? ''), Number(input.topK ?? 5));
        return execOut(JSON.stringify(hits));
      },
    },
  ];
  // todo_write 模型工具（todo_write 规格 D3/D4/D10）：会话待办清单全量替换写点；恒注册沿 skill 先例
  // （未装配 facade 执行报 todo_not_configured，Task 3 Harness 接线注入）；零 IO 副作用的进程内状态写：
  // 免审批由 guard 三模式放行承载，单发独占由 reactor 并行闸门判定键 category:'todo' 承载
  tools.push({
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['todos'],
      properties: {
        todos: {
          type: 'array',
          description: 'Full replacement todo list (empty array clears the list; max 50 items)',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'status'],
            properties: {
              text: { type: 'string', description: 'Task description' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
          },
        },
      },
    },
    name: 'todo_write',
    description:
      'Write the session todo list (full replacement). Use it for tasks with 3 or more distinct steps: create the list up front, keep exactly one item in_progress at a time, mark items completed as soon as they are done, and rewrite the whole list whenever it changes. Task boundaries do not reset the list — append new tasks instead of starting from scratch. Skip it for simpler tasks (1-2 steps).',
    category: 'todo',
    executor: async (input: ToolInput) => {
      if (!todos) throw new CodedToolError('todo_not_configured', 'todo list is not wired in this runtime');
      const arr = input.todos;
      if (!Array.isArray(arr)) throw new CodedToolError('INVALID_ARG', 'todos must be an array');
      if (arr.length > 50) throw new CodedToolError('INVALID_ARG', `todos exceeds the limit of 50 items (got ${arr.length})`);
      const items = arr.map((raw) => {
        const o = (raw ?? {}) as { text?: unknown; status?: TodoStatus };
        if (typeof o.text !== 'string' || o.text.trim() === '') throw new CodedToolError('INVALID_ARG', 'each todo needs a non-empty text');
        if (o.status !== 'pending' && o.status !== 'in_progress' && o.status !== 'completed')
          throw new CodedToolError('INVALID_ARG', `status must be pending | in_progress | completed (got ${String(o.status)})`);
        return { text: o.text, status: o.status };
      });
      todos.set(items);
      const done = items.filter((it) => it.status === 'completed').length;
      const wip = items.filter((it) => it.status === 'in_progress').length;
      return execOut(`todo list updated: ${items.length} items (${done} completed, ${wip} in progress)`);
    },
  });
  // 第 8 可选参（规格 §3.7 memory_write）：缺省不注入＝清单与第 7 参引入前逐字节一致（对齐既有「可选参两态不变」不变式）；
  // 注入才注册——接缝必在（无「未配置」分支），错误一律经 CodedToolError 走 Result 错误通道，永不炸任务
  // 记忆 scope 透传要求（Task 6 接线）：executor 闭包持有的是**装配期**那条链的 memoryScope，而子代理 fork 的收窄链
  // 只在执行期经 registry.execute(safety) 注入（executor 不接收运行期链）——故子代理隔离须以带 scope 的链装配子注册表
  // （与 memory-write.test.ts 的 scoped 用例同形态），或另行为 executor 打开运行期链通道；derive() 共享 executor 不够。
  if (memoryWrite !== undefined) {
    const memoryWriter: MemoryWriteTool = memoryWrite; // 窄化取别名：闭包内不依赖外部窄化（参数可变，TS 不跨回调保留）
    tools.push({
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'content', 'description'],
        properties: {
          type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'Memory type: user preference / corrective feedback / project fact / external reference' },
          content: { type: 'string', description: 'ONE atomic durable fact (absolute dates; no session-relative wording)' },
          description: { type: ['string', 'null'], description: 'Short description used for the memory index; null omits it' },
        },
      },
      name: 'memory_write',
      description:
        'Persist ONE durable fact to long-term memory when it is worth remembering across sessions — a user preference, corrective feedback, or a non-obvious project fact. Be conservative: it is fine to save nothing. Do NOT save anything derivable from the repo or code (file contents, git history, code structure) or transient task state (current todo, in-progress step, plan progress). Duplicates return the existing entry. Fails when memory is disabled.',
      category: 'write',
      executor: async (input: ToolInput) => {
        const type = String(input.type ?? '');
        const content = String(input.content ?? '').trim();
        if (content === '') throw new CodedToolError('INVALID_ARG', 'content must not be empty');
        const rawDescription = input.description;
        const description = rawDescription === undefined ? undefined : String(rawDescription);
        // scope 只从安全链取（模型输入面的 scope 一律忽略）：子代理链 = agents/<id>，主链 = 主记忆目录
        const scope = safety.memoryScope;
        const payload = { type, content, ...(description !== undefined ? { description } : {}), ...(scope !== undefined ? { scope } : {}) };
        const r = memoryWriter(payload);
        if (!r.ok) throw new CodedToolError(r.error.code, r.error.message);
        // 观察行单行契约（链渲染 `${step}: ${action} -> ${observation}`）：近满提醒以 ` | ` 拼接，不得换行
        const suffix = r.value.existed ? ' (already exists)' : '';
        const notice = r.value.notice !== null ? ` | ${r.value.notice}` : '';
        return execOut(`Saved memory: ${r.value.slug}${suffix}${notice}`);
      },
    });
  }

  // ask_question 工具（AskQuestion 线 T2）：第 9 可选参注入才注册（两态不变式沿第 7/8 参先例，旧直调零扰动）。
  // 问询即用户交互通道本身（规格 D1：零 IO 副作用，manual/plan 免审批沿安全链 ask_question 分支）；
  // 入参钳制与观察文案单点在此，挂起/渲染/CLI 回落全部在 seam 消费方（Harness 装配层）
  if (ask !== undefined) {
    const askSeam = ask;
    tools.push({
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'options', 'multiple', 'allowCustom'],
        properties: {
          question: { type: 'string', description: 'Question for the user' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 8,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'description'],
              properties: {
                label: { type: 'string', description: 'Option label shown to the user' },
                description: { type: ['string', 'null'], description: 'Optional longer explanation; null omits it' },
              },
            },
          },
          multiple: { type: ['boolean', 'null'], description: 'true enables multi-select; null = single-select' },
          allowCustom: { type: ['boolean', 'null'], description: 'true adds a free-text "Other" option; null disables it' },
        },
      },
      name: 'ask_question',
      description:
        'Ask the user a question with selectable options and wait for their answer. Use when you need the user to choose between alternatives, confirm an approach, or provide free-form input. Supports single-select (default), multi-select (multiple) and a free-text "Other" answer (allowCustom). Returns the user\'s selection, their custom answer, or a dismissal notice if they skipped the question.',
      category: 'ask',
      executor: async (input: ToolInput) => {
        const question = String(input.question ?? '').trim();
        const rawOptions = Array.isArray(input.options) ? input.options : [];
        if (question === '') throw new CodedToolError('INVALID_ARG', 'question must not be empty');
        if (rawOptions.length < 2 || rawOptions.length > 8) throw new CodedToolError('INVALID_ARG', `options must contain 2 to 8 items (got ${rawOptions.length})`);
        const options = rawOptions.map((o) => {
          const obj = (o ?? {}) as { label?: unknown; description?: unknown };
          const label = String(obj.label ?? '').trim();
          if (label === '') throw new CodedToolError('INVALID_ARG', 'every option needs a non-empty label');
          const description = typeof obj.description === 'string' && obj.description.trim() !== '' ? obj.description.trim() : undefined;
          return description !== undefined ? { label, description } : { label };
        });
        const multiple = input.multiple === true;
        const allowCustom = input.allowCustom === true;
        const req: AskUserRequest = {
          question,
          options: allowCustom ? [...options, { label: 'Other…' }] : options,
          ...(multiple ? { multiple: true } : {}),
          ...(allowCustom ? { customIndex: options.length } : {}),
        };
        const answer = await askSeam(req);
        if (answer.type === 'custom') {
          const text = answer.text.trim();
          if (text === '') return execOut('user dismissed the question (no selection)');
          return execOut(`custom: ${text}`);
        }
        if (answer.type === 'dismissed') return execOut('user dismissed the question (no selection)');
        if (answer.labels.length === 0) return execOut('user dismissed the question (no selection)');
        return execOut(answer.labels.length > 1 || multiple ? `answers: ${answer.labels.join('; ')}` : `answer: ${answer.labels[0]}`);
      },
    });
  }

  // worktree 模型工具（规格 §8/D7）：create/exit/list 三动作；create=建树+Harness 活动根切换单点，
  // exit=回主工作区（未激活显式拒绝），list=登记表摘要（name/branch/dirty，数据面只读）。
  // 注册在 builtin 尾部沿 memoryWrite/ask seam 先例；类别 worktree=单发独占（reactor 并行闸门判定键）
  tools.push({
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'name'],
      properties: {
        action: { type: 'string', enum: ['create', 'exit', 'list'], description: 'create: fork a worktree from HEAD and switch the active root; exit: return to the main workspace; list: show registered worktrees' },
        name: { type: ['string', 'null'], description: 'Worktree name for create (lowercase letters, digits, hyphens; max 64); omitted or null auto-generates wt-xxxx; ignored for exit/list' },
      },
    },
    name: 'worktree',
    description:
      'Manage the session worktree: create forks an isolated git worktree from the current HEAD and switches the session working root to it (original workspace files stay untouched); exit returns to the main workspace; list shows registered worktrees with branch and dirty status. Runs exclusively on its own (never batched with other tools).',
    category: 'worktree',
    executor: async (input) => {
      const action = String(input.action ?? '');
      if (action === 'create') {
        const raw = input.name;
        const name = typeof raw === 'string' && raw.length > 0 ? raw : randomWorktreeName();
        const treeRoot = activeRoot?.() ?? root;
        const r = createWorktree(treeRoot, resolveDataDir(treeRoot), name);
        if (!r.ok) throw new CodedToolError(r.error.code, r.error.message);
        safety.enterWorktree(r.value.path);
        const line = `worktree created: ${r.value.path} (branch ${r.value.branch}${r.value.copiedSettings ? ', .sunshinex/settings.json copied' : ''}); the session working root is now this worktree`;
        return { ...execOut(line), stdout: fitOut('worktree', line) };
      }
      if (action === 'exit') {
        if (safety.activeRoot === null) throw new CodedToolError('WORKTREE_NOT_ACTIVE', 'not in a worktree session; exit is not applicable');
        const left = safety.activeRoot;
        safety.exitWorktree();
        const line = `exited worktree session (was ${left}); the session working root is back to the main workspace`;
        return { ...execOut(line), stdout: fitOut('worktree', line) };
      }
      if (action === 'list') {
        const treeRoot = activeRoot?.() ?? root;
        const registry = readRegistry(resolveDataDir(treeRoot));
        if (registry.length === 0) return execOut('no registered worktrees');
        const rows = registry.map((e) => `- ${e.name} | branch ${e.branch} | ${isDirty(e.path) ? 'dirty' : 'clean'}${e.keptReason ? ` | kept (${e.keptReason})` : ''} | ${e.path}`);
        const text = ['registered worktrees:', ...rows].join('\n');
        return { ...execOut(text), stdout: fitOut('worktree', text) };
      }
      throw new CodedToolError('INVALID_ARG', `unknown worktree action: ${action} (expect create|exit|list)`);
    },
  });

  return tools;
}

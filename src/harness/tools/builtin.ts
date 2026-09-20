import type { AskUserRequest, AskUserSeam } from '../../types';
import * as fs from 'fs';
import * as path from 'path';
import { RegisteredTool, CodedToolError } from '../tools';
import { SafetyChain } from '../security/chain';
import { ExecResult, ToolInput } from '../../types';
import { Result } from '../../result';
import { KnowledgeBase } from '../knowledge/index';
import { SkillsFacade } from '../skills';
import { resolveWebSearchProvider, WebSearchProvider } from './websearch';
import { ToolOutputArchive } from './output-archive';
import { MemoryWriteSeam } from '../memory/writer';
import { MemoryScope } from '../memory/paths';

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
export function builtinTools(safety: SafetyChain, root: string, kb?: KnowledgeBase, webSearch?: WebSearchProvider, archive?: ToolOutputArchive, skills?: SkillsFacade, memory?: MemoryWriteSeam, memoryWrite?: MemoryWriteTool, ask?: AskUserSeam): RegisteredTool[] {
  // 出口预算统一管线：注册了 archive 的工具出口过 fit；未注册保持现行行为（逐字节不变）
  const fitOut = (tool: string, out: string): string => (archive ? archive.fit(tool, out) : out);
  const execOut = (stdout: string, stderr = ''): ExecResult => ({ exitCode: 0, stdout, stderr, timedOut: false });
  const backend = safety.backend;

  const tools: RegisteredTool[] = [
    {
      name: 'exec',
      description: 'Execute a shell command inside the project sandbox; oversized output is truncated and saved to disk (full output path shown in the result)',
      category: 'bash',
      executor: async (input: ToolInput) => {
        const cmd = String(input.command ?? '');
        const r = await safety.run(cmd, { cwd: root });
        if (r.ok) return { ...r.value, stdout: fitOut('exec', r.value.stdout) };
        throw new Error(`${r.error.code}: ${r.error.message}`);
      },
    },
    {
      name: 'read',
      description:
        'Read file content; optional range selects lines, 1-based inclusive: "L100-125" lines 100-125; "L100" or "L100-" from line 100 to EOF; "L-20" first 20 lines; output prefixed with line numbers; oversized output is truncated and saved to disk (full output path shown in the result)',
      category: 'read',
      executor: async (input: ToolInput) => {
        const content = backend.readFile(String(input.path));
        const range = input.range === undefined ? '' : String(input.range).trim();
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
        return execOut(fitOut('read', lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n')));
      },
    },
    {
      name: 'skill',
      description:
        'Load a skill\'s full instructions by id when the task matches an entry in the available skills list; oversized output is truncated and saved to disk (full output path shown in the result)',
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
        backend.writeFile(p, content);
        // §9.3 快照过期回执：写项目根 SUNSHINE.md 时观察行补一句（快照仍冻结到下一刷新点，§9.2 漂移检测下轮起点统一尾追全文）
        return execOut(isSunshineMdTarget(safety, p) ? `written\n${SUNSHINE_STALE_NOTICE}` : 'written');
      },
    },
    {
      name: 'grep',
      description: 'Regex search: for a file path emit raw matching lines; for a directory search recursively and emit relativePath:line:line',
      category: 'read',
      executor: async (input: ToolInput) => {
        const { pattern, glob: globFilter } = input as { pattern: string; glob?: string };
        const target = String(input.path ?? '.');
        if (!fs.statSync(target).isDirectory()) {
          const content = backend.readFile(target);
          const lines = content.split('\n').filter((l) => new RegExp(pattern).test(l));
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
        return execOut(out.join('\n'));
      },
    },
    {
      name: 'glob',
      description: 'List files matching a glob pattern; oversized listing is truncated and saved to disk (full output path shown in the result)',
      category: 'read',
      executor: async (input: ToolInput) => execOut(fitOut('glob', backend.listFiles(root, String(input.pattern ?? '*')).join('\n'))),
    },
    {
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

  // 第 8 可选参（规格 §3.7 memory_write）：缺省不注入＝清单与第 7 参引入前逐字节一致（对齐既有「可选参两态不变」不变式）；
  // 注入才注册——接缝必在（无「未配置」分支），错误一律经 CodedToolError 走 Result 错误通道，永不炸任务
  // 记忆 scope 透传要求（Task 6 接线）：executor 闭包持有的是**装配期**那条链的 memoryScope，而子代理 fork 的收窄链
  // 只在执行期经 registry.execute(safety) 注入（executor 不接收运行期链）——故子代理隔离须以带 scope 的链装配子注册表
  // （与 memory-write.test.ts 的 scoped 用例同形态），或另行为 executor 打开运行期链通道；derive() 共享 executor 不够。
  if (memoryWrite !== undefined) {
    const memoryWriter: MemoryWriteTool = memoryWrite; // 窄化取别名：闭包内不依赖外部窄化（参数可变，TS 不跨回调保留）
    tools.push({
      name: 'memory_write',
      description:
        'Persist ONE durable fact to long-term memory when it is worth remembering across sessions — a user preference, corrective feedback, or a non-obvious project fact. Be conservative: it is fine to save nothing. Duplicates return the existing entry. Fails when memory is disabled.',
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

  return tools;
}

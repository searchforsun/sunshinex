import * as fs from 'fs';
import { pick } from '../../i18n';
import * as path from 'path';
import { RegisteredTool, CodedToolError } from '../tools';
import { SafetyChain } from '../security/chain';
import { ExecResult, ToolInput } from '../../types';
import { KnowledgeBase } from '../knowledge/index';
import { SkillsFacade } from '../skills';
import { resolveWebSearchProvider, WebSearchProvider } from './websearch';
import { ToolOutputArchive } from './output-archive';
import { MemoryWriteSeam } from '../memory/writer';

/** 内置工具集：read/write/grep/glob/exec/webfetch/websearch/kb_search；文件路径为安全链注入的 safePath（绝对路径），仅 exec 的 shell 工作目录以 root 为基准；webSearch 供测试注入桩 Provider，缺省按环境解析（DDG/Bing）；archive 为工具出口预算接缝（超限截断+全文落盘留 read 恢复路径），缺省不设预算（旧测试桩行为不变）；memory 为记忆写入接缝（第 7 可选参，缺省不注入＝旧行为逐字节不变，工具清单零变化） */
export function builtinTools(safety: SafetyChain, root: string, kb?: KnowledgeBase, webSearch?: WebSearchProvider, archive?: ToolOutputArchive, skills?: SkillsFacade, memory?: MemoryWriteSeam): RegisteredTool[] {
  // 出口预算统一管线：注册了 archive 的工具出口过 fit；未注册保持现行行为（逐字节不变）
  const fitOut = (tool: string, out: string): string => (archive ? archive.fit(tool, out) : out);
  const execOut = (stdout: string, stderr = ''): ExecResult => ({ exitCode: 0, stdout, stderr, timedOut: false });
  const backend = safety.backend;

  return [
    {
      name: 'exec',
      description: pick('Execute a shell command inside the project sandbox; oversized output is truncated and saved to disk (full output path shown in the result)', '在沙箱内执行 shell 命令；超长输出将截断并落盘，完整输出路径见结果提示行'),
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
      description: pick(
        'Read file content; optional range selects lines, 1-based inclusive: "L100-125" lines 100-125; "L100" or "L100-" from line 100 to EOF; "L-20" first 20 lines; output prefixed with line numbers; oversized output is truncated and saved to disk (full output path shown in the result)',
        '读取文件内容；可选 range 选择行段（1-based 闭区间）："L100-125" 读 100-125 行；"L100" 或 "L100-" 从 100 行读到文件尾；"L-20" 读前 20 行；输出带行号前缀；超长输出将截断并落盘，完整输出路径见结果提示行',
      ),
      category: 'read',
      executor: async (input: ToolInput) => {
        const content = backend.readFile(String(input.path));
        const range = input.range === undefined ? '' : String(input.range).trim();
        if (range === '') return execOut(fitOut('read', content));
        // 形态语义：L<a>-<b> 闭区间；L<a> 与 L<a>- 同义（a 行到尾）；L-<b>（前 b 行）；越界钳制到文件实际范围
        const m = /^L(?<a>\d+)?(?:-(?<b>\d+)?)?$/.exec(range);
        const a = m?.groups?.a === undefined ? NaN : parseInt(m.groups.a, 10);
        const b = m?.groups?.b === undefined ? NaN : parseInt(m.groups.b, 10);
        if (!m || (Number.isNaN(a) && Number.isNaN(b))) throw new CodedToolError('INVALID_ARG', pick(`Invalid range "${range}"; expected L<start>-<end> like L100-125`, `range 参数不合法："${range}"；应为 L<起>-<止> 形如 L100-125`));
        const lines = content.split('\n');
        const start = Math.max(1, Number.isNaN(a) ? 1 : a);
        const end = Math.min(lines.length, Number.isNaN(b) ? lines.length : b);
        if (!Number.isNaN(b) && b < start) throw new CodedToolError('INVALID_ARG', pick(`Range end before start: ${range}`, `range 区间结束行小于起始行：${range}`));
        return execOut(fitOut('read', lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n')));
      },
    },
    {
      name: 'skill',
      description: pick(
        'Load a skill\'s full instructions by id when the task matches an entry in the available skills list; oversized output is truncated and saved to disk (full output path shown in the result)',
        '当任务匹配「可用技能」清单中的某项时，按 id 加载技能全文；超长输出将截断并落盘，完整输出路径见结果提示行',
      ),
      category: 'read',
      executor: async (input: ToolInput) => {
        if (!skills) throw new CodedToolError('skill_not_configured', pick('Skill facade is not wired in this run', '本次运行未装配技能门面'));
        const id = String(input.id ?? '').trim();
        if (id === '') throw new CodedToolError('INVALID_ARG', pick('Missing skill id', '缺少技能 id'));
        const raw = input.params;
        if (raw !== undefined && (typeof raw !== 'object' || raw === null)) throw new CodedToolError('INVALID_ARG', pick('params must be a name→value object', 'params 须为 名→值 对象'));
        const r = skills.resolve(id, raw as Record<string, string> | undefined);
        if (!r.ok) throw new CodedToolError(r.error.code, `${r.error.code}: ${r.error.message}`);
        return execOut(fitOut('skill', `[Skill] ${r.value.manifest.name || id}\n\n${r.value.body}`));
      },
    },
    {
      name: 'write',
      description: pick('Write file content', '写入文件内容'),
      category: 'write',
      executor: async (input: ToolInput) => {
        const p = String(input.path);
        const content = String(input.content ?? '');
        // 记忆写入接缝（规格 §4.4）：命中记忆路径走接缝（校验/规范化/索引/容量回执）；未注入接缝＝旧行为
        if (memory) {
          const r = memory({
            root,
            absPath: p,
            content,
            // scope 只接 safety.memoryScope（undefined | agents/<id>）：显式 'main' 等价全拒，非设计意图
            ...(safety.memoryScope !== undefined ? { scope: safety.memoryScope } : {}),
            write: (abs, c) => backend.writeFile(abs, c),
          });
          if (!r.ok) throw new CodedToolError(r.error.code, r.error.message);
          if (r.value !== 'pass') return execOut(r.value.observation);
        }
        backend.writeFile(p, content);
        return execOut('written');
      },
    },
    {
      name: 'grep',
      description: pick('Regex search: for a file path emit raw matching lines; for a directory search recursively and emit relativePath:line:line', '正则搜索：path 为文件时输出裸命中行；为目录时递归检索并输出 相对路径:行号:行'),
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
      description: pick('List files matching a glob pattern; oversized listing is truncated and saved to disk (full output path shown in the result)', '按 glob 模式列出文件；超长列表将截断并落盘，完整输出路径见结果提示行'),
      category: 'read',
      executor: async (input: ToolInput) => execOut(fitOut('glob', backend.listFiles(root, String(input.pattern ?? '*')).join('\n'))),
    },
    {
      name: 'webfetch',
      description: pick('Fetch a web page: input { url }, http/https only (protocol floor enforced by the security guard); oversized body is truncated and saved to disk (full output path shown in the result)', '抓取网页正文：入参 { url }，仅允许 http/https（协议底线在安全链 guard）；超长正文将截断并落盘，完整输出路径见结果提示行'),
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
      description: pick('Web search: input { query, count? } (count default 5, max 10); stdout is title/URL/snippet lines; engine endpoint allows http/https only', '搜索网页：入参 { query, count? }（count 缺省 5，上限 10），stdout 为 标题/URL/摘要 行式列表；引擎端点仅允许 http/https'),
      category: 'network',
      executor: async (input: ToolInput) => {
        const provider = webSearch ?? resolveWebSearchProvider();
        const n = Number(input.count ?? 5);
        const count = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 10) : 5;
        const hits = await provider.search(String(input.query ?? ''), count);
        if (hits.length === 0) return execOut('（无结果）');
        return execOut(hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n'));
      },
    },
    {
      name: 'kb_search',
      description: pick('Local vector knowledge-base search: input { query, topK? }, stdout is KbHit[] JSON; degrades to kb_not_configured when not configured (never blocks other tools)', '本地向量知识库检索：入参 { query, topK? }，stdout 为 KbHit[] JSON；未配置时以 kb_not_configured 降级（不阻塞其他工具）'),
      category: 'read',
      executor: async (input: ToolInput) => {
        if (!kb) throw new CodedToolError('kb_not_configured', '知识库未配置：需 EMBEDDING_* 环境并完成 indexDir 索引');
        const hits = await kb.search(String(input.query ?? ''), Number(input.topK ?? 5));
        return execOut(JSON.stringify(hits));
      },
    },
  ];
}

import * as fs from 'fs';
import * as path from 'path';
import { RegisteredTool, CodedToolError } from '../tools';
import { SafetyChain } from '../security/chain';
import { ExecResult, ToolInput } from '../../types';
import { KnowledgeBase } from '../knowledge/index';

/** 内置工具集：read/write/grep/glob/exec/webfetch/kb_search；文件路径为安全链注入的 safePath（绝对路径），仅 exec 的 shell 工作目录以 root 为基准 */
export function builtinTools(safety: SafetyChain, root: string, kb?: KnowledgeBase): RegisteredTool[] {
  const execOut = (stdout: string, stderr = ''): ExecResult => ({ exitCode: 0, stdout, stderr, timedOut: false });
  const backend = safety.backend;

  return [
    {
      name: 'exec',
      description: '在沙箱内执行 shell 命令',
      category: 'bash',
      executor: async (input: ToolInput) => {
        const cmd = String(input.command ?? '');
        const r = await safety.run(cmd, { cwd: root });
        if (r.ok) return r.value;
        throw new Error(`${r.error.code}: ${r.error.message}`);
      },
    },
    {
      name: 'read',
      description: '读取文件内容',
      category: 'read',
      executor: async (input: ToolInput) => execOut(backend.readFile(String(input.path))),
    },
    {
      name: 'write',
      description: '写入文件内容',
      category: 'write',
      executor: async (input: ToolInput) => {
        backend.writeFile(String(input.path), String(input.content ?? ''));
        return execOut('written');
      },
    },
    {
      name: 'grep',
      description: '正则搜索：path 为文件时输出裸命中行；为目录时递归检索并输出 相对路径:行号:行',
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
      description: '按 glob 模式列出文件',
      category: 'read',
      executor: async (input: ToolInput) => execOut(backend.listFiles(root, String(input.pattern ?? '*')).join('\n')),
    },
    {
      name: 'webfetch',
      description: '抓取白名单内域名的网页正文（域名闸门在安全链 guard；正文截断 10 万字符）',
      category: 'network',
      executor: async (input: ToolInput) => {
        const res = await fetch(String(input.url ?? ''));
        if (!res.ok) throw new Error(`WEBFETCH_HTTP_${res.status}`);
        const text = await res.text();
        return execOut(text.slice(0, 100_000));
      },
    },
    {
      name: 'kb_search',
      description: '本地向量知识库检索：入参 { query, topK? }，stdout 为 KbHit[] JSON；未配置时以 kb_not_configured 降级（不阻塞其他工具）',
      category: 'read',
      executor: async (input: ToolInput) => {
        if (!kb) throw new CodedToolError('kb_not_configured', '知识库未配置：需 EMBEDDING_* 环境并完成 indexDir 索引');
        const hits = await kb.search(String(input.query ?? ''), Number(input.topK ?? 5));
        return execOut(JSON.stringify(hits));
      },
    },
  ];
}

import * as fs from 'fs';
import * as path from 'path';
import { RegisteredTool } from '../tools';
import { SafetyChain } from '../security/chain';
import { ExecResult, ToolInput } from '../../types';

/** 内置工具集：read/write/grep/glob/exec；文件路径与 shell 工作目录均以 root 为基准，与感知引擎一致 */
export function builtinTools(safety: SafetyChain, root: string): RegisteredTool[] {
  const execOut = (stdout: string, stderr = ''): ExecResult => ({ exitCode: 0, stdout, stderr, timedOut: false });
  const resolve = (p: unknown): string => path.resolve(root, String(p ?? ''));

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
      executor: async (input: ToolInput) => execOut(fs.readFileSync(resolve(input.path), 'utf8')),
    },
    {
      name: 'write',
      description: '写入文件内容',
      category: 'write',
      executor: async (input: ToolInput) => {
        const target = resolve(input.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(input.content ?? ''));
        return execOut('written');
      },
    },
    {
      name: 'grep',
      description: '在文件中搜索正则',
      category: 'read',
      executor: async (input: ToolInput) => {
        const { pattern, path: p } = input as { pattern: string; path: string };
        const content = fs.readFileSync(resolve(p), 'utf8');
        const lines = content.split('\n').filter((l) => new RegExp(pattern).test(l));
        return execOut(lines.join('\n'));
      },
    },
    {
      name: 'glob',
      description: '按 glob 模式列出文件',
      category: 'read',
      executor: async (input: ToolInput) => {
        const pattern = String(input.pattern ?? '*');
        const matches = findFiles(root, pattern);
        return execOut(matches.join('\n'));
      },
    },
  ];
}

function findFiles(root: string, pattern: string): string[] {
  const re = new RegExp(globToRegex(pattern));
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const rel = path.relative(root, full);
        if (re.test(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

/** 文件路径 glob 转正则：双星号斜杠匹配零个或多个目录段，单星号与问号不跨越斜杠 */
function globToRegex(pattern: string): string {
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      let j = i;
      while (pattern[j] === '*') j++;
      if (pattern[j] === '/') {
        out += '(?:[^/]*/)*';
        i = j + 1;
      } else {
        out += '[^/]*';
        i = j;
      }
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else {
      out += escapeRegExp(c);
      i++;
    }
  }
  return out + '$';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

import * as fs from 'fs';
import { RegisteredTool } from '../tools';
import { Sandbox } from '../security/sandbox';
import { ExecResult, ToolInput } from '../../types';

/** 内置工具集：read/write/grep/glob/exec */
export function builtinTools(sandbox: Sandbox): RegisteredTool[] {
  const execOut = (stdout: string, stderr = ''): ExecResult => ({ exitCode: 0, stdout, stderr, timedOut: false });

  return [
    {
      name: 'exec',
      description: '在沙箱内执行 shell 命令',
      category: 'bash',
      executor: async (input: ToolInput) => {
        const cmd = String(input.command ?? '');
        const r = await sandbox.run(cmd);
        if (r.ok) return r.value;
        throw new Error(`${r.error.code}: ${r.error.message}`);
      },
    },
    {
      name: 'read',
      description: '读取文件内容',
      category: 'read',
      executor: async (input: ToolInput) => execOut(fs.readFileSync(String(input.path), 'utf8')),
    },
    {
      name: 'write',
      description: '写入文件内容',
      category: 'write',
      executor: async (input: ToolInput) => {
        fs.writeFileSync(String(input.path), String(input.content ?? ''));
        return execOut('written');
      },
    },
    {
      name: 'grep',
      description: '在文件中搜索正则',
      category: 'read',
      executor: async (input: ToolInput) => {
        const { pattern, path } = input as { pattern: string; path: string };
        const content = fs.readFileSync(path, 'utf8');
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
        const matches = findFiles(pattern);
        return execOut(matches.join('\n'));
      },
    },
  ];
}

function findFiles(pattern: string): string[] {
  const dir = pattern.startsWith('/') ? '/' : '.';
  const re = new RegExp('^' + pattern.replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*') + '$');
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = `${d}/${e.name}`.replace(/^\.\//, '');
      if (e.isDirectory()) walk(full);
      else if (re.test(full)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

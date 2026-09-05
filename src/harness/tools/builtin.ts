import { RegisteredTool } from '../tools';
import { SafetyChain } from '../security/chain';
import { ExecResult, ToolInput } from '../../types';

/** 内置工具集：read/write/grep/glob/exec；文件路径为安全链注入的 safePath（绝对路径），仅 exec 的 shell 工作目录以 root 为基准 */
export function builtinTools(safety: SafetyChain, root: string): RegisteredTool[] {
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
      description: '在文件中搜索正则',
      category: 'read',
      executor: async (input: ToolInput) => {
        const { pattern } = input as { pattern: string };
        const content = backend.readFile(String(input.path));
        const lines = content.split('\n').filter((l) => new RegExp(pattern).test(l));
        return execOut(lines.join('\n'));
      },
    },
    {
      name: 'glob',
      description: '按 glob 模式列出文件',
      category: 'read',
      executor: async (input: ToolInput) => execOut(backend.listFiles(root, String(input.pattern ?? '*')).join('\n')),
    },
  ];
}

/**
 * /init 目标构造器（纯函数）：构造 Claude Code /init 同款的模型驱动分析任务——
 * 模型在主链（Reactor → 工具面）里自行 read/grep 感知代码库并 write 生成/完善 SUNSHINE.md，
 * 写盘经安全链（manual 模式经 asker 审批）。本模块只产出 goal 文本，不做任何 IO。
 */
import * as path from 'path';
import { pick } from '../i18n';

/** /init 任务目标：只约定任务契约（落点路径、真实性底线、完善语义），不预设探索手段与文档细节——怎么分析、写什么分区交给模型按项目实际判断 */
export function sunshineInitGoal(root: string, exists: boolean): string {
  const p = path.join(root, 'SUNSHINE.md');
  return [
    pick(
      `Analyze the current codebase and ${exists ? 'refine' : 'generate'} the project config file SUNSHINE.md (${p}).`,
      `分析当前代码库，${exists ? '完善' : '生成'}项目配置文件 SUNSHINE.md（${p}）。`,
    ),
    pick(
      'It is the long-lived project convention injected into the agent context every turn: organize it with # sections and capture the project facts the agent needs for effective collaboration (project purpose, build/test commands, architecture layers, key coding conventions).',
      '它是每轮注入 Agent 上下文的长期项目约定：用 # 分区组织，写明 Agent 高效协作所需的项目事实（如项目定位、构建/测试方式、架构分层、关键编码约定）。',
    ),
    pick(
      'All content must come from actual observation of the codebase; never fabricate modules, commands, or conventions that do not exist.',
      '内容必须来自对代码库的实际观察，禁止编造不存在的模块、命令或约定。',
    ),
    exists
      ? pick(
          'The file already exists: read it first and refine on top of it — keep everything the user wrote as-is; do not rewrite it wholesale.',
          '该文件已存在：先读取原文，在既有内容基础上补充与修订——用户已写内容原样保留，不整体推翻。',
        )
      : pick('The project does not have this file yet: generate it from scratch.', '当前项目还没有该文件：从零生成。'),
    pick('When done, report in one sentence what you did.', '完成后用一句话汇报做了什么。'),
  ].join('\n');
}

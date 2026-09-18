/**
 * /init 目标构造器（纯函数）：构造 Claude Code /init 同款的模型驱动分析任务——
 * 模型在主链（Reactor → 工具面）里自行 read/grep 感知代码库并 write 生成/完善 SUNSHINE.md，
 * 写盘经安全链（manual 模式经 asker 审批）。本模块只产出 goal 文本，不做任何 IO。
 */
import * as path from 'path';
import { pick } from '../i18n';

/**
 * /init 任务目标（七层：任务落点 / 文件性质 / 探索要求 / 覆盖大纲 / 写法要求 / 新建完善分支 / 收尾）。
 * 大纲只说明「哪些事实不能缺席」，不给任何标题文本——分区命名与组织由模型按项目实况自定；
 * 一份提示词只出现一种语言（pick 按会话语言选定），不并列双语字面；
 * 产出语言由模型按当前项目文档风格自判，提示词不写语言条款（CLAUDE.md §15）。
 */
export function sunshineInitGoal(root: string, exists: boolean): string {
  const p = path.join(root, 'SUNSHINE.md');
  return [
    // L1 任务与落点
    pick(
      `Analyze the current codebase and ${exists ? 'refine' : 'generate'} the project convention file SUNSHINE.md (${p}).`,
      `分析当前代码库，${exists ? '完善' : '生成'}项目约定文件 SUNSHINE.md（${p}）。`,
    ),
    // L2 文件性质（每轮注入，每行都在花 token）
    pick(
      'Every turn reads this file into the agent context, so each line costs tokens: record long-lived project facts only — never history, plans or progress notes.',
      '该文件每轮都会读入 Agent 上下文，每一行都在花 token：只记录长期稳定的项目事实，不写历史、计划与进度。',
    ),
    // L3 探索与证据要求
    pick(
      'Read the project before writing: dependency and script definitions, entry files, configuration, directory layout, CI setup. Every statement must be traceable to something you actually read; never fabricate modules, commands or conventions that do not exist.',
      '落笔前先读项目：依赖与脚本定义、入口文件、配置、目录实况、CI 设置。每条陈述都必须能追溯到真正读过的东西，禁止编造不存在的模块、命令或约定。',
    ),
    // L4a 大纲使用口径
    pick(
      'The outline below is a coverage check, not a format: it lists facts that must not be missing. Headings, order and grouping are yours to decide.',
      '下面的大纲是覆盖清单、不是格式：它列出不能缺席的事实。标题、顺序与组织方式由你自己决定。',
    ),
    // L4b A 档：有证据则必写（5 类）
    pick(
      'Always cover these five when evidence exists: what the project is (name, one-line purpose, stack and runtime, main subsystems); how to run it (install, build, test, single-test filter, run, static check, release — copyable commands with when to use them); how the code is laid out (meaningful paths and what each is for); how it is structured (layers and dependency direction, module boundaries and seams, data and control flow, invariants that must not break); how to write code here (language and strictness, file responsibility, error handling, shared type registration, dependency admission rules).',
      '有证据时，以下五类必须覆盖：项目是什么（名称、一句话定位、技术栈与运行时、主要子系统）；命令怎么跑（安装、构建、测试、单测过滤、运行、静态检查、发布——可复制的命令，并说明何时用）；代码怎么摆（有意义的路径及各自职责）；架构怎么分（分层与依赖方向、模块边界与接缝、数据与控制流、不可破的不变量）；代码怎么写（语言与严格度、文件职责边界、错误处理、共享类型登记、依赖引入标准）。',
    ),
    // L4c B 档：有证据才写（6 类）
    pick(
      'Add these only when the project actually has them: commit-time gates; packaging and release; environment variables or config files and their precedence; extension points (plugins, skills, workflows) and how they load; platform differences and version floors; prohibitions, unwritable areas, permission limits.',
      '只有在项目确实存在时才补这些：提交前门禁；打包与发布；环境变量或配置文件及其优先级；扩展点（插件、技能、工作流）与加载方式；平台差异与版本下限；禁止项、不可写区与权限限制。',
    ),
    // L5 写法与质量
    pick(
      'Keep it dense: one fact per line, written for whoever works here next; give numbers where they exist and relative paths for locations. Skip general advice such as "write clean code", skip inventories that rot quickly, and leave no placeholders or TODO markers. Aim for 60-120 lines; when evidence is missing, omit rather than pad. Write the whole document in a single write when you are done — never in pieces.',
      '写紧凑：一条一行、面向接下来在此工作的人；有数字给数字，位置用相对路径。不写「写清晰的代码」这类通用建议，不写会很快过期的清单，不留占位符或 TODO 标记。目标 60–120 行；没有证据的宁可省略也不要硬凑。收尾时一次性写出完整文档，不要分次写。',
    ),
    // L6 新建 / 完善分支
    exists
      ? pick(
          'The file already exists: read it in full first, then append only what is missing. Keep every existing line as-is — its headings, wording and order included; do not rewrite it wholesale, and do not delete or reword anything already there. Write the merged result back in one go.',
          '该文件已存在：先完整读取，然后只补缺失的内容。既有每一行都原样保留——包括它自己的标题、措辞与顺序；不得整体推翻，不得删除或改写任何既有内容。然后把合并结果一次性写回。',
        )
      : pick('The project does not have this file yet: generate it from scratch.', '当前项目还没有该文件：从零生成。'),
    // L7 收尾
    pick(
      'When done, report in one sentence which facts you added.',
      '完成后用一句话汇报补齐了哪些事实。',
    ),
  ].join('\n');
}

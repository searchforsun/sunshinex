/**
 * /init 目标构造器（纯函数）：构造 Claude Code /init 同款的模型驱动分析任务——
 * 模型在主链（Reactor → 工具面）里自行 read/grep 感知代码库并 write 生成/完善 SUNSHINE.md，
 * 写盘经安全链（manual 模式经 asker 审批）。本模块只产出 goal 文本，不做任何 IO。
 */
import * as path from 'path';

/**
 * /init 任务目标（七层：任务落点 / 文件性质 / 探索要求 / 覆盖大纲 / 写法要求 / 新建完善分支 / 收尾）。
 * 大纲只说明「哪些事实不能缺席」，不给任何标题文本——分区命名与组织由模型按项目实况自定；
 * goal 属提示词面，恒英文单语（不随 --language 分叉、不写成双语对）；
 * 产出语言由模型按当前项目文档风格自判，提示词不写语言条款（CLAUDE.md §15）。
 */
export function sunshineInitGoal(root: string, exists: boolean): string {
  const p = path.join(root, 'SUNSHINE.md');
  return [
    // L1 任务与落点
    `Analyze the current codebase and ${exists ? 'refine' : 'generate'} the project convention file SUNSHINE.md (${p}).`,
    // L2 文件性质（每轮注入，每行都在花 token）
    'Every turn reads this file into the agent context, so each line costs tokens: record long-lived project facts only — never history, plans or progress notes.',
    // L3 探索与证据要求
    'Read the project before writing: dependency and script definitions, entry files, configuration, directory layout, CI setup. Every statement must be traceable to something you actually read; never fabricate modules, commands or conventions that do not exist.',
    // L4a 大纲使用口径
    'The outline below is a coverage check, not a format: it lists facts that must not be missing. Headings, order and grouping are yours to decide.',
    // L4b A 档：有证据则必写（5 类）
    'Always cover these five when evidence exists: what the project is (name, one-line purpose, stack and runtime, main subsystems); how to run it (install, build, test, single-test filter, run, static check, release — copyable commands with when to use them); how the code is laid out (meaningful paths and what each is for); how it is structured (layers and dependency direction, module boundaries and seams, data and control flow, invariants that must not break); how to write code here (language and strictness, file responsibility, error handling, shared type registration, dependency admission rules).',
    // L4c B 档：有证据才写（6 类）
    'Add these only when the project actually has them: commit-time gates; packaging and release; environment variables or config files and their precedence; extension points (plugins, skills, workflows) and how they load; platform differences and version floors; prohibitions, unwritable areas, permission limits.',
    // L5 写法与质量
    'Keep it dense: one fact per line, written for whoever works here next; give numbers where they exist and relative paths for locations. Skip general advice such as "write clean code", skip inventories that rot quickly, and leave no placeholders or TODO markers. Aim for 60-120 lines; when evidence is missing, omit rather than pad. Write the whole document in a single write when you are done — never in pieces.',
    // L6 新建 / 完善分支
    exists
      ? 'The file already exists: read it in full first, then append only what is missing. Keep every existing line as-is — its headings, wording and order included; do not rewrite it wholesale, and do not delete or reword anything already there. Write the merged result back in one go.'
      : 'The project does not have this file yet: generate it from scratch.',
    // L7 收尾
    'When done, report in one sentence which facts you added.',
  ].join('\n');
}

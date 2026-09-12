/**
 * /init 目标构造器（纯函数）：构造 Claude Code /init 同款的模型驱动分析任务——
 * 模型在主链（Reactor → 工具面）里自行 read/grep 感知代码库并 write 生成/完善 SUNSHINE.md，
 * 写盘经安全链（manual 模式经 asker 审批）。本模块只产出 goal 文本，不做任何 IO。
 */

/** /init 任务目标：产出贴合本项目的 SUNSHINE.md（新建或完善既有文件，完成后如实汇报落点） */
export function sunshineInitGoal(root: string, exists: boolean): string {
  const action = exists
    ? `项目根已存在 ${root} 下的 SUNSHINE.md：先 read 读取现状，保留用户已写内容，分析代码库后将缺失/过时的分区补充完善（已有分区可修订表述，不得整体覆盖推翻）。`
    : `项目根 ${root} 下还没有 SUNSHINE.md：分析代码库后从零生成它。`;
  return [
    '请分析当前项目并生成/完善项目根的 SUNSHINE.md（项目配置文件，框架以 # 分区解析，每轮注入 Agent 上下文）。',
    action,
    '步骤要求：',
    '1. 先感知现状：读 package.json（或等价清单）、README、目录结构（可用 ls/grep/read），弄清项目用途、技术栈与分层。',
    '2. 用 write 写出/完善 SUNSHINE.md，分区至少包含：「项目名称」（单行名）、「项目概述」（2-3 句话）、「架构原则」（每行一条，以 - 开头，写真实分层/模块约定）、「编码规范」（每行一条，以 - 开头，写可执行的关键约束）；内容必须来自对代码库的实际观察，禁止编造不存在的模块或命令。',
    '3. MCP 服务器登记制安全分区不要自行添加；已有则原样保留。',
    '4. 完成后用一句话 reply 汇报：新建还是完善、写入了哪些分区。',
  ].join('\n');
}

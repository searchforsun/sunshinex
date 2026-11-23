/**
 * 简洁模式(2026-11-14 用户裁定「设置页提供简洁模式」):两阶段正文之间的工具/思考行段外面
 * 再加一层段级折叠——折叠头=交织双方形图标+各类调用总结(查阅了文件 · 运行了命令 · 修改了
 * 文件…),展开后露出既有段内聚合(查阅 ×N 组)为第二层;运行中只显正在运行的一行(流光),
 * 跑完向上并入折叠行(纯渲染层识别)。逃逸面(不进折叠层,恒独立行)=子智能体 spawn、智能体
 * 团队/成员/板面工具、交互问询 ask_question、计划提交 exit_plan、工作树 worktree、任务停止——
 * 影响大/有交互/用户核心关注点的行不折叠;其余(查阅/命令/网页/编辑/技能/记忆/待办/等待/思考)
 * 全部并入。落根 html[data-concise-mode];2026-11-17 裁定缺省「开」——普通态恒开,
 * 开发者模式开=存储值。状态机制在 ui-pref-boolean 工厂单点(D84 收敛:原手写克隆退役)。
 */
import { booleanPref } from './ui-pref-boolean';

const pref = booleanPref('conciseMode');

export const readConciseMode = pref.readEffective;
export const applyConciseMode = pref.apply;
export const useConciseMode = pref.usePref;

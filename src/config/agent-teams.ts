/**
 * agentTeams 启用解析单点（spec §2）：显式 env > 项目 settings > 全局 settings > 缺省 true。
 * 仅接受 boolean 或 on/off/true/false 字符串（与 autoMemory 同类）；非法值装配期 fail-fast。
 */
import { parseSettingsFile, loadProjectSettings, loadGlobalSettings } from './settings';

function parseAgentTeamsFlag(raw: unknown, source: string): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'on' || v === 'true') return true;
    if (v === 'off' || v === 'false') return false;
  }
  throw new Error(`agentTeams config: ${source} must be boolean|on|off|true|false, got ${JSON.stringify(raw)}`);
}

function readSettingsFlag(filePath: string): boolean | undefined {
  const doc = parseSettingsFile(filePath);
  if (doc === null) return undefined;
  const raw = doc.semantic['agentTeams'];
  if (raw === undefined) return undefined;
  return parseAgentTeamsFlag(raw, filePath);
}

/** 工作区 root 下智能体团队能力是否启用（缺省 true） */
export function agentTeamsEnabled(root: string): boolean {
  const envRaw = process.env.SUNSHINEX_AGENT_TEAMS;
  if (envRaw !== undefined && envRaw.trim() !== '') {
    return parseAgentTeamsFlag(envRaw, 'SUNSHINEX_AGENT_TEAMS');
  }
  const project = readSettingsFlag(loadProjectSettings(root));
  if (project !== undefined) return project;
  const global = readSettingsFlag(loadGlobalSettings());
  if (global !== undefined) return global;
  return true;
}

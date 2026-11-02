/**
 * sunshinex settings get/set（Task 18，Phase D 第二批 catalog CLI 族）：语义键读面的 CLI 出口 +
 * 语义键结构化写（settings 无 catalog 写面模块——写路径沿 serve handleSettingsPut 的语义键纪律就地收口）。
 * - get <key>：effective 值 + 来源单行上屏（env/project/global/default——复用 serve/config-helpers 的
 *   effectiveKeyRow 单点：CLI 入口 main 已跑 loadSettingsChain，selfFilledSlots 登记在册，来源归因与
 *   GUI /settings 同源不漂移；fileSlots 两级槽集同源）；未知键（含历史退役键——2026-10-29 去兼容清理
 *   撤专属指引面）→ error + exit 1。
 * - set <key> <value> [--scope=global|project]：SEMANTIC_KEYS 校验（Object.hasOwn 防原型键穿透——
 *   handleSettingsPut 同款）后沿其语义键写路径落盘：含注释文件走 surgicalSettingsUpdate 逐行手术
 *   （行尾注释/缩进/其余键逐字保真；不支持形态 → error 引流 raw 编辑面 + exit 1，零盘上副作用）；
 *   普通文件整读改写（version 守卫 + writeJsonAtomic 原子写，新档补 version:1）。CLI 值恒字符串
 *   （flattenSettings 面 String() 归一，数字语义键等价）。写成功后 notifyCatalogWrite('settings',...)
 *   （与 catalog 各写面同构；CLI 进程内钩子缺省 no-op，daemon 内嵌跑法回环抑制同键可用）。
 * 通道即语义（mcp.ts 先例）：结果面 stdout、诊断面 stderr、非法参数 usage + exit 1。
 */
import * as fs from 'node:fs';
import {
  SEMANTIC_KEYS,
  getSelfFilledSlots,
  hasJsonComments,
  loadGlobalSettings,
  loadProjectSettings,
  surgicalSettingsUpdate,
} from '../../config/settings';
import { effectiveKeyRow, fileSlots } from '../../serve/config-helpers';
import { notifyCatalogWrite, settingsPathOf, writeJsonAtomic } from '../../catalog/io';
import { t } from '../../i18n';
import { resolveTarget } from './catalog-common';

function printUsage(): void {
  console.error(t(
    'Usage: sunshinex settings get <key> | set <key> <value> [--scope=global|project]',
    '用法：sunshinex settings get <键> | set <键> <值> [--scope=global|project]',
  ));
}

function getCmd(args: string[]): number {
  const key = args[0];
  if (key === undefined || key.startsWith('--')) {
    printUsage();
    return 1;
  }
  const target = resolveTarget(args.slice(1));
  if (target.bad) {
    printUsage();
    return 1;
  }
  if (!Object.hasOwn(SEMANTIC_KEYS, key)) {
    console.error(t(`error: unknown settings key: ${key}`, `error：未知设置键：${key}`));
    return 1;
  }
  // 来源归因与 GUI /settings 同源（effectiveKeyRow 单点）：selfFilled 由入口 main 的 loadSettingsChain
  // 登记——「槽在 env 但非自填」即真导出环境变量（env override）；fileSlots 降级口径同款（缺/畸形按空）
  const selfFilled = new Set(getSelfFilledSlots());
  const projectSlots = fileSlots(loadProjectSettings(target.root ?? process.cwd()));
  const globalSlots = fileSlots(loadGlobalSettings());
  const row = effectiveKeyRow(key, SEMANTIC_KEYS[key]!, selfFilled, projectSlots, globalSlots);
  // 单行数据面（语言中立）：`key=value (source: …)`；value null = 文件有配置但链未生效的窄缝，如实报 <unset>
  const override = row.envOverride ? ', env override' : '';
  console.log(`${key}=${row.value ?? '<unset>'} (source: ${row.source}${override})`);
  return 0;
}

function setCmd(args: string[]): number {
  const key = args[0];
  const value = args[1];
  // 值守卫：缺值/空串/形如旗标 → usage（空串在 flatten 面等价未配置，写了等于没写，不如拒）
  if (key === undefined || key.startsWith('--') || value === undefined || value === '' || value.startsWith('--')) {
    printUsage();
    return 1;
  }
  const target = resolveTarget(args.slice(2));
  if (target.bad) {
    printUsage();
    return 1;
  }
  if (!Object.hasOwn(SEMANTIC_KEYS, key)) {
    console.error(t(`error: unknown settings key: ${key}`, `error：未知设置键：${key}`));
    return 1;
  }
  const file = settingsPathOf(target.scope, target.root);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (raw !== null && hasJsonComments(raw)) {
    // 注释保留式手术写（handleSettingsPut 同款）：只动目标键，行尾注释/缩进/其余键逐字保真；
    // 不支持形态（多行/嵌套值、单行对象、复验不过）→ error 引流 raw 编辑面，零盘上副作用
    const patched = surgicalSettingsUpdate(raw, { [key]: value });
    if (patched === null) {
      console.error(t(
        'error: settings file contains comments in an unsupported layout; edit it manually',
        'error：settings 文件含本面不支持的注释排版；请手工编辑该文件',
      ));
      return 1;
    }
    writeJsonAtomic(file, patched);
  } else {
    let obj: Record<string, unknown>;
    if (raw === null) {
      obj = { version: 1 }; // 新档补 version:1（settings schema 口径，handleSettingsPut 同款）
    } else {
      try {
        obj = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as Record<string, unknown>; // BOM 容忍（与 parseSettingsFile 同口径）
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(t(
          `error: settings file is not valid JSON: ${file}: ${reason}`,
          `error：settings 文件非合法 JSON：${file}：${reason}`,
        ));
        return 1;
      }
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      console.error(t(`error: settings root must be a JSON object: ${file}`, `error：settings 根必须是 JSON 对象：${file}`));
      return 1;
    }
    if ((obj['version'] ?? 1) !== 1) {
      console.error(t(
        `error: unsupported settings version: ${JSON.stringify(obj['version'] ?? 1)}: ${file}`,
        `error：settings version 仅支持 1，收到 ${JSON.stringify(obj['version'] ?? 1)}：${file}`,
      ));
      return 1;
    }
    obj[key] = value;
    // 原子写：writeJsonAtomic（同目录 tmp + rename，目录缺则建）——与 catalog 写面同一纪律单点
    writeJsonAtomic(file, JSON.stringify(obj, null, 2) + '\n');
  }
  // 写通知（catalog 纪律同构）：settings 语义键落盘 → ('settings', scope, root)（watcher 映射同构；
  // scope=global 由 notify 单点归一 root=null）
  notifyCatalogWrite('settings', target.scope, target.root);
  console.log(t(
    `ok: ${key}=${value} (${target.scope} ${file})`,
    `ok：${key}=${value}（${target.scope} ${file}）`,
  ));
  return 0;
}

/** 命令入口：settings get/set；返回 exit code（0 成功 / 1 用法错、未知键或写失败），调用方落 process.exitCode */
export async function runSettings(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === 'get') return getCmd(args.slice(1));
  if (sub === 'set') return setCmd(args.slice(1));
  printUsage();
  return 1;
}

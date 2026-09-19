import { applySettings, loadGlobalSettings, loadProjectSettings } from './config/settings';
import { t } from './i18n';

/**
 * 两级 settings 装载（项目级 → 全局级）：applySettings 只填缺省槽，先装者不被覆盖，装载顺序即优先级。
 * 抛错（畸形 JSON / version 非 1）属 fail-fast：入口层透出含文件路径的错误信息并退出非零；
 * warnings 经 stderr 逐行双语输出（外观通道，库内零打印）。
 */
function loadSettingsChain(projectRoot: string): void {
  try {
    for (const result of [applySettings(loadProjectSettings(projectRoot)), applySettings(loadGlobalSettings())]) {
      for (const w of result.warnings) console.error(t(`settings warning: ${w}`, `settings 警告：${w}`));
    }
  } catch (err) {
    console.error(t(
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err.message : String(err),
    ));
    process.exit(1);
  }
}

// 三级配置链（对标 Claude Code 用户级 + 项目级惯例）：已导出环境变量 > 项目 settings > 全局 settings
// 项目级先装、全局后装兜底——装载器只填缺省键，后装者仅补缺不覆盖，顺序即优先级
const projectRoot = process.cwd();
loadSettingsChain(projectRoot);
const args = process.argv.slice(2);
if (args.includes('--selfcheck')) {
  console.log(t('selfcheck moved to the CLI: npm run cli -- selfcheck', 'selfcheck 已迁移至 CLI：npm run cli -- selfcheck'));
} else {
  console.log('SunshineX skeleton loaded. Use --selfcheck to verify.');
}

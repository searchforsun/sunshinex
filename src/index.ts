import { loadEnv, loadGlobalEnv } from './config/env';
import { t } from './i18n';

// 三级配置链：已导出环境变量 > 项目 .env > ~/.sunshinex/.env（项目级先装、全局后装兜底，后装者仅补缺）
loadEnv();
loadGlobalEnv();
const args = process.argv.slice(2);
if (args.includes('--selfcheck')) {
  console.log(t('selfcheck moved to the CLI: npm run cli -- selfcheck', 'selfcheck 已迁移至 CLI：npm run cli -- selfcheck'));
} else {
  console.log('SunshineX skeleton loaded. Use --selfcheck to verify.');
}

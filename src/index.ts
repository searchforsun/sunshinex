import { loadEnv } from './config/env';

loadEnv();
const args = process.argv.slice(2);
if (args.includes('--selfcheck')) {
  console.log('selfcheck 已迁移至 CLI：npm run cli -- selfcheck');
} else {
  console.log('SunshineX skeleton loaded. Use --selfcheck to verify.');
}

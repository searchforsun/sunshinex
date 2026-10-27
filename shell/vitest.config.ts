// shell vitest 配置：默认排除面 + 构建产物目录（release/=electron-builder 产物,内含 extraResources
// 拷贝的插件树副本——其测试文件的跨包相对导入在拷贝位必然断,D55 对拍即被误扫;out/build=束产物）
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'release/**', 'out/**', 'build/**', '**/.{idea,git,cache,output,temp}/**'],
  },
});

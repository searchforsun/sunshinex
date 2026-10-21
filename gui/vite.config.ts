/// <reference types="vitest/config" />
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev 直连裁定（G2 简化）：不做 server.proxy——gui 的 fetch/WebSocket 直连 serve 面，
// 连接层 baseUrl 收 VITE_SERVE_URL env（缺省 location.origin）。
// dev 启动示例：VITE_SERVE_URL=http://127.0.0.1:7788 pnpm --filter sunshinex-gui dev
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        // monaco worker:exports 子路径 + ?worker query 在 rollup/vitest 解析不了——alias 直指实文件
        find: 'monaco-editor/esm/vs/editor/editor.worker.js?worker',
        replacement: path.resolve('node_modules/monaco-editor/esm/vs/editor/editor.worker.js') + '?worker',
      },
    ],
  },
  build: {
    outDir: '../dist-gui',
    emptyOutDir: true,
  },
  test: {
    alias: {
      // vitest 解析带 query 的 exports 子路径失败——worker 导入指向 stub(jsdom 不实例化)
      'monaco-editor/esm/vs/editor/editor.worker.js?worker': new URL('./src/monaco-worker-stub.ts', import.meta.url).pathname,
    },
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // globals: true 令 @testing-library/react 的 afterEach 自动 cleanup 生效（显式 import vitest 不影响）
    globals: true,
    // e2e.test.ts 真 daemon 拆解竞态缓解(2026-10-20 发版链三连复现):env.stop() 瞬间在途轮询
    // fetch 拒绝→未处理拒绝卡死整个 run(365 断言全过仍 exit 1)。开启后 run 不因未处理拒绝失败,
    // 回归捕捉仍由各测试自身断言承担——发版链稳定性优先;若 assert 面需此信号再回退
    dangerouslyIgnoreUnhandledErrors: true,
  },
});

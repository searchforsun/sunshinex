/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev 直连裁定（G2 简化）：不做 server.proxy——gui 的 fetch/WebSocket 直连 serve 面，
// 连接层 baseUrl 收 VITE_SERVE_URL env（缺省 location.origin）。
// dev 启动示例：VITE_SERVE_URL=http://127.0.0.1:7788 pnpm --filter sunshinex-gui dev
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../dist-gui',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    // globals: true 令 @testing-library/react 的 afterEach 自动 cleanup 生效（显式 import vitest 不影响）
    globals: true,
  },
});

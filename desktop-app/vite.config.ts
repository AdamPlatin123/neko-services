/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // fe-pet 分支只有桌宠引擎与演示页；配置页（index.html）由 fe-skeleton 分支并行开发，合并时拼接
  build: {
    rollupOptions: {
      input: { pet: resolve(here, 'pet-demo.html') },
    },
  },
  server: {
    port: 5190,
    // 记忆服务代理：桌宠轮询 POST /neko-memory/recent_history（比对 next_seq）
    proxy: {
      '/neko-memory': {
        target: 'http://127.0.0.1:48912',
        changeOrigin: true,
      },
    },
  },
  // 模型不入库：scripts/fetch-model.sh 下载到仓库根 desktop-app-assets/，
  // 这里把它整个作为静态目录，/models/xiaomai/... 直接可访问
  publicDir: resolve(here, '../desktop-app-assets'),
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

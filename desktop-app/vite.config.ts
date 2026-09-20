/// <reference types="vitest" />
import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nekoBackend from "./src/server/plugin.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [nekoBackend()],
  // 多页文档流：根跳转页 + 首启海报 + 纸质配置页 + 桌宠演示页
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        welcome: "src/pages/welcome/index.html",
        settings: "src/pages/settings/index.html",
        pet: resolve(here, "pet-demo.html"),
      },
    },
  },
  server: {
    port: 48930,
    strictPort: false,
    // 记忆服务代理：桌宠轮询 POST /neko-memory/recent_history（比对 next_seq）
    proxy: {
      "/neko-memory": {
        target: "http://127.0.0.1:48912",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 48930,
    strictPort: false,
  },
  // 模型不入库：scripts/fetch-model.sh 下载到仓库根 desktop-app-assets/，
  // 这里把它整个作为静态目录，/models/xiaomai/... 与 /textures/... 直接可访问
  publicDir: resolve(here, "../desktop-app-assets"),
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

/// <reference types="vitest" />
import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nekoBackend from "./src/server/plugin.ts";

const here = fileURLToPath(new URL(".", import.meta.url).href);

export default defineConfig({
  plugins: [nekoBackend()],
  // 多页文档流：根跳转页 + 首启海报 + 纸质配置页 + 桌宠演示页
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        welcome: "src/pages/welcome/index.html",
        settings: "src/pages/settings/index.html",
        companion: "src/pages/companion/index.html",
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
        // 剥前缀：引擎请求 /neko-memory/recent_history/{n}，服务端路由是 /recent_history/{n}
        rewrite: (p: string) => p.replace(/^\/neko-memory/, ""),
      },
      // companion 聊天页的 WS 会话代理（N.E.K.O 主进程 :48911）
      "/neko-ws": {
        target: "http://127.0.0.1:48911",
        ws: true,
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/neko-ws/, ""),
      },
    },
  },
  preview: {
    port: 48930,
    strictPort: false,
    // 契约审计 #21：preview 与 dev 同款代理（否则 build+preview 下轮询/WS 全 404）
    proxy: {
      "/neko-memory": {
        target: "http://127.0.0.1:48912",
        changeOrigin: true,
        // 剥前缀：引擎请求 /neko-memory/recent_history/{n}，服务端路由是 /recent_history/{n}
        rewrite: (p: string) => p.replace(/^\/neko-memory/, ""),
      },
      "/neko-ws": {
        target: "http://127.0.0.1:48911",
        ws: true,
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/neko-ws/, ""),
      },
    },
  },
  // 模型不入库：scripts/fetch-model.sh 下载到仓库根 desktop-app-assets/，
  // 这里把它整个作为静态目录，/models/xiaomai/... 与 /textures/... 直接可访问
  publicDir: resolve(here, "../desktop-app-assets"),
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "../core/pet-engine/**/*.test.ts"],
  },
});

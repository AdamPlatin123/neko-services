import { defineConfig } from "vite";
import nekoBackend from "./src/server/plugin.ts";

export default defineConfig({
  plugins: [nekoBackend()],
  // 多页文档流：根跳转页 + 首启海报 + 纸质配置页（npm 脚本的 cwd 即本目录）
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        welcome: "src/pages/welcome/index.html",
        settings: "src/pages/settings/index.html",
      },
    },
  },
  server: {
    port: 48930,
    strictPort: false,
  },
  preview: {
    port: 48930,
    strictPort: false,
  },
});

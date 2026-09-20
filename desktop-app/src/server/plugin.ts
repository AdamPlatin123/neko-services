/**
 * Vite 插件——dev / preview 两个模式都挂上极小中间层。
 * 用法（vite.config.ts）：
 *   import nekoBackend from "./src/server/plugin.ts";
 *   export default defineConfig({ plugins: [nekoBackend()] });
 */
import type { Plugin, ViteDevServer, PreviewServer } from "vite";
import { createApiMiddleware } from "./router.ts";
import type { IncomingMessageLike, ServerResponseLike } from "./router.ts";

export default function nekoBackend(): Plugin {
  const middleware = createApiMiddleware();
  const mount = (server: ViteDevServer | PreviewServer): void => {
    // connect 的 req/res 与 node:http 同源；过一道形状适配
    server.middlewares.use((req, res, next) => {
      void middleware(
        req as unknown as IncomingMessageLike,
        res as unknown as ServerResponseLike,
        next as () => void,
      );
    });
  };
  return {
    name: "neko-backend",
    configureServer(server) {
      mount(server);
    },
    configurePreviewServer(server) {
      mount(server);
    },
  };
}

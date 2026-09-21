/**
 * 生产模式独立启动——静态文件（dist/）+ API 中间层，一个进程带走。
 *
 *   npm run build && npm run serve
 *   NEKO_HOME=~/.config/N.E.K.O PORT=48930 npm run serve
 *
 * 需要 Node ≥ 23（原生 TypeScript 类型剥离，无构建步骤）。
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiMiddleware } from "./router.ts";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, "../..", "dist");
const port = Number(process.env.PORT || process.env.NEKO_DESKTOP_PORT || 48930);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const api = createApiMiddleware();

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (url.startsWith("/api/")) {
    await api(req, res);
    return;
  }

  // 静态文件：dist/ 下按路径取；/welcome、/settings 映射到多页入口
  let rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  if (rel === "welcome" || rel === "settings" || rel === "companion") rel = `src/pages/${rel}/index.html`;
  const target = join(distDir, rel);
  if (!target.startsWith(distDir)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const s = await stat(target);
    const file = s.isFile() ? target : join(target, "index.html");
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": file.endsWith(".html") ? "no-store" : "public, max-age=3600",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("这一页不在纸上。先 npm run build？");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[neko-desktop] 纸已铺好：http://127.0.0.1:${port}/（dist=${distDir}）`);
});

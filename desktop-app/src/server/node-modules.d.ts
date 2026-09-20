/**
 * Node 内置模块的最小环境声明。
 *
 * 约束：package.json 的 devDependencies 只有 vite + typescript（不带
 * @types/node），而 tsc --noEmit 又会连 src/server 一起查。这里给用到的
 * 几个 node: 内置模块手写宽松声明，让类型检查通过；运行时由 Node 真身提供。
 * 接口按 Node ≥ 23 实际行为收窄，够用即可，不追全。
 */

declare const process: {
  env: Record<string, string | undefined>;
  platform: NodeJSPlatform;
};
type NodeJSPlatform = "win32" | "darwin" | "linux" | string;

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
  export function extname(p: string): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:fs/promises" {
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, encoding: "utf-8"): Promise<string>;
  export function writeFile(path: string, data: string, encoding: "utf-8"): Promise<void>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  export function stat(path: string): Promise<{ isFile(): boolean }>;
}

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:url" {
  export function fileURLToPath(u: string): string;
}

declare module "node:http" {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    on(event: string, listener: (...args: any[]) => void): IncomingMessage;
    destroy(): void;
  }
  export interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string | number>): ServerResponse;
    end(chunk?: string | Uint8Array): void;
  }
  export interface Server {
    listen(port: number, host?: string, callback?: () => void): Server;
  }
  export function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
}

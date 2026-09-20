/**
 * 运行环境解析——NEKO_HOME 与各服务的探测地址。
 *
 * NEKO_HOME 的平台默认值照抄 N.E.K.O config/network.py 的 base 目录逻辑：
 *   win32  → %APPDATA%/N.E.K.O
 *   darwin → ~/Library/Application Support/N.E.K.O
 *   other  → $XDG_CONFIG_HOME/N.E.K.O（默认 ~/.config/N.E.K.O）
 * core_config.json 里与桌面配置页相关的只有三把钥匙：
 *   agentModelUrl / agentModelId / agentModelApiKey
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface NekoEnv {
  home: string;
  coreConfigPath: string;
  mainUrl: string;
  agentUrl: string;
  memoryUrl: string;
  qqHealthUrl: string | null;
  wechatHealthUrl: string | null;
}

function platformHome(): string {
  if (process.env.NEKO_HOME) return process.env.NEKO_HOME;
  const platform = process.platform;
  if (platform === "win32") {
    const appdata = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appdata, "N.E.K.O");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "N.E.K.O");
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "N.E.K.O");
}

export function readEnv(): NekoEnv {
  const home = platformHome();
  return {
    home,
    coreConfigPath: join(home, "core_config.json"),
    mainUrl: process.env.NEKO_MAIN_URL || "http://127.0.0.1:48911",
    agentUrl: process.env.NEKO_AGENT_URL || "http://127.0.0.1:48915",
    memoryUrl: process.env.NEKO_MEMORY_URL || "http://127.0.0.1:48921",
    qqHealthUrl: process.env.NEKO_QQ_HEALTH_URL || null,
    wechatHealthUrl: process.env.NEKO_WECHAT_HEALTH_URL || null,
  };
}

/**
 * P1-3 实测用事件抓取插件（非部署件——不进 dist/，仅测试环境装载）。
 * 用途：实抓 opencode 事件流真实载荷（PLAN ⚠#1/#2/#4/#5），日志写 $EVENT_LOG。
 */
import * as fs from "node:fs"

const LOG = process.env.EVENT_LOG ?? "/tmp/opencode-events.log"

function log(...parts: unknown[]): void {
  const line = parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
}

export const EventCapture = async () => {
  log("=== plugin loaded ===")
  return {
    event: async ({ event }: { event: { type: string; properties: unknown } }) => {
      log("EVENT", event.type, event.properties)
    },
    "chat.message": async (input: any, output: any) => {
      log("CHAT.MESSAGE", {
        sessionID: input.sessionID,
        agent: input.agent,
        messageID: input.messageID,
        model: input.model,
        messageInfo: { id: output.message?.id, role: output.message?.role },
      })
    },
    "tool.execute.before": async (input: any) => {
      log("TOOL.BEFORE", input.tool, { sessionID: input.sessionID, callID: input.callID })
    },
    "tool.execute.after": async (input: any, output: any) => {
      log("TOOL.AFTER", input.tool, {
        title: output.title,
        output: String(output.output ?? "").slice(0, 300),
      })
    },
    "experimental.chat.system.transform": async (input: any, output: any) => {
      const parts = output.system ?? []
      const marker = (s: string) => ({
        len: s.length,
        hasMonika: s.includes("莫妮卡") && s.includes("文学社"),
        hasAgentsPlaceholder: s.includes("N.E.K.O opencode 接入层占位"),
        hasClaudeGlobalLeak: s.includes("Always respond in Chinese-simplified") || s.includes("v2rayA"),
        head: s.slice(0, 80).replace(/\n/g, "\\n"),
      })
      log("SYSTEM.PROMPT", {
        sessionID: input.sessionID,
        parts: parts.length,
        totalLen: parts.reduce((a: number, p: string) => a + p.length, 0),
        detail: parts.map(marker),
      })
    },
  }
}

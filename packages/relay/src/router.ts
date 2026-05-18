import type { AgentToRelay } from "@cc-lark/protocol";
import type { Logger } from "pino";
import type { LarkBot } from "./lark-bot.js";
import type { TunnelManager } from "./tunnel.js";

export class Router {
  constructor(
    private readonly larkBot: LarkBot,
    private readonly tunnels: TunnelManager,
    private readonly logger: Logger,
  ) {}

  async handleAgentMessage(agentId: string, raw: string): Promise<void> {
    let msg: AgentToRelay;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.logger.warn({ agentId, raw: raw.slice(0, 100) }, "Invalid JSON from agent");
      return;
    }

    if (msg.type === "pong") return;

    if (msg.type === "auth") {
      return;
    }

    const requestId = "requestId" in msg ? (msg as { requestId: string }).requestId : "";

    try {
      switch (msg.type) {
        case "send_text": {
          const messageId = await this.larkBot.sendText(msg.chatId, msg.text);
          this.tunnels.sendResponse(agentId, { type: "response", requestId, success: true, data: { messageId } });
          break;
        }
        case "send_card": {
          const messageId = await this.larkBot.sendCard(msg.chatId, msg.card);
          this.tunnels.sendResponse(agentId, { type: "response", requestId, success: true, data: { messageId } });
          break;
        }
        case "update_card": {
          await this.larkBot.updateCard(msg.messageId, msg.card);
          this.tunnels.sendResponse(agentId, { type: "response", requestId, success: true });
          break;
        }
        case "send_image": {
          const messageId = await this.larkBot.sendImage(msg.chatId, msg.imageKey);
          this.tunnels.sendResponse(agentId, { type: "response", requestId, success: true, data: { messageId } });
          break;
        }
        case "upload_image": {
          const imageKey = await this.larkBot.uploadImage(msg.imageBase64);
          this.tunnels.sendResponse(agentId, { type: "response", requestId, success: true, data: { imageKey } });
          break;
        }
        case "download_image": {
          const imageBase64 = await this.larkBot.downloadImage(msg.messageId, msg.imageKey);
          this.tunnels.sendResponse(agentId, { type: "response", requestId, success: true, data: { imageBase64 } });
          break;
        }
        default:
          this.logger.warn({ agentId, type: (msg as { type: string }).type }, "Unknown message type from agent");
      }
    } catch (err) {
      this.logger.error({ err, agentId, type: msg.type }, "Error handling agent request");
      if (requestId) {
        this.tunnels.sendResponse(agentId, { type: "response", requestId, success: false, error: (err as Error).message });
      }
    }
  }
}

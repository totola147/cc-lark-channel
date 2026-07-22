import type { RelayToAgent, AgentToRelay, RelayResponse } from "@cc-lark/protocol";
import type { WebSocket } from "ws";
import type { Logger } from "pino";

export interface AgentTunnel {
  ws: WebSocket;
  userId: string;
  agentId: string;
  connectedAt: Date;
}

export class TunnelManager {
  private readonly tunnels = new Map<string, AgentTunnel>();
  /** Most-recent agent per user — fallback route for DMs / unclaimed chats. */
  private readonly userToAgent = new Map<string, string>();
  /** Chat ownership: which agent serves a given group chat. */
  private readonly chatToAgent = new Map<string, string>();

  constructor(private readonly logger: Logger) {}

  register(agentId: string, userId: string, ws: WebSocket): void {
    const existing = this.tunnels.get(agentId);
    if (existing) {
      this.logger.info({ agentId }, "Replacing existing tunnel");
      existing.ws.close();
    }
    this.tunnels.set(agentId, { ws, userId, agentId, connectedAt: new Date() });
    // Track most-recent agent for this user (DM/unclaimed fallback). With
    // distinct agentIds, multiple agents for one user now coexist; only the
    // fallback pointer is last-wins, not the tunnels themselves.
    this.userToAgent.set(userId, agentId);
    this.logger.info({ agentId, userId }, "Tunnel registered");
  }

  remove(agentId: string): void {
    const tunnel = this.tunnels.get(agentId);
    if (tunnel) {
      // Only clear the user fallback if it still points at this agent.
      if (this.userToAgent.get(tunnel.userId) === agentId) {
        this.userToAgent.delete(tunnel.userId);
      }
      // Drop chat ownership held by this agent so stale routes don't linger.
      for (const [chatId, owner] of this.chatToAgent) {
        if (owner === agentId) this.chatToAgent.delete(chatId);
      }
      this.tunnels.delete(agentId);
      this.logger.info({ agentId }, "Tunnel removed");
    }
  }

  /** Record that `agentId` owns `chatId` (from create_group / claim_chats). */
  claimChat(agentId: string, chatId: string): void {
    if (!chatId) return;
    const prev = this.chatToAgent.get(chatId);
    this.chatToAgent.set(chatId, agentId);
    if (prev && prev !== agentId) {
      this.logger.info({ chatId, prev, agentId }, "Chat ownership reassigned");
    }
  }

  /**
   * Resolve the agent that should receive a message in `chatId` sent by
   * `senderOpenId`. Prefer the live chat owner; fall back to the user's
   * most-recent agent (DMs, or chats claimed before a relay restart).
   */
  resolveAgentForChat(chatId: string, senderOpenId: string): { tunnel: AgentTunnel; via: "chat" | "user" } | undefined {
    const ownerId = this.chatToAgent.get(chatId);
    if (ownerId) {
      const owner = this.tunnels.get(ownerId);
      if (owner && owner.ws.readyState === 1) return { tunnel: owner, via: "chat" };
    }
    const fallback = this.getByUserId(senderOpenId);
    if (fallback) return { tunnel: fallback, via: "user" };
    return undefined;
  }

  getByChatId(chatId: string): AgentTunnel | undefined {
    const agentId = this.chatToAgent.get(chatId);
    if (!agentId) return undefined;
    return this.tunnels.get(agentId);
  }

  getByUserId(userId: string): AgentTunnel | undefined {
    const agentId = this.userToAgent.get(userId);
    if (!agentId) return undefined;
    return this.tunnels.get(agentId);
  }

  getByAgentId(agentId: string): AgentTunnel | undefined {
    return this.tunnels.get(agentId);
  }

  send(agentId: string, msg: RelayToAgent): boolean {
    const tunnel = this.tunnels.get(agentId);
    if (!tunnel || tunnel.ws.readyState !== 1) return false;
    tunnel.ws.send(JSON.stringify(msg));
    return true;
  }

  sendResponse(agentId: string, res: RelayResponse): boolean {
    const tunnel = this.tunnels.get(agentId);
    if (!tunnel || tunnel.ws.readyState !== 1) return false;
    tunnel.ws.send(JSON.stringify(res));
    return true;
  }

  sendToUser(userId: string, msg: RelayToAgent): boolean {
    const agentId = this.userToAgent.get(userId);
    if (!agentId) return false;
    return this.send(agentId, msg);
  }

  isUserOnline(userId: string): boolean {
    const agentId = this.userToAgent.get(userId);
    if (!agentId) return false;
    const tunnel = this.tunnels.get(agentId);
    return !!tunnel && tunnel.ws.readyState === 1;
  }

  getAllTunnels(): AgentTunnel[] {
    return [...this.tunnels.values()];
  }
}

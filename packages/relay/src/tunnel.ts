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
  private readonly userToAgent = new Map<string, string>();

  constructor(private readonly logger: Logger) {}

  register(agentId: string, userId: string, ws: WebSocket): void {
    const existing = this.tunnels.get(agentId);
    if (existing) {
      this.logger.info({ agentId }, "Replacing existing tunnel");
      existing.ws.close();
    }
    this.tunnels.set(agentId, { ws, userId, agentId, connectedAt: new Date() });
    this.userToAgent.set(userId, agentId);
    this.logger.info({ agentId, userId }, "Tunnel registered");
  }

  remove(agentId: string): void {
    const tunnel = this.tunnels.get(agentId);
    if (tunnel) {
      this.userToAgent.delete(tunnel.userId);
      this.tunnels.delete(agentId);
      this.logger.info({ agentId }, "Tunnel removed");
    }
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
